'use strict'

const fs = require('node:fs/promises')
const { createReadStream } = require('node:fs')
const { pipeline } = require('node:stream/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { Client, utils } = require('@electerm/ssh2')
const { setTimeout: delay } = require('node:timers/promises')
const { isTransientConnectionError } = require('./connection-retry.cjs')
const { checkKnownHost, trustKnownHost } = require('./known-hosts.cjs')
const { normalizeProfileInput } = require('./ssh-args.cjs')

const MAX_KEY_SIZE = 1024 * 1024
const MAX_SECRET_SIZE = 4096
const MAX_DIRECTORY_ENTRIES = 10000

function validateOwnerId (ownerId) {
  if (!Number.isInteger(ownerId) || ownerId < 1) throw new TypeError('owner id is invalid')
}

function validateConnectionId (connectionId) {
  if (typeof connectionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(connectionId)) {
    throw new TypeError('SFTP connection id is invalid')
  }
}

function containsControlCharacter (value) {
  return [...value].some(character => {
    const codePoint = character.codePointAt(0)
    return codePoint <= 31 || codePoint === 127
  })
}

/** Normalizes only absolute POSIX paths before they cross the SFTP boundary. */
function validateRemotePath (value) {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    Buffer.byteLength(value, 'utf8') > 4096 ||
    containsControlCharacter(value)
  ) {
    throw new TypeError('remote path must be an absolute POSIX path')
  }
  return path.posix.normalize(value)
}

function validateRemoteName (value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    Buffer.byteLength(value, 'utf8') > 255 ||
    containsControlCharacter(value)
  ) {
    throw new TypeError('remote name is invalid')
  }
  return value
}

function validateLocalPath (value) {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    Buffer.byteLength(value, 'utf8') > 4096 ||
    containsControlCharacter(value)
  ) {
    throw new TypeError('local path must be absolute')
  }
  return path.normalize(value)
}

function validateSecret (profile, secret) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') > MAX_SECRET_SIZE) {
    throw new TypeError('temporary credential is invalid')
  }
  if (profile.auth === 'password' && !secret) throw new TypeError('password is required')
  if (profile.auth === 'agent' && secret) throw new TypeError('agent mode does not accept a secret')
  return secret
}

function callSftp (sftp, method, ...args) {
  return new Promise((resolve, reject) => {
    sftp[method](...args, (error, result) => error ? reject(error) : resolve(result))
  })
}

function remoteTimestamp (seconds) {
  if (!Number.isFinite(seconds)) return null
  const date = new Date(seconds * 1000)
  return Number.isNaN(date.valueOf()) ? null : date.toISOString()
}

function isMissingRemotePath (error) {
  return error?.code === 2 || error?.code === 'ENOENT'
}

/** 流式写入独占临时文件，传完再发布；保留同名目标，失败只清理本次临时文件。 */
async function writeRemoteFile (sftp, destinationPath, createSource, onProgress = () => {}) {
  try {
    await callSftp(sftp, 'lstat', destinationPath)
    throw new Error('目标已有同名项目，请先重命名后再传输')
  } catch (error) {
    if (!isMissingRemotePath(error)) throw error
  }
  const temporaryPath = path.posix.join(path.posix.dirname(destinationPath), `.serverlink-${randomUUID()}.part`)
  const destination = sftp.createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 })
  let created = false
  destination.once('open', () => { created = true })
  // ssh2 的 bytesWritten 只在远端 WRITE 回执成功后增长；定时采样避免把读取缓存算成已上传。
  const report = () => onProgress(destination.bytesWritten || 0, 'uploading')
  const timer = setInterval(report, 100)
  timer.unref?.()
  try {
    // pipeline 自动施加背压，大文件不会整体载入内存或留存在本地磁盘。
    await pipeline(createSource(), destination)
    clearInterval(timer)
    onProgress(destination.bytesWritten || 0, 'finalizing')
    // 使用 SFTP 标准 rename（非覆盖扩展），保留传输期间新出现的同名文件。
    await callSftp(sftp, 'rename', temporaryPath, destinationPath)
  } catch (error) {
    if (created) await callSftp(sftp, 'unlink', temporaryPath).catch(() => {})
    throw error
  } finally {
    clearInterval(timer)
  }
}

