'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const {
  SSH_PATH,
  buildSshCommand,
  normalizeProfileInput,
  validateHost,
  validatePort,
  validatePrivateKeyPath,
  validateUsername
} = require('../lib/ssh-args.cjs')
const { ProfileStore } = require('../lib/profile-store.cjs')
const { SessionManager } = require('../lib/session-manager.cjs')

const validProfile = Object.freeze({
  name: 'Production API',
  host: 'api.example.com',
  port: 22,
  username: 'deploy',
  auth: 'key',
  privateKeyPath: '/Users/test/.ssh/id ed25519'
})

test('validation rejects option, shell, control, and coercion injection', () => {
  for (const host of ['-oProxyCommand=touch /tmp/pwned', 'host;whoami', 'host name', 'host\nname']) {
    assert.throws(() => validateHost(host))
  }
  for (const username of ['-root', 'root@host', 'root;id', 'root name']) {
    assert.throws(() => validateUsername(username))
  }
  for (const port of ['22', '22;id', 0, 65536, 22.5]) {
    assert.throws(() => validatePort(port))
  }
  for (const keyPath of ['id_ed25519', '~/id_ed25519', '/tmp/key\n-oProxyCommand=x']) {
    assert.throws(() => validatePrivateKeyPath(keyPath))
  }
  assert.throws(() => normalizeProfileInput({ ...validProfile, password: 'secret' }), /unsupported field/u)
})

test('preload exposes only a validated dropped-File path capability', () => {
  let exposedApi
  const invocations = []
  const preloadSource = readFileSync(path.join(__dirname, '..', 'preload.cjs'), 'utf8')
  const ipcRenderer = {
    invoke: (...args) => { invocations.push(args) },
    on: () => {},
    removeListener: () => {}
  }
  const contextBridge = {
    exposeInMainWorld: (_name, api) => { exposedApi = api }
  }
  const webUtils = {
    getPathForFile: file => file.localPath ?? ''
  }
  vm.runInNewContext(preloadSource, {
    require: moduleName => {
      assert.equal(moduleName, 'electron')
      return { contextBridge, ipcRenderer, webUtils }
    }
  })

  assert.deepEqual(Object.keys(exposedApi).sort(), ['privateKeys', 'profiles', 'sessions', 'sftp'])
  assert.deepEqual(Object.keys(exposedApi.privateKeys), ['getPathForFile'])
  assert.deepEqual(Object.keys(exposedApi.sftp).sort(), [
    'close', 'connect', 'copyBetween', 'download', 'list', 'mkdir', 'remove', 'upload', 'uploadFiles'
  ])
  assert.equal(
    exposedApi.privateKeys.getPathForFile({ name: 'id_ed25519', size: 411, localPath: '/Users/test/.ssh/id_ed25519' }),
    '/Users/test/.ssh/id_ed25519'
  )
  assert.throws(() => exposedApi.privateKeys.getPathForFile(null), /one local file/u)
  assert.throws(
    () => exposedApi.privateKeys.getPathForFile({ name: 'synthetic', size: 1 }),
    /no valid absolute local path/u
  )
  assert.throws(
    () => exposedApi.privateKeys.getPathForFile({ name: 'relative', size: 1, localPath: '../id_rsa' }),
    /no valid absolute local path/u
  )
  assert.throws(() => exposedApi.sftp.connect('profile-id', 'x'.repeat(4097)), /secret is too large/u)
  assert.throws(() => exposedApi.sftp.uploadFiles('connection', '/', ['/etc/passwd']), /one local file/u)
  assert.throws(() => exposedApi.sftp.uploadFiles('connection', '/', [{ name: 'fake', size: 1 }]), /no valid absolute local path/u)
  exposedApi.sftp.uploadFiles('connection', '/upload', [{ name: 'real.txt', size: 4, localPath: '/tmp/real.txt' }])
  assert.equal(invocations.at(-1)[0], 'sftp:upload-files')
  assert.equal(invocations.at(-1)[3][0], '/tmp/real.txt')
})

test('ssh builder returns fixed executable and separated hardened argv', () => {
  const knownHostsPath = '/Users/test/Library/Application Support/ServerLink/known_hosts'
  const command = buildSshCommand(validProfile, { knownHostsPath })

  assert.equal(command.file, SSH_PATH)
  assert.equal(command.file, '/usr/bin/ssh')
  assert.equal(command.args[command.args.indexOf('-F') + 1], 'none')
  for (const required of [
    'StrictHostKeyChecking=ask',
    'HashKnownHosts=yes',
    'GlobalKnownHostsFile=/dev/null',
    'ForwardAgent=no',
    'ClearAllForwardings=yes',
    'PermitLocalCommand=no',
    'ProxyCommand=none',
    'PasswordAuthentication=no',
    'KbdInteractiveAuthentication=no',
    'IdentitiesOnly=yes'
  ]) {
    assert.ok(command.args.includes(required), `missing ${required}`)
  }
  assert.ok(command.args.some(arg => arg.startsWith('UserKnownHostsFile="/Users/test/Library/Application Support/')))
  assert.equal(command.args.at(-2), '--')
  assert.equal(command.args.at(-1), validProfile.host)
  assert.equal(command.args[command.args.indexOf('-i') + 1], validProfile.privateKeyPath)
  assert.ok(command.args.every(arg => typeof arg === 'string'))
  assert.equal(command.args.some(arg => arg.includes('ssh ')), false)
})

