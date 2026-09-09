'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const vm = require('node:vm')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const source = readFileSync(path.join(__dirname, '../src/main.js'), 'utf8')

/** 执行真实连接/关闭函数，桩只代替 DOM 和 IPC，检查异步完成不会抢焦点。 */
function harness () {
  const pending = new Map()
  const closed = []
  const state = { sftpConnections: new Map(), sftpConnecting: new Set(), sftp: null, sftpActive: true }
  const columns = { scrollLeft: 600, getBoundingClientRect: () => ({ left: 0 }), querySelectorAll: () => [], scrollTo () { assert.fail('no anchor should scroll') } }
  const context = vm.createContext({
    state,
    tabOrder: [],
    uploadTargets: new Set(),
    profileById: id => ({ id, name: id, auth: 'key' }),
    createRemotePane: connection => { connection.ui = { pane: { remove () {}, querySelector: () => ({}) } } },
    animateSurface () {},
    setSftpBusy () {},
    renderSftpFiles () {},
    renderTabs () {},
    renderRemoteChoices () {},
    renderProfiles () {},
    syncWorkspaceState () {},
    notify () {},
    errorMessage: error => error.message,
    activateSftp: id => { state.sftp = state.sftpConnections.get(id) },
    api: { sftp: { connect: id => new Promise(resolve => pending.set(id, resolve)), close: async id => closed.push(id), cancelConnect: async () => {} } },
    document: { querySelector: () => columns }
  })
  vm.runInContext(source.slice(source.indexOf('function prepareSftp ('), source.indexOf('async function refreshSftpAfterOperation (')), context)
  vm.runInContext(source.slice(source.indexOf('async function closeSftp ('), source.indexOf('/** 本地多文件拖放')), context)
  return { context, state, pending, closed, columns }
}

test('all placeholders exist before handshake and reverse completions preserve focus/order', async () => {
  const h = harness()
  const a = h.context.prepareSftp('a')
  const b = h.context.prepareSftp('b')
  assert.equal(h.state.sftpConnections.size, 2)
  assert.equal(a.status, 'queued')
  const first = h.context.connectSftp('a', { connection: a })
  const second = h.context.connectSftp('b', { connection: b, activate: false })
  assert.equal(a.status, 'connecting')
  assert.equal(b.status, 'connecting')
  h.pending.get('b')({ connectionId: 'remote-b', path: '/', entries: [] })
  await second
  assert.equal(h.state.sftp, a)
  h.pending.get('a')({ connectionId: 'remote-a', path: '/', entries: [] })
  await first
  assert.equal(h.state.sftp, a)
  assert.deepEqual([...h.state.sftpConnections.keys()], ['remote-a', 'remote-b'])
  assert.equal(h.columns.scrollLeft, 600)
})

test('closing a background pane or current pane keeps position and selects only its neighbor', async () => {
  const h = harness()
  const connections = ['a', 'b', 'c', 'd'].map(id => h.context.prepareSftp(id))
  h.state.sftp = connections[0]
  await h.context.closeSftp(connections[3])
  assert.equal(h.state.sftp, connections[0])
  await h.context.closeSftp(connections[0])
  assert.equal(h.state.sftp, connections[1])
  assert.equal(h.columns.scrollLeft, 600)
})

test('a closed pending pane never reappears and late native success is released', async () => {
  const h = harness()
  const connection = h.context.prepareSftp('a')
  const running = h.context.connectSftp('a', { connection })
  await h.context.closeSftp(connection)
  h.pending.get('a')({ connectionId: 'late-success', path: '/', entries: [] })
  await running
  assert.equal(h.state.sftpConnections.size, 0)
  assert.deepEqual(h.closed, ['late-success'])
})
