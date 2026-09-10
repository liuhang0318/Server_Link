'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const vm = require('node:vm')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const source = readFileSync(path.join(__dirname, '../src/main.js'), 'utf8')

/** 直接执行渲染层函数；未完成的 IPC 留给测试手动释放，检查关闭不等待网络才更新 UI。 */
function harness ({ ids = ['a', 'b', 'c'], active = 'a', order = ['ssh:a', 'files:local', 'ssh:b', 'ssh:c'], connections = [] } = {}) {
  const calls = []
  const pending = []
  const activated = []
  const notices = []
  const removed = []
  const snapshots = []
  const panes = []
  const state = {
    sessions: new Map(ids.map(id => [id, { id }])),
    activeSessionId: active,
    sftpActive: active === null,
    filesOpen: true,
    sftp: null,
    sftpConnections: new Map(),
    sftpConnecting: new Set()
  }
  for (const [index, values] of connections.entries()) {
    const connection = { status: 'ready', busy: false, profileId: `profile-${index}`, connectionId: `remote-${index}`, ...values }
    const pane = {
      removed: false,
      getBoundingClientRect: () => ({ left: index * 480, right: (index + 1) * 480 }),
      remove () { this.removed = true; removed.push(connection.connectionId) }
    }
    panes.push(pane)
    connection.ui = { pane }
    state.sftpConnections.set(connection.connectionId, connection)
  }
  const columns = {
    scrollLeft: 480,
    getBoundingClientRect: () => ({ left: 0 }),
    querySelectorAll: () => panes.filter(pane => !pane.removed),
    scrollTo ({ left }) { this.scrollLeft = left }
  }
  const uploadTargets = new Set(state.sftpConnections.keys())
  // 每个调用立即记录但不自动完成，串行逐台关闭会在断言中漏掉后续连接。
  const ipc = (kind, id) => {
    calls.push({ kind, id })
    return new Promise(resolve => pending.push(resolve))
  }
  const context = vm.createContext({
    state,
    tabOrder: order,
    uploadTargets,
    document: { querySelector: () => columns },
    renderTabs () {},
    renderRemoteChoices () {},
    renderProfiles () {},
    syncWorkspaceState: () => snapshots.push({ filesOpen: state.filesOpen, active: state.activeSessionId, sftpActive: state.sftpActive }),
    notify: message => notices.push(message),
    activateSession: id => { state.activeSessionId = id; state.sftpActive = false; activated.push(id) },
    api: { sftp: { close: id => ipc('close', id), cancelConnect: id => ipc('cancel', id) } }
  })
  // 顶层函数的闭括号顶格书写，不复制关闭逻辑，也不依赖两个函数在文件中的相邻关系。
  for (const name of ['closeSftp', 'closeFileWorkspace']) {
    const start = source.indexOf(`async function ${name} (`)
    assert.notEqual(start, -1, `${name} must exist in renderer`)
    const end = source.indexOf('\n}', start) + 2
    vm.runInContext(source.slice(start, end), context)
  }
  return { context, state, calls, activated, notices, removed, snapshots, uploadTargets, resolveAll: () => pending.splice(0).forEach(resolve => resolve()) }
}

test('closing the background file workspace disconnects its SFTP without changing the active SSH', async () => {
  const h = harness({ active: 'b', connections: [{ busy: true }] })
  h.state.sftp = h.state.sftpConnections.get('remote-0')
  const closing = h.context.closeFileWorkspace()
  assert.equal(h.state.filesOpen, false)
  assert.equal(h.state.sftp, null)
  assert.equal(h.state.sftpActive, false)
  assert.equal(h.state.activeSessionId, 'b')
  assert.equal(h.state.sftpConnections.size, 0)
  assert.deepEqual(h.activated, [])
  assert.deepEqual(h.calls, [{ kind: 'close', id: 'remote-0' }])
  h.resolveAll()
  await closing
  assert.equal(h.state.activeSessionId, 'b')
  assert.deepEqual([...h.state.sessions.keys()], ['a', 'b', 'c'])
})

test('closing the active file workspace selects the right surviving SSH in dragged tab order', async () => {
  const h = harness({ active: null, order: ['ssh:a', 'files:local', 'sftp:remote-0', 'ssh:removed', 'ssh:c', 'ssh:b'], connections: [{}] })
  const closing = h.context.closeFileWorkspace()
  assert.deepEqual(h.activated, ['c'])
  assert.equal(h.state.activeSessionId, 'c')
  assert.equal(h.state.sftpActive, false)
  assert.equal(h.state.filesOpen, false)
  h.resolveAll()
  await closing
})

