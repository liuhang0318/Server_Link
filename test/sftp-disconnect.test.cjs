'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const { SftpManager } = require('../lib/sftp-manager.cjs')
const source = readFileSync(path.join(__dirname, '../src/main.js'), 'utf8')
const profile = { id: 'fixture', name: 'Fixture', host: '127.0.0.1', port: 22, username: 'root', auth: 'password', privateKeyPath: null }

/** 仅使用内存通道，验证握手、断线通知与主动关闭，不打开 socket 或读取真实凭据。 */
function nativeFixture () {
  const client = new EventEmitter()
  const channel = new EventEmitter()
  const events = []
  client.connect = () => queueMicrotask(() => client.emit('ready'))
  client.sftp = callback => callback(null, channel)
  client.destroy = () => client.emit('close')
  channel.end = () => channel.emit('close')
  channel.realpath = (_path, callback) => callback(null, '/')
  channel.readdir = (_path, callback) => callback(null, [])
  const manager = new SftpManager({
    knownHostsPath: '/tmp/serverlink-unused-disconnect-hosts',
    confirmHost: async () => false,
    createClient: () => client,
    onDisconnected: (ownerId, details) => events.push({ ownerId, ...details })
  })
  return { manager, client, channel, events }
}

test('unexpected socket or channel close notifies its owner once and revokes all operations', async () => {
  for (const surface of ['client', 'channel']) {
    const h = nativeFixture()
    const result = await h.manager.connect(7, profile, 'fixture')
    const record = h.manager.connections.get(result.connectionId)
    record.upload = { controller: new AbortController() }
    const copy = new AbortController()
    record.copies = new Set([copy])
    h[surface].emit('close')
    h.client.emit('close')
    h.channel.emit('close')
    assert.deepEqual(h.events, [{ ownerId: 7, connectionId: result.connectionId, profileId: profile.id }])
    assert.equal(record.upload.controller.signal.aborted, true)
    assert.equal(copy.signal.aborted, true)
    await assert.rejects(h.manager.list(7, result.connectionId, '/'), /not found/u)
  }
})

test('intentional close and failure before connection publication do not emit disconnected UI events', async () => {
  const h = nativeFixture()
  const result = await h.manager.connect(7, profile, 'fixture')
  h.manager.close(7, result.connectionId)
  assert.deepEqual(h.events, [])
  const early = nativeFixture()
  early.channel.readdir = (_path, callback) => { early.client.emit('close'); callback(null, []) }
  await assert.rejects(early.manager.connect(7, profile, 'fixture'), /not found/u)
  assert.deepEqual(early.events, [])
})

test('main process routes disconnect only to the live owner and preload strips Electron event objects', () => {
  const sent = []
  const windows = [7, 8].map(id => ({ isDestroyed: () => false, webContents: { id, isDestroyed: () => false, send: (...args) => sent.push([id, ...args]) } }))
  const mainSource = readFileSync(path.join(__dirname, '../main.cjs'), 'utf8')
  const start = mainSource.indexOf('function notifySftpDisconnected (')
  const context = vm.createContext({ quitPending: false, BrowserWindow: { getAllWindows: () => windows } })
  vm.runInContext(mainSource.slice(start, mainSource.indexOf('\n}', start) + 2), context)
  const details = { connectionId: 'connection', profileId: profile.id }
  context.notifySftpDisconnected(7, details)
  assert.deepEqual(sent, [[7, 'sftp:disconnected', details]])
  context.notifySftpDisconnected(99, details)
  context.quitPending = true
  context.notifySftpDisconnected(7, details)
  assert.equal(sent.length, 1)

  let exposed
  let listener
  let removed = false
  vm.runInNewContext(readFileSync(path.join(__dirname, '../preload.cjs'), 'utf8'), {
    require: () => ({
      contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api } },
      ipcRenderer: {
        on: (channel, callback) => { assert.equal(channel, 'sftp:disconnected'); listener = callback },
        removeListener: (channel, callback) => { assert.equal(channel, 'sftp:disconnected'); assert.equal(callback, listener); removed = true }
      },
      webUtils: {}
    })
  })
  assert.throws(() => exposed.sftp.onDisconnected(null), /listener must be a function/u)
  const received = []
  const unsubscribe = exposed.sftp.onDisconnected((...args) => received.push(args))
  listener({ sender: 'private' }, details)
  assert.deepEqual(received, [[details]])
  unsubscribe()
  assert.equal(removed, true)
})

