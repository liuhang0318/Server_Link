'use strict'

const assert = require('node:assert/strict')
const { EventEmitter, once } = require('node:events')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { Server, utils } = require('@electerm/ssh2')
const { SftpManager } = require('../lib/sftp-manager.cjs')

const profile = { id: 'fixture', name: 'Fixture', host: '127.0.0.1', port: 22, username: 'root', auth: 'password', privateKeyPath: null }
const id = '89c89d7c-68b8-41b7-a065-9ec8f41d61ca'

test('close removes ownership and destroys the transport without waiting for buffered writes', () => {
  const manager = new SftpManager({ knownHostsPath: '/tmp/serverlink-unused-close', confirmHost: async () => false })
  const calls = []
  const record = {
    id,
    ownerId: 1,
    upload: { controller: new AbortController() },
    sftp: { end: () => calls.push('channel') },
    client: { end: () => calls.push('graceful'), destroy: () => calls.push('destroy') }
  }
  manager.connections.set(id, record)
  assert.equal(manager.close(1, id), true)
  assert.equal(record.upload.controller.signal.aborted, true)
  assert.equal(manager.connections.size, 0)
  assert.deepEqual(calls, ['channel', 'destroy'])
  manager.closeRecord(record)
  assert.deepEqual(calls, ['channel', 'destroy'], 'repeated close is harmless')
})

test('canceling a pending handshake disposes a late SFTP channel and never resurrects it', async () => {
  const client = new EventEmitter()
  let completeChannel
  let destroyed = 0
  let ended = 0
  client.connect = () => queueMicrotask(() => client.emit('ready'))
  client.sftp = callback => { completeChannel = callback }
  client.end = () => client.emit('close')
  client.destroy = () => { destroyed++; client.emit('close') }
  const manager = new SftpManager({ knownHostsPath: '/tmp/serverlink-unused-close', confirmHost: async () => false, createClient: () => client })
  const pending = manager.connect(1, profile, 'fixture')
  const rejected = assert.rejects(pending, /closed/u)
  await Promise.resolve()
  assert.equal(typeof completeChannel, 'function')
  manager.cancelConnect(1, profile.id)
  await rejected
  // 用户关闭与通道回调可能交错；迟到成功只能释放，不能再开始读取目录。
  completeChannel(null, { end: () => { ended++ }, realpath: () => assert.fail('closed connection must not browse') })
  assert.equal(ended, 1)
  assert.equal(destroyed, 1)
  assert.equal(manager.connections.size, 0)
  assert.equal(manager.pendingConnections.size, 0)
})

