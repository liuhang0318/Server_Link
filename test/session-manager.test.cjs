'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { ProfileStore } = require('../lib/profile-store.cjs')
const { SessionManager } = require('../lib/session-manager.cjs')

const profile = Object.freeze({
  id: '89c89d7c-68b8-41b7-a065-9ec8f41d61ca',
  name: 'Test server',
  host: 'server.example.com',
  port: 22,
  username: 'deploy',
  auth: 'password',
  privateKeyPath: null,
  createdAt: '2026-09-04T12:00:00.000Z',
  updatedAt: '2026-09-04T12:00:00.000Z'
})

function createManager () {
  const calls = { kills: [], resizes: [] }
  let exitListener
  const processHandle = {
    onData: () => ({ dispose: () => {} }),
    onExit: listener => {
      exitListener = listener
      return { dispose: () => {} }
    },
    kill: signal => calls.kills.push(signal),
    resize: (cols, rows) => calls.resizes.push([cols, rows])
  }
  const manager = new SessionManager({
    knownHostsPath: '/tmp/serverlink-known-hosts',
    spawn: (file, args, options) => {
      calls.spawn = { file, args, options }
      return processHandle
    },
    environment: { LANG: 'en_US.UTF-8' }
  })
  return {
    calls,
    manager,
    exit: event => exitListener(event)
  }
}

test('start accepts a reloaded persisted profile without forwarding metadata to ssh', async t => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'serverlink-session-test-'))
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }))
  const storeDirectory = path.join(temporaryRoot, 'profiles')
  const store = new ProfileStore(storeDirectory)
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...profileInput } = profile
  const created = await store.create(profileInput)
  // Reload through the same disk path that produced the reported id/timestamp shape.
  const persisted = await new ProfileStore(storeDirectory).get(created.id)
  const harness = createManager()

  const session = harness.manager.start(1, persisted, () => {})

  assert.equal(harness.calls.spawn.file, '/usr/bin/ssh')
  assert.equal(harness.calls.spawn.args.at(-1), persisted.host)
  assert.equal(harness.calls.spawn.args.includes(persisted.id), false)
  harness.manager.close(1, session.sessionId)
  harness.exit({ exitCode: 0, signal: 15 })
})

test('closeAllAndWait resolves immediately when there are no sessions', async () => {
  const manager = new SessionManager({ knownHostsPath: '/tmp/serverlink-known-hosts' })

  assert.equal(await manager.closeAllAndWait(), true)
})

test('duplicate terminal dimensions do not trigger repeated native resize notifications', () => {
  const harness = createManager()
  const session = harness.manager.start(1, profile, () => {})
  harness.manager.resize(1, session.sessionId, 100, 30)
  harness.manager.resize(1, session.sessionId, 120, 40)
  harness.manager.resize(1, session.sessionId, 120, 40)
  assert.deepEqual(harness.calls.resizes, [[120, 40]])
  assert.throws(() => harness.manager.resize(2, session.sessionId, 120, 40), /not found/u)
  harness.manager.close(1, session.sessionId)
  harness.exit({ exitCode: 0, signal: 15 })
})

test('closeAllAndWait resolves when the final PTY exits', async () => {
  const harness = createManager()
  harness.manager.start(1, profile, () => {})

  const closed = harness.manager.closeAllAndWait(100)
  assert.deepEqual(harness.calls.kills, ['SIGTERM'])
  harness.exit({ exitCode: 0, signal: 15 })

  assert.equal(await closed, true)
  assert.equal(harness.manager.sessions.size, 0)
})

test('closeAllAndWait returns after its bounded timeout when a PTY never exits', async () => {
  const harness = createManager()
  harness.manager.start(1, profile, () => {})

  // Wait beyond the built-in grace period to prove shutdown escalates before timing out.
  assert.equal(await harness.manager.closeAllAndWait(200), false)
  assert.deepEqual(harness.calls.kills, ['SIGTERM', 'SIGKILL'])
  assert.equal(harness.manager.sessions.size, 1)
  assert.throws(() => harness.manager.start(2, profile, () => {}), /shutting down/u)
})