/** 执行生产 SFTP 函数；只替换 DOM 和 IPC，所有回执由测试控制顺序。 */
function rendererFixture ({ selected = true } = {}) {
  const notices = []
  const calls = []
  const connection = {
    connectionId: 'old',
    profileId: profile.id,
    status: 'ready',
    connectedOnce: true,
    title: 'Fixture · SFTP',
    path: '/working',
    entries: [],
    busy: false,
    ui: { pane: { querySelector: () => ({}), remove () {} }, transfer: { classList: { add () {} } } }
  }
  const state = { sftpConnections: new Map([['old', connection]]), sftpConnecting: new Set(), sftpDisconnects: new Map(), sftp: connection, sftpActive: true }
  const api = {
    sftp: {
      connect: async () => { calls.push(['connect']); return { connectionId: 'new', path: '/home', entries: [] } },
      list: async (id, remotePath) => { calls.push(['list', id, remotePath]); return { path: remotePath, entries: [] } },
      close: async id => calls.push(['close', id])
    }
  }
  const tab = { dataset: { tabKey: 'sftp:old' } }
  const context = vm.createContext({
    state,
    api,
    tabOrder: ['ssh:first', 'sftp:old', 'ssh:last'],
    tabPointer: null,
    folderConnection: null,
    folderConnectionId: null,
    uploadTargets: new Set(selected ? ['old'] : []),
    profileById: () => ({ ...profile, auth: 'key' }),
    notify: (...args) => notices.push(args),
    errorMessage: error => error.message,
    setSftpBusy: (busy, _message, target) => { target.busy = busy },
    renderSftpFiles () {},
    renderTabs () {},
    renderRemoteChoices () {},
    renderProfiles () {},
    syncWorkspaceState () {},
    animateSurface () {},
    activateSftp: () => assert.fail('background recovery cannot activate a tab'),
    elements: { tabs: { querySelector: () => tab } }
  })
  for (const name of ['isCurrentSftpConnection', 'handleSftpDisconnected', 'connectSftp', 'refreshSftpAfterOperation', 'uploadSftpFile', 'downloadSftpFile', 'refreshSftp', 'uploadDroppedFiles', 'uploadLocalSelection', 'removeSftpEntry', 'submitRemoteCopy', 'submitSftpDirectory', 'closeSftp']) {
    const start = source.indexOf(`function ${name} (`)
    const begin = source.slice(start - 6, start) === 'async ' ? start - 6 : start
    vm.runInContext(source.slice(begin, source.indexOf('\n}', start) + 2), context)
  }
  const disconnect = () => context.handleSftpDisconnected({ connectionId: connection.connectionId, profileId: profile.id })
  const reconnect = () => context.connectSftp(profile.id, { activate: false, connection })
  return { context, state, api, connection, calls, notices, tab, disconnect, reconnect }
}