/** 使用两条真实回环 SSH 连接和内存文件服务，专测强关而不读取用户凭据或目录。 */
async function loopbackFixture (t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'serverlink-close-'))
  const clients = new Set()
  const controls = {}
  const files = new Map([['/source.bin', Buffer.alloc(2 * 1024 * 1024, 65)]])
  const server = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, client => {
    clients.add(client)
    client.on('close', () => clients.delete(client))
    client.on('error', () => {})
    client.on('authentication', context => context.method === 'password' && context.password === 'fixture' ? context.accept() : context.reject(['password']))
    client.on('ready', () => client.on('session', accept => accept().on('sftp', accept => {
      const sftp = accept()
      const handles = new Map()
      let counter = 0
      const { STATUS_CODE: status } = utils.sftp
      const attributes = name => ({ mode: 0o100600, size: files.get(name).length, uid: 0, gid: 0, atime: 0, mtime: 0 })
      sftp.on('REALPATH', request => sftp.name(request, [{ filename: '/', longname: '/', attrs: {} }]))
      sftp.on('OPENDIR', request => sftp.handle(request, Buffer.from('directory')))
      sftp.on('READDIR', request => sftp.status(request, status.EOF))
      sftp.on('LSTAT', (request, name) => files.has(name)
        ? sftp.attrs(request, attributes(name))
        : sftp.status(request, status.NO_SUCH_FILE))
      sftp.on('FSTAT', (request, handle) => sftp.attrs(request, attributes(handles.get(handle.toString()))))
      sftp.on('OPEN', (request, name, flags) => {
        if (utils.sftp.flagsToString(flags).includes('w')) files.set(name, Buffer.alloc(0))
        const handle = Buffer.from(String(++counter))
        handles.set(handle.toString(), name)
        if (controls.beforeOpen) {
          const beforeOpen = controls.beforeOpen
          controls.beforeOpen = null
          beforeOpen()
          setTimeout(() => sftp.handle(request, handle), 10)
        } else sftp.handle(request, handle)
      })
      sftp.on('READ', (request, handle, offset, length) => {
        const file = files.get(handles.get(handle.toString()))
        if (!file) return sftp.status(request, status.FAILURE)
        const data = file.subarray(offset, offset + length)
        if (data.length) sftp.data(request, data)
        else sftp.status(request, status.EOF)
        const onRead = controls.onRead
        controls.onRead = null
        if (onRead) setImmediate(onRead)
      })
      sftp.on('WRITE', (request, handle, _offset, data) => {
        const name = handles.get(handle.toString())
        if (!files.has(name)) return sftp.status(request, status.FAILURE)
        files.set(name, Buffer.concat([files.get(name), data]))
        sftp.status(request, status.OK)
        // 第一个真实 WRITE 到达后才触发关闭，避免误测成仅取消准备阶段。
        const onWrite = controls.onWrite
        controls.onWrite = null
        if (onWrite) setImmediate(onWrite)
      })
      sftp.on('CLOSE', (request, handle) => { handles.delete(handle.toString()); sftp.status(request, status.OK) })
      sftp.on('REMOVE', (request, name) => { files.delete(name); sftp.status(request, status.OK) })
      sftp.on('RENAME', (request, from, to) => {
        if (files.has(to)) return sftp.status(request, status.FAILURE)
        files.set(to, files.get(from)); files.delete(from); sftp.status(request, status.OK)
      })
    })))
  })
  const manager = new SftpManager({ knownHostsPath: path.join(directory, 'known-hosts'), confirmHost: async () => true })
  t.after(async () => {
    manager.closeAll()
    for (const client of clients) client.end()
    if (server.address()) await new Promise(resolve => server.close(resolve))
    await fs.rm(directory, { recursive: true, force: true })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const connect = () => manager.connect(1, { ...profile, port: server.address().port }, 'fixture')
  const first = await connect()
  const second = await connect()
  return { manager, directory, files, controls, first: first.connectionId, second: second.connectionId }
}

test('force close during upload settles its batch, never starts queued files and preserves another connection', { timeout: 5000 }, async t => {
  const { manager, directory, files, controls, first, second } = await loopbackFixture(t)
  const source = path.join(directory, 'upload.bin')
  const queued = path.join(directory, 'queued.txt')
  await fs.writeFile(source, Buffer.alloc(4 * 1024 * 1024, 66))
  await fs.writeFile(queued, 'must not start')
  controls.onWrite = () => manager.close(1, first)
  const results = await manager.uploadBatch(1, first, '/', [source, queued])
  assert.ok(results.every(result => result.canceled))
  assert.equal(files.has('/upload.bin'), false)
  assert.equal(files.has('/queued.txt'), false)
  assert.equal(manager.connections.has(first), false)
  assert.equal((await manager.list(1, second, '/')).path, '/')
  // 强关不等待远端清理；只断言最终文件未发布，不承诺断线后 .part 一定能删掉。
})

for (const endpoint of ['source', 'destination']) {
  test(`force closing the ${endpoint} stops cross-server copy and leaves the other connection usable`, { timeout: 5000 }, async t => {
    const { manager, files, controls, first, second } = await loopbackFixture(t)
    controls.onWrite = () => manager.close(1, endpoint === 'source' ? first : second)
    await assert.rejects(manager.copyBetween(1, first, '/source.bin', second, '/copies'), { name: 'AbortError' })
    assert.equal(files.has('/copies/source.bin'), false)
    assert.equal((await manager.list(1, endpoint === 'source' ? second : first, '/')).path, '/')
  })
}

test('force close before upload OPEN acknowledgement settles and prevents publication', { timeout: 5000 }, async t => {
  const { manager, directory, files, controls, first, second } = await loopbackFixture(t)
  const source = path.join(directory, 'upload.bin')
  await fs.writeFile(source, Buffer.alloc(1024 * 1024))
  controls.beforeOpen = () => manager.close(1, first)
  const results = await manager.uploadBatch(1, first, '/', [source])
  assert.equal(results[0].canceled, true)
  assert.equal(files.has('/upload.bin'), false)
  assert.equal((await manager.list(1, second, '/')).path, '/')
})

test('force close during download preserves the chosen local file and removes local staging', { timeout: 5000 }, async t => {
  const { manager, directory, controls, first, second } = await loopbackFixture(t)
  const target = path.join(directory, 'download.bin')
  await fs.writeFile(target, 'original')
  controls.onRead = () => manager.close(1, first)
  await assert.rejects(manager.download(1, first, '/source.bin', target))
  assert.equal(await fs.readFile(target, 'utf8'), 'original')
  assert.equal((await fs.readdir(directory)).some(name => name.endsWith('.part')), false)
  assert.equal((await manager.list(1, second, '/')).path, '/')
})
