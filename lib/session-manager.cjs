'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const pty = require('node-pty')
const { buildSshCommand } = require('./ssh-args.cjs')

const MAX_WRITE_SIZE = 64 * 1024
const FORCE_CLOSE_DELAY_MS = 1500
const POST_KILL_EXIT_TIMEOUT_MS = 1500

function validateOwnerId (ownerId) {
  if (!Number.isInteger(ownerId) || ownerId < 1) throw new TypeError('owner id is invalid')
}

function validateSessionId (sessionId) {
  if (typeof sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(sessionId)) {
    throw new TypeError('session id is invalid')
  }
}

function validateTerminalSize (cols, rows) {
  if (!Number.isInteger(cols) || cols < 2 || cols > 500) {
    throw new TypeError('terminal columns are invalid')
  }
  if (!Number.isInteger(rows) || rows < 1 || rows > 300) {
    throw new TypeError('terminal rows are invalid')
  }
}

function safeLocale (value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.@-]{1,64}$/u.test(value)
    ? value
    : 'en_US.UTF-8'
}

/**
 * Owns native SSH PTYs and enforces that only the renderer which opened a
 * session can write, resize, or close it.
 */
class SessionManager {
  constructor ({ knownHostsPath, spawn = pty.spawn, environment = process.env }) {
    if (typeof knownHostsPath !== 'string' || !path.isAbsolute(knownHostsPath)) {
      throw new TypeError('known hosts path must be absolute')
    }
    this.knownHostsPath = path.normalize(knownHostsPath)
    this.spawn = spawn
    this.environment = environment
    this.sessions = new Map()
    this.shutdownWaiters = new Set()
    this.shuttingDown = false
  }

  /** Creates the app-owned known-hosts file with owner-only permissions. */
  async init () {
    await fs.mkdir(path.dirname(this.knownHostsPath), { recursive: true, mode: 0o700 })
    const handle = await fs.open(this.knownHostsPath, 'a', 0o600)
    await handle.close()
    // OpenSSH may create files using the process umask; chmod repairs existing files too.
    await fs.chmod(this.knownHostsPath, 0o600)
  }

  /** Starts one native OpenSSH process without a shell or inherited broad env. */
  start (ownerId, profile, emit) {
    validateOwnerId(ownerId)
    if (typeof emit !== 'function') throw new TypeError('emit must be a function')
    if (this.shuttingDown) throw new Error('session manager is shutting down')

    // Stored records also contain id/timestamps. Copy only connection fields
    // so persistence metadata and any future field cannot cross into ssh argv.
    const connectionProfile = {
      name: profile.name,
      host: profile.host,
      port: profile.port,
      username: profile.username,
      auth: profile.auth,
      privateKeyPath: profile.privateKeyPath
    }
    const command = buildSshCommand(connectionProfile, { knownHostsPath: this.knownHostsPath })
    const sessionId = randomUUID()
    const environment = this.buildEnvironment(command.profile)

    // node-pty receives the executable and argv separately; this is the critical
    // boundary that prevents profile text from becoming shell syntax.
    const processHandle = this.spawn(command.file, command.args, {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: '/',
      env: environment
    })
    const record = {
      id: sessionId,
      ownerId,
      processHandle,
      emit,
      closing: false,
      forceCloseTimer: null,
      dataDisposable: null,
      exitDisposable: null
    }
    this.sessions.set(sessionId, record)

    record.dataDisposable = processHandle.onData(data => {
      record.emit({ type: 'data', sessionId, data })
    })
    record.exitDisposable = processHandle.onExit(event => {
      this.finalize(record)
      record.emit({
        type: 'exit',
        sessionId,
        exitCode: Number.isInteger(event.exitCode) ? event.exitCode : null,
        signal: Number.isInteger(event.signal) ? event.signal : null
      })
    })
    emit({ type: 'status', sessionId, status: 'running' })
    return { sessionId, status: 'running' }
  }

  /** Writes bounded terminal data after checking session ownership. */
  write (ownerId, sessionId, data) {
    const record = this.requireOwned(ownerId, sessionId)
    if (typeof data !== 'string' || Buffer.byteLength(data, 'utf8') > MAX_WRITE_SIZE) {
      throw new TypeError('terminal input is invalid or too large')
    }
    record.processHandle.write(data)
  }