test('disconnect and reconnect preserve selection, tab order, drag rollback identity and background focus', async () => {
  for (const selected of [true, false]) {
    const h = rendererFixture({ selected })
    h.context.tabPointer = { key: 'sftp:old', originalOrder: [...h.context.tabOrder] }
    h.disconnect()
    assert.equal(h.connection.status, 'failed')
    assert.equal(h.context.uploadTargets.size, 0)
    const background = {}
    h.state.sftp = background
    await h.reconnect()
    assert.equal(h.connection.status, 'ready')
    assert.equal(h.connection.path, '/working')
    assert.deepEqual([...h.context.tabOrder], ['ssh:first', 'sftp:new', 'ssh:last'])
    assert.deepEqual([...h.context.tabPointer.originalOrder], ['ssh:first', 'sftp:new', 'ssh:last'])
    assert.equal(h.tab.dataset.tabKey, 'sftp:new')
    assert.equal(h.state.sftp, background)
    assert.deepEqual([...h.context.uploadTargets], selected ? ['new'] : [])
    assert.deepEqual(h.calls, [['connect'], ['list', 'new', '/working']])
    h.context.handleSftpDisconnected({ connectionId: 'old', profileId: profile.id })
    assert.equal(h.connection.status, 'ready', 'old socket event must not break the replacement')
  }
})

test('new connections default selected; missing former directory falls back with a visible explanation', async () => {
  const fresh = rendererFixture({ selected: false })
  fresh.connection.status = 'queued'
  fresh.connection.connectedOnce = false
  await fresh.reconnect()
  assert.deepEqual([...fresh.context.uploadTargets], ['new'])
  assert.equal(fresh.calls.length, 1)
  const h = rendererFixture()
  h.disconnect()
  h.api.sftp.list = async () => { throw new Error('No such directory') }
  await h.reconnect()
  assert.equal(h.connection.path, '/home')
  assert.ok(h.notices.some(([message, error]) => message.includes('原目录不可用') && message.includes('/home') && error))
})

test('a close event preceding connect response never publishes a dead connection and pending events are cleared', async () => {
  const h = rendererFixture()
  h.disconnect()
  h.api.sftp.connect = async () => {
    h.context.handleSftpDisconnected({ connectionId: 'new', profileId: profile.id })
    return { connectionId: 'new', path: '/working', entries: [] }
  }
  await h.reconnect()
  assert.equal(h.connection.status, 'failed')
  assert.equal(h.connection.connectionId, 'old')
  assert.equal(h.state.sftpDisconnects.size, 0)
  assert.equal(h.context.uploadTargets.size, 0)
})

test('closing a pane during directory restoration releases the late connection instead of resurrecting it', async () => {
  const h = rendererFixture()
  h.disconnect()
  h.api.sftp.list = async () => {
    h.connection.closed = true
    h.state.sftpConnections.delete('old')
    return { path: '/working', entries: [] }
  }
  await h.reconnect()
  assert.equal(h.state.sftpConnections.size, 0)
  assert.deepEqual(h.calls, [['connect'], ['close', 'new']])
  h.context.handleSftpDisconnected({ connectionId: 'new', profileId: profile.id })
  assert.equal(h.state.sftpDisconnects.size, 0)
})

test('force-close during directory restoration immediately closes the new channel without waiting for listing', async () => {
  const h = rendererFixture()
  h.disconnect()
  let finishListing
  h.api.sftp.list = () => new Promise(resolve => { finishListing = resolve })
  const reconnecting = h.reconnect()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.connection.pendingConnectionId, 'new')
  h.context.document = { querySelector: () => ({ querySelectorAll: () => [], getBoundingClientRect: () => ({ left: 0 }) }) }
  await h.context.closeSftp(h.connection, { force: true })
  assert.deepEqual(h.calls, [['connect'], ['close', 'new']])
  assert.equal(h.state.sftpConnections.size, 0)
  finishListing({ path: '/working', entries: [] })
  await reconnecting
  assert.equal(h.state.sftpConnections.size, 0)
})