/**
 * Owns SSH2/SFTP clients and limits every operation to the renderer that
 * created the connection. Local paths originate from native dialogs or genuine dropped Files.
 */
class SftpManager {
  constructor ({ knownHostsPath, confirmHost, environment = process.env, createClient = () => new Client() }) {
    if (typeof knownHostsPath !== 'string' || !path.isAbsolute(knownHostsPath)) {
      throw new TypeError('known hosts path must be absolute')
    }
    if (typeof confirmHost !== 'function') throw new TypeError('confirmHost must be a function')
    this.knownHostsPath = path.normalize(knownHostsPath)
    this.confirmHost = confirmHost
    this.environment = environment
    this.createClient = createClient
    this.connections = new Map()
    this.pendingConnections = new Set()
    this.shuttingDown = false
  }

  /** 临时网络失败最多重试两次；凭据只保留在本次调用中，窗口关闭会取消退避和连接。 */
  async connect (ownerId, storedProfile, secret = '') {
    validateOwnerId(ownerId)
    if (this.shuttingDown) throw new Error('SFTP manager is shutting down')
    const operation = { ownerId, profileId: storedProfile.id, controller: new AbortController() }
    this.pendingConnections.add(operation)
    const { signal } = operation.controller
    try {
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted()
        try {
          return await this.connectOnce(ownerId, storedProfile, secret, signal)
        } catch (error) {
          if (signal.aborted || attempt >= 2 || !isTransientConnectionError(error)) throw error
          // 失败连接已释放，退避 1/2 秒后才建立下一条，避免拥塞时立即打满服务器。
          await delay(1000 * (attempt + 1), undefined, { signal })
        }
      }
    } finally {
      secret = ''
      this.pendingConnections.delete(operation)
    }
  }

  /** 单次握手严格验证主机；仅检测到加密私钥时返回口令需求，不把密钥传给界面。 */
  async connectOnce (ownerId, storedProfile, secret, signal) {
    const profile = normalizeProfileInput({
      name: storedProfile.name,
      host: storedProfile.host,
      port: storedProfile.port,
      username: storedProfile.username,
      auth: storedProfile.auth,
      privateKeyPath: storedProfile.privateKeyPath
    })
    validateSecret(profile, secret)

    const connectionId = randomUUID()
    const client = this.createClient()
    const record = { id: connectionId, ownerId, client, sftp: null, closing: false, verifierError: null }
    const abort = () => this.closeRecord(record)
    signal.addEventListener('abort', abort, { once: true })
    let keyboardHandler = null
    this.connections.set(connectionId, record)

    const options = {
      host: profile.host,
      port: profile.port,
      username: profile.username,
      readyTimeout: 15000,
      keepaliveInterval: 30000,
      keepaliveCountMax: 3,
      agentForward: false,
      hostVerifier: (hostKey, verify) => {
        // Host verification stays asynchronous so the native confirmation can
        // finish without ever accepting an unknown or changed key by default.
        this.verifyHost(ownerId, profile, hostKey).then(verify, error => {
          record.verifierError = error
          verify(false)
        })
      }
    }
    const clearCredentialReferences = () => {
      options.password = undefined
      options.passphrase = undefined
      if (client.config) client.config.password = undefined
      if (keyboardHandler) client.removeListener('keyboard-interactive', keyboardHandler)
      secret = ''
    }

    try {
      if (profile.auth === 'password') {
        options.password = secret
        options.tryKeyboard = true
        keyboardHandler = (_name, _instructions, _language, prompts, finish) => {
          // Some sshd configurations expose password login through
          // keyboard-interactive only; answer every password prompt ephemerally.
          finish(prompts.map(() => secret))
        }
        client.on('keyboard-interactive', keyboardHandler)
      } else if (profile.auth === 'key') {
        const keyPath = validateLocalPath(profile.privateKeyPath)
        const stat = await fs.lstat(keyPath)
        if (!stat.isFile() || stat.size > MAX_KEY_SIZE) throw new Error('private key file is invalid or too large')
        // Read the configured key only inside the privileged process; its bytes
        // never cross IPC or enter persistence, logs, argv, or environment state.
        options.privateKey = await fs.readFile(keyPath)
        const parsedKey = utils.parseKey(options.privateKey, secret || undefined)
        if (parsedKey instanceof Error) {
          if (!secret && /encrypted.*no passphrase given/iu.test(parsedKey.message)) {
            this.closeRecord(record)
            return { needsSecret: true }
          }
          throw parsedKey
        }
        if (secret) options.passphrase = secret
      } else {
        const socketPath = this.environment.SSH_AUTH_SOCK
        if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath) || containsControlCharacter(socketPath)) {
          throw new Error('SSH agent is unavailable; choose a private key instead')
        }
        options.agent = socketPath
      }
      signal.throwIfAborted()
      if (!this.connections.has(connectionId)) throw new Error('SFTP connection was closed by user')

      await new Promise((resolve, reject) => {
        let settled = false
        const settle = (callback, value) => {
          if (settled) return
          settled = true
          callback(value)
        }
        record.cancelConnect = () => settle(reject, new Error('SFTP connection was closed by user'))
        client.once('ready', () => {
          record.authenticated = true
          // Authentication has finished; drop the password references before
          // opening the long-lived file channel so they do not remain for the session.
          clearCredentialReferences()
          if (!this.connections.has(connectionId)) return settle(reject, new Error('SFTP connection was closed'))
          client.sftp((error, sftp) => {
            if (error) return settle(reject, error)
            record.sftp = sftp
            settle(resolve)
          })
        })
        client.once('error', error => settle(reject, record.verifierError ?? error))
        client.once('close', () => {
          this.connections.delete(connectionId)
          settle(reject, record.verifierError ?? new Error('SFTP connection closed'))
        })
        // The client consumes the secret only for this handshake; ServerLink
        // does not retain the options object on the connection record.
        client.connect(options)
      })

      const homePath = validateRemotePath(await callSftp(record.sftp, 'realpath', '.'))
      return { connectionId, ...(await this.list(ownerId, connectionId, homePath)) }
    } catch (error) {
      clearCredentialReferences()
      this.closeRecord(record)
      // 认证后打开通道或读目录失败交给用户处理，不再自动重建已认证连接。
      if (record.authenticated || record.verifierError) error.retryable = false
      throw record.verifierError ?? error
    } finally {
      clearCredentialReferences()
      signal.removeEventListener('abort', abort)
      record.cancelConnect = null
    }
  }

  /** Enforces TOFU for unknown keys while changed or revoked keys fail closed. */
  async verifyHost (ownerId, profile, hostKey) {
    const result = await checkKnownHost({
      knownHostsPath: this.knownHostsPath,
      host: profile.host,
      port: profile.port,
      hostKey
    })
    if (result.status === 'match') return true
    if (result.status === 'mismatch' || result.status === 'revoked') {
      throw new Error(`SSH host key verification failed: ${result.fingerprint} does not match the saved key`)
    }

    const accepted = await this.confirmHost(ownerId, {
      host: profile.host,
      port: profile.port,
      keyType: result.keyType,
      fingerprint: result.fingerprint
    })
    if (!accepted) throw new Error('SSH host key was not trusted')
    // Persist trust before authentication continues so every later connection
    // must verify against the same app-owned record.
    await trustKnownHost({
      knownHostsPath: this.knownHostsPath,
      host: profile.host,
      port: profile.port,
      hostKey
    })
    return true
  }

  /** Lists one owned absolute remote directory with a bounded result size. */
  async list (ownerId, connectionId, remotePath) {
    const record = this.requireOwned(ownerId, connectionId)
    const normalizedPath = validateRemotePath(remotePath)
    const entries = await callSftp(record.sftp, 'readdir', normalizedPath)
    if (!Array.isArray(entries) || entries.length > MAX_DIRECTORY_ENTRIES) {
      throw new Error('remote directory is too large')
    }
    const normalizedEntries = entries
      .filter(entry => entry && entry.filename !== '.' && entry.filename !== '..')
      .map(entry => ({
        // Reject server-supplied separators or traversal names before the UI
        // can compose them into a different absolute operation target.
        name: validateRemoteName(String(entry.filename)),
        type: entry.attrs?.isDirectory?.()
          ? 'directory'
          : entry.attrs?.isSymbolicLink?.() ? 'symlink' : 'file',
        size: Number.isSafeInteger(entry.attrs?.size) && entry.attrs.size >= 0 ? entry.attrs.size : null,
        modifiedAt: remoteTimestamp(entry.attrs?.mtime)
      }))
      .sort((left, right) => (
        Number(right.type === 'directory') - Number(left.type === 'directory') ||
        left.name.localeCompare(right.name)
      ))
    return { path: normalizedPath, entries: normalizedEntries }
  }

  /** Uploads a native-dialog or dropped-File source into one remote directory. */
  async upload (ownerId, connectionId, remoteDirectory, localPath, onProgress = () => {}) {
    const record = this.requireOwned(ownerId, connectionId)
    const sourcePath = validateLocalPath(localPath)
    const stat = await fs.lstat(sourcePath)
    if (!stat.isFile()) throw new Error('only regular files can be uploaded')
    const remotePath = path.posix.join(
      validateRemotePath(remoteDirectory),
      validateRemoteName(path.basename(sourcePath))
    )
    const transferId = randomUUID()
    const startedAt = Date.now()
    let transferred = 0
    const report = (bytes, phase) => {
      transferred = Math.min(stat.size, Math.max(transferred, bytes))
      onProgress({ connectionId, transferId, name: path.basename(sourcePath), total: stat.size, transferred, phase, bytesPerSecond: transferred * 1000 / Math.max(1, Date.now() - startedAt) })
    }
    // 对话框、令牌多选和真实拖放共用进度及同名保护；rename 成功才通知完成。
    report(0, 'uploading')
    try {
      await writeRemoteFile(record.sftp, remotePath, () => createReadStream(sourcePath), report)
      report(stat.size, 'completed')
    } catch (error) {
      report(transferred, 'failed')
      throw error
    }
    return { name: path.basename(sourcePath), path: remotePath }
  }

  /** 校验两个连接的归属后，通过客户端内存流在服务器之间复制普通文件。 */
  async copyBetween (ownerId, sourceId, sourcePath, destinationId, destinationDirectory) {
    const source = this.requireOwned(ownerId, sourceId)
    const destination = this.requireOwned(ownerId, destinationId)
    const remoteSource = validateRemotePath(sourcePath)
    const remoteDestination = path.posix.join(validateRemotePath(destinationDirectory), validateRemoteName(path.posix.basename(remoteSource)))
    const attrs = await callSftp(source.sftp, 'lstat', remoteSource)
    if (!attrs.isFile()) throw new Error('跨服务器复制目前支持普通文件，请将目录打包后传输')
    await writeRemoteFile(destination.sftp, remoteDestination, () => source.sftp.createReadStream(remoteSource))
    return { name: path.posix.basename(remoteSource), path: remoteDestination }
  }

  /** Downloads one validated remote file to the path selected by the main process. */
  async download (ownerId, connectionId, remotePath, localPath) {
    const record = this.requireOwned(ownerId, connectionId)
    const sourcePath = validateRemotePath(remotePath)
    const destinationPath = validateLocalPath(localPath)
    const temporaryPath = `${destinationPath}.serverlink-${randomUUID()}.part`
    try {
      await callSftp(record.sftp, 'fastGet', sourcePath, temporaryPath)
      // Replace the chosen destination only after a complete transfer, so a
      // network failure cannot truncate a file the user elected to overwrite.
      await fs.rename(temporaryPath, destinationPath)
    } catch (error) {
      await fs.unlink(temporaryPath).catch(() => {})
      throw error
    }
    return { path: sourcePath }
  }

  /** Creates one direct child directory without accepting path separators in its name. */
  async mkdir (ownerId, connectionId, parentPath, name) {
    const record = this.requireOwned(ownerId, connectionId)
    const remotePath = path.posix.join(validateRemotePath(parentPath), validateRemoteName(name))
    await callSftp(record.sftp, 'mkdir', remotePath)
    return { path: remotePath }
  }

  /** Removes a file/symlink or an empty directory after main-process confirmation. */
  async remove (ownerId, connectionId, remotePath) {
    const record = this.requireOwned(ownerId, connectionId)
    const normalizedPath = validateRemotePath(remotePath)
    if (normalizedPath === '/') throw new Error('remote root cannot be removed')
    const attrs = await callSftp(record.sftp, 'lstat', normalizedPath)
    await callSftp(record.sftp, attrs.isDirectory() ? 'rmdir' : 'unlink', normalizedPath)
    return true
  }

  /** Confirms ownership before a main-process file or confirmation dialog is shown. */
  assertOwned (ownerId, connectionId) {
    this.requireOwned(ownerId, connectionId)
    return true
  }

  /** Closes one SFTP client owned by the requesting renderer. */
  close (ownerId, connectionId) {
    const record = this.requireOwned(ownerId, connectionId)
    this.closeRecord(record)
    return true
  }

  /** 只取消当前窗口指定配置的未完成握手；不会关闭该配置已成功建立的会话。 */
  cancelConnect (ownerId, profileId) {
    validateOwnerId(ownerId)
    if (typeof profileId !== 'string') throw new TypeError('profile id is invalid')
    for (const operation of this.pendingConnections) {
      if (operation.ownerId === ownerId && operation.profileId === profileId) operation.controller.abort()
    }
  }

  /** Closes every SFTP client whose renderer has gone away. */
  closeOwner (ownerId) {
    validateOwnerId(ownerId)
    for (const operation of this.pendingConnections) {
      if (operation.ownerId === ownerId) operation.controller.abort()
    }
    for (const record of this.connections.values()) {
      if (record.ownerId === ownerId) this.closeRecord(record)
    }
  }

  /** Rejects future connections and closes all clients during application shutdown. */
  closeAll () {
    this.shuttingDown = true
    for (const operation of this.pendingConnections) operation.controller.abort()
    for (const record of [...this.connections.values()]) this.closeRecord(record)
  }

  /** Returns an initialized record only when the invoking renderer owns it. */
  requireOwned (ownerId, connectionId) {
    validateOwnerId(ownerId)
    validateConnectionId(connectionId)
    const record = this.connections.get(connectionId)
    if (!record || record.ownerId !== ownerId || !record.sftp) throw new Error('SFTP connection not found')
    return record
  }

  /** Removes ownership first, then asks both SFTP and SSH layers to shut down. */
  closeRecord (record) {
    if (record.closing) return
    record.closing = true
    record.cancelConnect?.()
    this.connections.delete(record.id)
    try { record.sftp?.end?.() } catch {}
    try { record.client.end() } catch { record.client.destroy?.() }
  }
}

module.exports = {
  MAX_DIRECTORY_ENTRIES,
  SftpManager,
  validateRemoteName,
  validateRemotePath
}
