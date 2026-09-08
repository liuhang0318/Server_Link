'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { setTimeout: delay } = require('node:timers/promises')
const { utils } = require('@electerm/ssh2')
const { isTransientConnectionError } = require('../lib/connection-retry.cjs')
const { SftpManager } = require('../lib/sftp-manager.cjs')
const { SessionManager } = require('../lib/session-manager.cjs')

const profile = { name: 'Fixture', host: 'example.com', port: 22, username: 'root', auth: 'password', privateKeyPath: null }

/** 全部网络层均为内存桩，不读取用户配置、不访问任何真实服务器。 */
function sftpHarness (outcomes) {
  const clients = []
  const manager = new SftpManager({
    knownHostsPath: '/tmp/serverlink-retry-unused',
    confirmHost: async () => false,
    createClient: () => {
      const client = new EventEmitter()
      clients.push(client)
      client.end = () => { client.ended = true; client.emit('close') }
      client.connect = options => {
        client.options = options
        const outcome = outcomes.shift()
        queueMicrotask(() => client.emit(outcome ? 'error' : 'ready', outcome))
      }
      client.sftp = callback => callback(null, {
        realpath: (_path, done) => done(null, '/'),
        readdir: (_path, done) => done(null, [])
      })
      return client
    }
  })
  return { manager, clients }
}

test('retry allowlist rejects authentication, trust, cancellation and permanent errors', () => {
  for (const message of ['Connection reset by peer', 'Connection refused', 'Operation timed out', 'Timed out while waiting for handshake']) assert.equal(isTransientConnectionError(new Error(message)), true)
  for (const message of ['Permission denied', 'All configured authentication methods failed', 'Host key verification failed: Connection reset', 'REMOTE HOST IDENTIFICATION HAS CHANGED!', 'SSH host key was not trusted', 'Encrypted private key: no passphrase', 'SFTP connection was closed by user', 'getaddrinfo ENOTFOUND', 'Invalid key format']) assert.equal(isTransientConnectionError(new Error(message)), false)
})

test('SFTP retries transient failures twice, cleans old clients and stops at exhaustion', async () => {
  const transient = () => Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' })
  const success = sftpHarness([transient(), null])
  const result = await success.manager.connect(1, profile, 'fixture-password')
  assert.ok(result.connectionId)
  assert.equal(success.clients.length, 2)
  assert.equal(success.clients[0].ended, true)
  assert.equal(success.clients[1].options.password, undefined)
  success.manager.closeAll()
  const failure = sftpHarness([transient(), transient(), transient()])
  await assert.rejects(failure.manager.connect(1, profile, 'fixture-password'), /reset/u)
  assert.equal(failure.clients.length, 3)
  assert.equal(failure.manager.connections.size, 0)
  assert.equal(failure.manager.pendingConnections.size, 0)
})

test('SFTP never retries credentials/trust failures and owner loss cancels backoff', async () => {
  for (const message of ['All configured authentication methods failed', 'SSH host key verification failed', 'SSH host key was not trusted']) {
    const harness = sftpHarness([new Error(message)])
    await assert.rejects(harness.manager.connect(1, profile, 'fixture-password'))
    assert.equal(harness.clients.length, 1)
  }
  for (const shutdown of [false, true]) {
    const harness = sftpHarness([new Error('Connection reset')])
    const pending = harness.manager.connect(1, profile, 'fixture-password')
    const rejected = assert.rejects(pending)
    await delay(20)
    if (shutdown) harness.manager.closeAll()
    else harness.manager.closeOwner(1)
    await rejected
    assert.equal(harness.clients.length, 1)
    assert.equal(harness.manager.pendingConnections.size, 0)
  }
})

test('SFTP only requests a secret for an encrypted key; bad passphrases do not start network', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'serverlink-key-prompt-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  for (const encrypted of [false, true]) {
    const privateKeyPath = path.join(directory, encrypted ? 'encrypted' : 'plain')
    const key = utils.generateKeyPairSync('ed25519', encrypted ? { passphrase: 'fixture-passphrase', cipher: 'aes256-cbc' } : {})
    await fs.writeFile(privateKeyPath, key.private, { mode: 0o600 })
    const harness = sftpHarness([])
    const keyProfile = { ...profile, auth: 'key', privateKeyPath }
    const result = await harness.manager.connect(1, keyProfile)
    assert.equal(Boolean(result.needsSecret), encrypted)
    if (encrypted) {
      assert.equal(harness.clients[0].options, undefined)
      assert.equal(harness.manager.connections.size, 0)
      await assert.rejects(harness.manager.connect(1, keyProfile, 'wrong-passphrase'))
      assert.equal(harness.clients[1].options, undefined)
      assert.ok((await harness.manager.connect(1, keyProfile, 'fixture-passphrase')).connectionId)
    } else assert.ok(result.connectionId)
    harness.manager.closeAll()
  }
})

