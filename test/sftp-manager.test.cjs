'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { Writable } = require('node:stream')
const { utils } = require('@electerm/ssh2')
const { checkKnownHost, trustKnownHost } = require('../lib/known-hosts.cjs')
const {
  SftpManager,
  validateRemoteName,
  validateRemotePath
} = require('../lib/sftp-manager.cjs')

const connectionId = '89c89d7c-68b8-41b7-a065-9ec8f41d61ca'

function fakeSftp (calls) {
  return {
    readdir: (_remotePath, callback) => callback(null, [
      { filename: 'notes.txt', attrs: { size: 12, mtime: 1, isDirectory: () => false, isSymbolicLink: () => false } },
      { filename: 'logs', attrs: { size: 0, mtime: 2, isDirectory: () => true, isSymbolicLink: () => false } }
    ]),
    mkdir: (remotePath, callback) => { calls.mkdir = remotePath; callback() },
    lstat: (_remotePath, callback) => callback(null, { isDirectory: () => false }),
    unlink: (remotePath, callback) => { calls.unlink = remotePath; callback() },
    rmdir: (remotePath, callback) => { calls.rmdir = remotePath; callback() }
  }
}

test('known-hosts stores hashed owner-only entries and rejects a changed key', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'serverlink-known-hosts-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const knownHostsPath = path.join(directory, 'known_hosts')
  const firstKey = utils.parseKey(utils.generateKeyPairSync('ed25519').public).getPublicSSH()
  const changedKey = utils.parseKey(utils.generateKeyPairSync('ed25519').public).getPublicSSH()

  assert.equal((await checkKnownHost({ knownHostsPath, host: 'server.example.com', port: 2222, hostKey: firstKey })).status, 'not-found')
  await trustKnownHost({ knownHostsPath, host: 'server.example.com', port: 2222, hostKey: firstKey })
  assert.equal((await checkKnownHost({ knownHostsPath, host: 'server.example.com', port: 2222, hostKey: firstKey })).status, 'match')
  assert.equal((await checkKnownHost({ knownHostsPath, host: 'server.example.com', port: 2222, hostKey: changedKey })).status, 'mismatch')
  const body = await fs.readFile(knownHostsPath, 'utf8')
  assert.match(body, /^\|1\|/u)
  assert.equal(body.includes('server.example.com'), false)
  assert.equal((await fs.stat(knownHostsPath)).mode & 0o777, 0o600)
})

test('a revoked known-host entry wins over a duplicate trusted entry', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'serverlink-revoked-host-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const knownHostsPath = path.join(directory, 'known_hosts')
  const parsedKey = utils.parseKey(utils.generateKeyPairSync('ed25519').public)
  const rawKey = parsedKey.getPublicSSH()
  const line = `server.example.com ${parsedKey.type} ${rawKey.toString('base64')}`
  await fs.writeFile(knownHostsPath, `${line}\n@revoked ${line}\n`)

  const result = await checkKnownHost({
    knownHostsPath,
    host: 'server.example.com',
    port: 22,
    hostKey: rawKey
  })
  assert.equal(result.status, 'revoked')
})

test('SFTP operations validate paths and enforce renderer ownership', async () => {
  const calls = {}
  const manager = new SftpManager({
    knownHostsPath: '/tmp/serverlink-known-hosts',
    confirmHost: async () => false
  })
  manager.connections.set(connectionId, {
    id: connectionId,
    ownerId: 7,
    sftp: fakeSftp(calls),
    client: { end: () => {} },
    closing: false
  })

  await assert.rejects(manager.list(8, connectionId, '/srv'), /not found/u)
  const result = await manager.list(7, connectionId, '/srv/./data')
  assert.equal(result.path, '/srv/data')
  assert.deepEqual(result.entries.map(entry => entry.name), ['logs', 'notes.txt'])
  await manager.mkdir(7, connectionId, '/srv/data', 'releases')
  assert.equal(calls.mkdir, '/srv/data/releases')
  await manager.remove(7, connectionId, '/srv/data/notes.txt')
  assert.equal(calls.unlink, '/srv/data/notes.txt')
  await assert.rejects(manager.remove(7, connectionId, '/'), /root cannot be removed/u)
})