test('disconnect dismisses old folder/copy dialogs and their stale submits cannot lock or operate a new connection', async () => {
  const h = rendererFixture()
  let closed = 0
  h.context.folderConnection = h.connection
  h.context.folderConnectionId = 'old'
  h.context.folderDialog = { close: () => closed++ }
  h.state.copySource = { connection: h.connection, connectionId: 'old' }
  h.context.document = { querySelector: () => ({ value: 'destination', close: () => closed++ }) }
  h.disconnect()
  assert.equal(closed, 2)
  assert.equal(h.context.folderConnection, null)
  assert.equal(h.state.copySource, null)
  const destination = { connectionId: 'destination', status: 'ready', busy: false }
  h.state.sftpConnections.set('destination', destination)
  h.state.copySource = { connection: h.connection, connectionId: 'old' }
  await h.context.submitRemoteCopy({ preventDefault () {} })
  assert.equal(h.connection.busy, false)
  await h.reconnect()
  h.context.folderConnection = h.connection
  h.context.folderConnectionId = 'old'
  await h.context.submitSftpDirectory({ preventDefault () {} })
  await h.context.submitRemoteCopy({ preventDefault () {} })
  assert.equal(h.connection.busy, false)
  assert.deepEqual(h.calls, [['connect'], ['list', 'new', '/working']])
})

test('old upload, download, listing, deletion and drop callbacks never replay work or clear a replacement task', async () => {
  for (const [fn, method, argument, result] of [
    ['uploadSftpFile', 'upload', null, { canceled: false, results: [] }],
    ['downloadSftpFile', 'download', '/file', {}],
    ['refreshSftp', 'list', '/other', { path: '/other', entries: [] }],
    ['removeSftpEntry', 'remove', '/file', true],
    ['uploadDroppedFiles', 'uploadFiles', [{}], []]
  ]) {
    const h = rendererFixture()
    let finish
    h.api.sftp[method] = () => new Promise(resolve => { finish = resolve })
    const pending = fn === 'uploadDroppedFiles' ? h.context[fn](h.connection, argument) : argument ? h.context[fn](argument, h.connection) : h.context[fn](h.connection)
    h.disconnect()
    // 模拟同一栏已经恢复并开始新操作；旧回执不得修改新通道状态或再发起目录请求。
    h.state.sftpConnections.delete('old')
    h.connection.connectionId = 'new'
    h.connection.status = 'ready'
    h.connection.busy = true
    h.state.sftpConnections.set('new', h.connection)
    const noticeCount = h.notices.length
    finish(result)
    await pending
    assert.equal(h.connection.busy, true, fn)
    assert.equal(h.connection.path, '/working', fn)
    assert.equal(h.notices.length, noticeCount, fn)
    assert.deepEqual(h.calls, [], fn)
  }
})

test('late cross-server copy releases the surviving endpoint but never unlocks the reconnected endpoint', async () => {
  const h = rendererFixture()
  const destination = { connectionId: 'destination', title: 'Destination', path: '/to', status: 'ready', busy: false }
  h.state.sftpConnections.set('destination', destination)
  h.state.copySource = { connection: h.connection, connectionId: 'old', path: '/working/file', name: 'file' }
  h.context.document = { querySelector: () => ({ value: 'destination', close () {} }) }
  let finish
  h.api.sftp.copyBetween = () => new Promise(resolve => { finish = resolve })
  const pending = h.context.submitRemoteCopy({ preventDefault () {} })
  assert.equal(destination.busy, true)
  h.disconnect()
  await h.reconnect()
  h.connection.busy = true
  const calls = h.calls.length
  finish({})
  await pending
  assert.equal(h.connection.busy, true)
  assert.equal(destination.busy, false)
  assert.equal(h.calls.length, calls, 'old copy must not trigger a new directory read')
})

test('late local upload result cannot refresh or unlock a replacement connection', async () => {
  const h = rendererFixture()
  h.context.localUploading = false
  h.context.syncLocalActions = () => {}
  h.context.document = { querySelector: () => ({ classList: { remove () {} }, replaceChildren () {}, append () {} }), createElement: () => ({}) }
  let finish
  h.api.local = { upload: () => new Promise(resolve => { finish = resolve }) }
  const pending = h.context.uploadLocalSelection([h.connection], ['file-token'])
  h.disconnect()
  await h.reconnect()
  h.connection.busy = true
  const calls = h.calls.length
  finish([{ success: true, name: 'file' }])
  await pending
  assert.equal(h.connection.busy, true)
  assert.equal(h.calls.length, calls)
})