  /** Resizes an owned PTY within sane resource bounds. */
  resize (ownerId, sessionId, cols, rows) {
    const record = this.requireOwned(ownerId, sessionId)
    validateTerminalSize(cols, rows)
    record.processHandle.resize(cols, rows)
  }

  /** Requests graceful termination and escalates if the native process lingers. */
  close (ownerId, sessionId) {
    const record = this.requireOwned(ownerId, sessionId)
    this.stop(record)
    return true
  }

  /** Cleans up every PTY created by a renderer that has gone away. */
  closeOwner (ownerId) {
    validateOwnerId(ownerId)
    for (const record of this.sessions.values()) {
      if (record.ownerId === ownerId) this.stop(record)
    }
  }

  /** Cleans up all native children during application shutdown. */
  closeAll () {
    for (const record of this.sessions.values()) this.stop(record)
  }

  /** Stops every PTY and resolves after all exits or a bounded post-SIGKILL wait. */
  closeAllAndWait (postKillTimeoutMs = POST_KILL_EXIT_TIMEOUT_MS) {
    if (!Number.isInteger(postKillTimeoutMs) || postKillTimeoutMs < 0) {
      throw new TypeError('shutdown timeout is invalid')
    }

    // Reject future non-renderer callers before taking the shutdown snapshot;
    // Electron starts this phase only after all interactive windows are gone.
    this.shuttingDown = true
    this.closeAll()
    if (this.sessions.size === 0) return Promise.resolve(true)

    return new Promise(resolve => {
      const waiter = () => {
        clearTimeout(timeout)
        resolve(true)
      }
      // The deadline starts after the existing grace period so SIGKILL always runs first.
      const timeout = setTimeout(() => {
        this.shutdownWaiters.delete(waiter)
        resolve(false)
      }, FORCE_CLOSE_DELAY_MS + postKillTimeoutMs)
      this.shutdownWaiters.add(waiter)
    })
  }

  buildEnvironment (profile) {
    const environment = {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      TERM: 'xterm-256color',
      LANG: safeLocale(this.environment.LANG)
    }

    if (profile.auth === 'agent') {
      const socketPath = this.environment.SSH_AUTH_SOCK
      const containsUnsafeCharacter = typeof socketPath === 'string' && [...socketPath].some(character => {
        const codePoint = character.codePointAt(0)
        return codePoint === 0 || codePoint === 10 || codePoint === 13
      })
      if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath) || containsUnsafeCharacter) {
        throw new Error('SSH agent is unavailable; choose a private key instead')
      }
      environment.SSH_AUTH_SOCK = socketPath
    }
    return environment
  }

  requireOwned (ownerId, sessionId) {
    validateOwnerId(ownerId)
    validateSessionId(sessionId)
    const record = this.sessions.get(sessionId)
    if (!record || record.ownerId !== ownerId) throw new Error('session not found')
    return record
  }

  stop (record) {
    if (record.closing) return
    record.closing = true
    try {
      record.processHandle.kill('SIGTERM')
    } catch {
      this.finalize(record)
      return
    }

    // A short SIGKILL fallback prevents orphaned SSH children after window loss.
    record.forceCloseTimer = setTimeout(() => {
      if (!this.sessions.has(record.id)) return
      try {
        record.processHandle.kill('SIGKILL')
      } catch {
        this.finalize(record)
      }
    }, FORCE_CLOSE_DELAY_MS)
    record.forceCloseTimer.unref?.()
  }

  /** Releases one PTY record and wakes shutdown waiters after the final child exits. */
  finalize (record) {
    if (record.forceCloseTimer) clearTimeout(record.forceCloseTimer)
    record.dataDisposable?.dispose?.()
    record.exitDisposable?.dispose?.()
    if (this.sessions.get(record.id) === record) this.sessions.delete(record.id)
    if (this.sessions.size === 0) {
      const waiters = [...this.shutdownWaiters]
      this.shutdownWaiters.clear()
      for (const resolve of waiters) resolve()
    }
  }
}

module.exports = { MAX_WRITE_SIZE, SessionManager }