test('batch starts four tasks before waiting and preserves selection order', async () => {
  const { connectBatch } = await import('../src/connection-batch.mjs')
  let active = 0
  let peak = 0
  const items = Array.from({ length: 10 }, (_, i) => i)
  const results = await connectBatch(items, async i => {
    active++
    peak = Math.max(peak, active)
    await delay(i % 2 ? 5 : 15)
    active--
    return i
  })
  assert.equal(peak, 4)
  assert.deepEqual(results, items)
})

/** 用真实临时诊断文件驱动异步退出，验证重试不会生成第二个会话 ID。 */
function sshHarness () {
  const handles = []
  const events = []
  const manager = new SessionManager({
    knownHostsPath: '/tmp/serverlink-retry-unused',
    spawn: () => {
      const handle = {
        onData: () => ({ dispose () {} }),
        onExit: callback => { handle.exit = callback; return { dispose () {} } },
        kill: () => handle.exit({ exitCode: 0 }),
        resize: () => {}
      }
      handles.push(handle)
      return handle
    }
  })
  const { sessionId } = manager.start(1, profile, event => events.push(event))
  return { manager, handles, events, sessionId }
}

test('SSH retries asynchronous pre-auth exits in place and never replays input', async t => {
  const harness = sshHarness()
  t.after(() => harness.manager.closeAll())
  const record = harness.manager.sessions.get(harness.sessionId)
  await fs.writeFile(record.logPath, 'debug1: Authenticating to example.com\nConnection reset by peer\n')
  harness.handles[0].exit({ exitCode: 255 })
  assert.equal(harness.events.at(-1).phase, 'retrying')
  harness.manager.write(1, harness.sessionId, 'must-not-be-replayed')
  harness.manager.resize(1, harness.sessionId, 120, 40)
  await delay(1100)
  assert.equal(harness.handles.length, 2)
  assert.equal(harness.manager.sessions.size, 1)
  assert.equal(record.cols, 120)
  await fs.writeFile(record.logPath, 'Authenticated to example.com using "password".\n')
  harness.manager.readProgress(record)
  assert.equal(record.connected, true)
  harness.handles[1].exit({ exitCode: 255 })
  assert.equal(harness.manager.sessions.size, 0)
  assert.equal(harness.events.at(-1).type, 'exit')
})

test('SSH auth/trust failure and explicit close never schedule another native process', async () => {
  for (const log of ['Permission denied', 'Host key verification failed', 'Connection timed out']) {
    const harness = sshHarness()
    const record = harness.manager.sessions.get(harness.sessionId)
    await fs.writeFile(record.logPath, log)
    harness.handles[0].exit({ exitCode: 255 })
    if (log.includes('timed out')) harness.manager.close(1, harness.sessionId)
    assert.equal(harness.manager.sessions.size, 0)
    await delay(1050)
    assert.equal(harness.handles.length, 1)
  }
})

test('SSH exhausts exactly two retries and shutdown cancels pending retry', async t => {
  const harness = sshHarness()
  t.after(() => harness.manager.closeAll())
  for (let attempt = 0; attempt < 3; attempt++) {
    const record = harness.manager.sessions.get(harness.sessionId)
    await fs.writeFile(record.logPath, 'Connection refused\n')
    harness.handles[attempt].exit({ exitCode: 255 })
    if (attempt < 2) await delay((attempt + 1) * 1000 + 100)
  }
  assert.equal(harness.handles.length, 3)
  assert.equal(harness.manager.sessions.size, 0)
  assert.equal(harness.events.at(-1).type, 'exit')
  const closing = sshHarness()
  await fs.writeFile(closing.manager.sessions.get(closing.sessionId).logPath, 'Connection reset\n')
  closing.handles[0].exit({ exitCode: 255 })
  assert.equal(await closing.manager.closeAllAndWait(), true)
  await delay(1050)
  assert.equal(closing.handles.length, 1)
})