test('native OpenSSH accepts the quoted app-owned known-hosts path', () => {
  const knownHostsPath = '/Users/test/Library/Application Support/ServerLink/known_hosts'
  const command = buildSshCommand(validProfile, { knownHostsPath })

  // -G resolves configuration without opening a network connection, proving
  // the quoted path remains one OpenSSH value even when it contains spaces.
  const resolved = execFileSync(command.file, ['-G', ...command.args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  assert.match(resolved, /^userknownhostsfile \/Users\/test\/Library\/Application Support\/ServerLink\/known_hosts$/mu)
  assert.match(resolved, /^clearallforwardings yes$/mu)
  assert.match(resolved, /^hashknownhosts yes$/mu)
})

test('password mode carries no persisted or process-level secret', () => {
  const profile = {
    ...validProfile,
    auth: 'password',
    privateKeyPath: null
  }
  const command = buildSshCommand(profile, { knownHostsPath: '/tmp/serverlink-known-hosts' })

  for (const required of [
    'PubkeyAuthentication=no',
    'PasswordAuthentication=yes',
    'KbdInteractiveAuthentication=yes',
    'PreferredAuthentications=keyboard-interactive,password',
    'IdentityFile=none'
  ]) {
    assert.ok(command.args.includes(required), `missing ${required}`)
  }
  assert.equal(Object.hasOwn(command.profile, 'password'), false)
  assert.equal(command.args.some(arg => /password=/iu.test(arg)), false)
})

test('session manager scopes PTY controls to the owning renderer', () => {
  const calls = { writes: [], resizes: [], kills: [] }
  let exitListener
  const spawn = (file, args, options) => {
    calls.spawn = { file, args, options }
    return {
      onData: () => ({ dispose: () => {} }),
      onExit: listener => {
        exitListener = listener
        return { dispose: () => {} }
      },
      write: data => calls.writes.push(data),
      resize: (cols, rows) => calls.resizes.push([cols, rows]),
      kill: signal => calls.kills.push(signal)
    }
  }
  const manager = new SessionManager({
    knownHostsPath: '/tmp/serverlink-known-hosts',
    spawn,
    environment: { LANG: 'en_US.UTF-8', LEAK_ME: 'no' }
  })
  const profile = { ...validProfile, auth: 'password', privateKeyPath: null }
  const session = manager.start(41, profile, () => {})

  assert.equal(calls.spawn.file, '/usr/bin/ssh')
  assert.equal(calls.spawn.options.shell, undefined)
  assert.deepEqual(Object.keys(calls.spawn.options.env).sort(), ['LANG', 'PATH', 'TERM'])
  assert.throws(() => manager.write(42, session.sessionId, 'whoami\r'), /session not found/u)
  assert.throws(() => manager.resize(42, session.sessionId, 80, 24), /session not found/u)
  assert.throws(() => manager.close(42, session.sessionId), /session not found/u)

  manager.write(41, session.sessionId, 'whoami\r')
  manager.resize(41, session.sessionId, 80, 24)
  manager.close(41, session.sessionId)
  assert.deepEqual(calls.writes, ['whoami\r'])
  assert.deepEqual(calls.resizes, [[80, 24]])
  assert.deepEqual(calls.kills, ['SIGTERM'])
  exitListener({ exitCode: 0, signal: 15 })
  assert.equal(manager.sessions.size, 0)
})

test('profile persistence rejects secrets and enforces owner-only modes', async t => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'serverlink-test-'))
  const storeDirectory = path.join(temporaryRoot, 'profiles')
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }))

  const store = new ProfileStore(storeDirectory)
  await store.init()
  await assert.rejects(store.create({ ...validProfile, password: 'never-save-me' }), /unsupported field/u)
  const created = await store.create(validProfile)
  await assert.rejects(store.update(created.id, { ...validProfile, passphrase: 'also-secret' }), /unsupported field/u)

  const body = await fs.readFile(store.filePath, 'utf8')
  assert.equal(body.includes('never-save-me'), false)
  assert.equal(body.includes('also-secret'), false)
  assert.equal(/password|passphrase|secret/iu.test(body), false)
  assert.equal((await fs.stat(storeDirectory)).mode & 0o777, 0o700)
  assert.equal((await fs.stat(store.filePath)).mode & 0o777, 0o600)
  assert.deepEqual((await fs.readdir(storeDirectory)).sort(), ['profiles.json'])

  // A fresh instance exercises the same validation path used after an app restart.
  const reloadedStore = new ProfileStore(storeDirectory)
  assert.deepEqual(await reloadedStore.list(), [created])
})