test('closing a file workspace without a right SSH uses its nearest left SSH', async () => {
  const h = harness({ active: null, order: ['ssh:c', 'ssh:b', 'ssh:a', 'files:local', 'sftp:remote-0'], connections: [{}] })
  h.state.sftp = h.state.sftpConnections.get('remote-0')
  const closing = h.context.closeFileWorkspace()
  assert.deepEqual(h.activated, ['a'])
  h.resolveAll()
  await closing
})

test('closing the only file workspace shows the empty view before the native close finishes', async () => {
  const h = harness({ ids: [], active: null, order: ['files:local', 'sftp:remote-0'], connections: [{}] })
  const closing = h.context.closeFileWorkspace()
  assert.equal(h.state.filesOpen, false)
  assert.equal(h.state.sftp, null)
  assert.equal(h.state.sftpActive, false)
  assert.equal(h.state.activeSessionId, null)
  assert.ok(h.snapshots.some(snapshot => !snapshot.filesOpen && !snapshot.sftpActive && snapshot.active === null))
  assert.deepEqual(h.activated, [])
  h.resolveAll()
  await closing
})

test('workspace close issues every ready/busy close and pending/queued cancellation concurrently', async () => {
  const h = harness({ connections: [{}, { busy: true }, { status: 'connecting' }, { status: 'queued' }] })
  const closing = h.context.closeFileWorkspace()
  assert.equal(h.state.sftpConnections.size, 0)
  assert.equal(h.uploadTargets.size, 0)
  assert.deepEqual(h.removed, ['remote-0', 'remote-1', 'remote-2', 'remote-3'])
  assert.deepEqual(h.calls, [
    { kind: 'close', id: 'remote-0' },
    { kind: 'close', id: 'remote-1' },
    { kind: 'cancel', id: 'profile-2' },
    { kind: 'cancel', id: 'profile-3' }
  ])
  assert.deepEqual(h.notices, [])
  h.resolveAll()
  await closing
})

test('late workspace close completion cannot hide a reopened workspace or steal its new selection', async () => {
  const h = harness({ active: null, connections: [{ busy: true }] })
  const closing = h.context.closeFileWorkspace()
  assert.deepEqual(h.activated, ['b'])
  // 用户在原生断开期间重新打开文件工作区；旧关闭只能处理调用时捕获的连接。
  const fresh = { connectionId: 'fresh', profileId: 'new-profile', status: 'ready' }
  h.state.filesOpen = true
  h.state.activeSessionId = null
  h.state.sftpActive = true
  h.state.sftp = fresh
  h.state.sftpConnections.set(fresh.connectionId, fresh)
  h.resolveAll()
  await closing
  assert.equal(h.state.filesOpen, true)
  assert.equal(h.state.sftpActive, true)
  assert.equal(h.state.activeSessionId, null)
  assert.equal(h.state.sftp, fresh)
  assert.deepEqual([...h.state.sftpConnections.keys()], ['fresh'])
  assert.deepEqual(h.activated, ['b'])
  assert.deepEqual(h.calls, [{ kind: 'close', id: 'remote-0' }])
})

test('default close protects an active transfer while explicit force removes it immediately', async () => {
  const h = harness({ connections: [{ busy: true }] })
  const connection = h.state.sftpConnections.get('remote-0')
  h.state.sftp = connection
  await h.context.closeSftp(connection)
  assert.equal(h.state.sftpConnections.get(connection.connectionId), connection)
  assert.equal(h.notices.length, 1)
  assert.deepEqual(h.calls, [])
  const closing = h.context.closeSftp(connection, { force: true })
  assert.equal(h.state.sftpConnections.size, 0)
  assert.equal(h.state.sftp, null)
  assert.deepEqual(h.calls, [{ kind: 'close', id: 'remote-0' }])
  h.resolveAll()
  await closing
})

test('repeated workspace/remote close is idempotent and stale identity cannot close a replacement', async () => {
  const h = harness({ connections: [{ busy: true }] })
  const original = h.state.sftpConnections.get('remote-0')
  const closing = h.context.closeFileWorkspace()
  await h.context.closeFileWorkspace()
  await h.context.closeSftp(original, { force: true })
  assert.deepEqual(h.removed, ['remote-0'])
  assert.deepEqual(h.calls, [{ kind: 'close', id: 'remote-0' }])
  const replacement = { ...original }
  h.state.sftpConnections.set(replacement.connectionId, replacement)
  await h.context.closeSftp(original, { force: true })
  assert.equal(h.state.sftpConnections.get(replacement.connectionId), replacement)
  assert.deepEqual(h.calls, [{ kind: 'close', id: 'remote-0' }])
  h.resolveAll()
  await closing
})