test('remote SFTP validation rejects relative paths, traversal names and control bytes', () => {
  assert.equal(validateRemotePath('/var/../srv'), '/srv')
  for (const remotePath of ['srv/data', '/srv/\nfile', '', null]) {
    assert.throws(() => validateRemotePath(remotePath))
  }
  for (const name of ['..', '.', 'a/b', 'bad\nname', '']) {
    assert.throws(() => validateRemoteName(name))
  }
})

test('cross-server copy checks ownership of the destination before reading the source', async () => {
  const manager = new SftpManager({ knownHostsPath: '/tmp/serverlink-unused-hosts', confirmHost: async () => false })
  const destinationId = '65b9d6b4-f323-4980-8ef2-a3a3d1cfd8bd'
  manager.connections.set(connectionId, { ownerId: 7, sftp: { lstat: () => assert.fail('source must not be read') } })
  manager.connections.set(destinationId, { ownerId: 8, sftp: {} })
  await assert.rejects(manager.copyBetween(7, connectionId, '/file.txt', destinationId, '/'), /not found/u)
})

test('failed upload removes only its temporary remote file and never publishes it', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'serverlink-upload-failure-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const localPath = path.join(directory, 'payload.txt')
  await fs.writeFile(localPath, 'test data')
  let temporaryPath
  let deletedPath
  const sftp = {
    lstat: (_path, callback) => callback(Object.assign(new Error('missing'), { code: 2 })),
    createWriteStream: (remotePath, options) => {
      temporaryPath = remotePath
      assert.equal(options.flags, 'wx')
      const stream = new Writable({ write: (_chunk, _encoding, callback) => callback(new Error('transfer failed')) })
      process.nextTick(() => stream.emit('open'))
      return stream
    },
    rename: () => assert.fail('a failed transfer must not be published'),
    unlink: (remotePath, callback) => { deletedPath = remotePath; callback() }
  }
  const manager = new SftpManager({ knownHostsPath: '/tmp/serverlink-unused-hosts', confirmHost: async () => false })
  manager.connections.set(connectionId, { ownerId: 7, sftp })
  const progress = []
  await assert.rejects(manager.upload(7, connectionId, '/target', localPath, event => progress.push(event)), /transfer failed/u)
  assert.equal(progress.at(-1).phase, 'failed')
  assert.equal(progress.some(event => event.phase === 'completed'), false)
  assert.match(temporaryPath, /^\/target\/\.serverlink-[0-9a-f-]+\.part$/u)
  assert.equal(deletedPath, temporaryPath)
})

test('upload progress counts acknowledged bytes and completes only after publish, including empty files', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'serverlink-progress-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  for (const size of [512 * 1024, 0]) {
    const source = path.join(directory, 'fixture.bin')
    await fs.writeFile(source, Buffer.alloc(size))
    const events = []
    let published = false
    const sftp = {
      lstat: (_path, callback) => callback(Object.assign(new Error('missing'), { code: 2 })),
      createWriteStream: () => {
        const stream = new Writable({
          write: (chunk, _encoding, callback) => {
            setTimeout(() => { stream.bytesWritten += chunk.length; callback() }, 40)
          }
        })
        stream.bytesWritten = 0
        process.nextTick(() => stream.emit('open'))
        return stream
      },
      rename: (_from, _to, callback) => {
        assert.equal(events.some(event => event.phase === 'completed'), false)
        published = true
        callback()
      }
    }
    const manager = new SftpManager({ knownHostsPath: '/tmp/unused-progress-hosts', confirmHost: async () => false })
    manager.connections.set(connectionId, { ownerId: 7, sftp })
    await manager.upload(7, connectionId, '/', source, event => {
      if (event.phase === 'completed') assert.equal(published, true)
      events.push(event)
    })
    assert.equal(events[0].transferred, 0)
    assert.equal(events.at(-1).phase, 'completed')
    assert.equal(events.at(-1).transferred, size)
    assert.equal(events[0].phase, 'preparing')
    assert.ok(events.every(event => event.connectionId === connectionId && (event.phase === 'preparing' || event.total === size) && !JSON.stringify(event).includes(directory)))
    if (size) assert.ok(events.some(event => event.transferred > 0 && event.transferred < size))
    for (let i = 1; i < events.length; i++) assert.ok(events[i].transferred >= events[i - 1].transferred)
  }
})
