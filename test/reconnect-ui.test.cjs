'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const vm = require('node:vm')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const source = readFileSync(path.join(__dirname, '../src/main.js'), 'utf8')

/** 延迟原生 start，直接运行真实重连/创建/关闭流程，检查等待期间的新选择优先于旧操作。 */
function harness () {
  const starts = []
  const closed = []
  const disposed = []
  const activated = []
  const presentations = []
  const notices = []
  const writes = []
  const profile = { id: 'profile-old', name: 'Old server' }
  const makeSession = (id, profileId = id, status = 'running') => ({
    id,
    profileId,
    status,
    connected: status === 'exited',
    terminal: { dispose: () => disposed.push(id) },
    container: { remove () {} }
  })
  const session = makeSession('old', profile.id, 'exited')
  const state = {
    profiles: [profile],
    sessions: new Map([['before', makeSession('before')], ['old', session], ['after', makeSession('after')]]),
    activeSessionId: 'old',
    sftpActive: false,
    sftpConnections: new Map(),
    connectingProfiles: new Set(),
    pendingEvents: new Map(),
    retiredSessionIds: new Set(),
    filesOpen: true
  }
  const context = vm.createContext({
    state,
    tabOrder: ['ssh:before', 'ssh:old', 'files:local', 'ssh:after'],
    tabPointer: null,
    profileById: id => state.profiles.find(item => item.id === id),
    setTimeout () {},
    renderProfiles () {},
    renderTabs () {},
    syncWorkspaceState () {},
    syncTerminalPresentation: item => presentations.push({ id: item.id, reconnecting: Boolean(item.reconnecting) }),
    createTerminalSession: (id, values) => {
      const replacement = makeSession(id, values.id)
      state.sessions.set(id, replacement)
      return replacement
    },
    activateSession: id => { state.activeSessionId = id; state.sftpActive = false; activated.push(`ssh:${id}`) },
    activateSftp: id => { state.activeSessionId = null; state.sftpActive = true; activated.push(`sftp:${id}`) },
    openFileWorkspace: () => { state.activeSessionId = null; state.sftpActive = true; activated.push('files:local') },
    notify: (message, error) => notices.push({ message, error }),
    errorMessage: error => error.message,
    api: {
      sessions: {
        start: id => new Promise((resolve, reject) => starts.push({ id, resolve, reject })),
        close: async id => closed.push(id),
        // 重连只新建会话，任何把旧终端内容当命令再发的路径都必须令回归失败。
        write: (...args) => { writes.push(args); assert.fail('reconnect must never replay terminal input') }
      }
    }
  })
  for (const name of ['connectProfile', 'reconnectSession', 'removeSession']) {
    const start = source.indexOf(`async function ${name} (`)
    assert.notEqual(start, -1, `${name} must exist in renderer`)
    vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), context)
  }
  return { context, state, session, starts, closed, disposed, activated, presentations, notices, writes }
}

test('reconnect synchronously disables repeat clicks and replaces only the disconnected tab in place', async () => {
  const h = harness()
  const reconnecting = h.context.reconnectSession(h.session)
  assert.equal(h.session.reconnecting, true)
  assert.deepEqual(h.presentations, [{ id: 'old', reconnecting: true }])
  await h.context.reconnectSession(h.session)
  assert.equal(h.starts.length, 1)
  assert.equal(h.starts[0].id, 'profile-old')
  assert.equal(h.state.sessions.get('old'), h.session)
  h.starts[0].resolve({ sessionId: 'replacement' })
  await reconnecting
  assert.deepEqual(Array.from(h.context.tabOrder), ['ssh:before', 'ssh:replacement', 'files:local', 'ssh:after'])
  assert.equal(h.state.sessions.has('old'), false)
  assert.equal(h.state.sessions.has('replacement'), true)
  assert.equal(h.state.activeSessionId, 'replacement')
  assert.equal(h.session.reconnecting, false)
  assert.deepEqual(h.activated, ['ssh:replacement'])
  assert.deepEqual(h.disposed, ['old'])
  assert.deepEqual(h.closed, [])
  assert.deepEqual(h.writes, [])
})

test('reconnect completion respects a newly dragged position and never steals a different SSH focus', async () => {
  const h = harness()
  const reconnecting = h.context.reconnectSession(h.session)
  h.context.tabOrder = ['ssh:after', 'files:local', 'ssh:old', 'ssh:before']
  h.state.activeSessionId = 'after'
  h.starts[0].resolve({ sessionId: 'replacement' })
  await reconnecting
  assert.deepEqual(Array.from(h.context.tabOrder), ['ssh:after', 'files:local', 'ssh:replacement', 'ssh:before'])
  assert.equal(h.state.activeSessionId, 'after')
  assert.deepEqual(h.activated, [])
  assert.deepEqual(h.writes, [])
})

test('reconnect during a live drag migrates its node and cancellation snapshot without disturbing the gesture', async () => {
  for (const draggedKey of ['ssh:old', 'ssh:before']) {
    const h = harness()
    const reconnecting = h.context.reconnectSession(h.session)
    const node = { dataset: { tabKey: 'ssh:old' } }
    const drag = { key: draggedKey, originalOrder: [...h.context.tabOrder, 'ssh:replacement'] }
    h.context.tabPointer = drag
    h.context.tabOrder = ['ssh:after', 'files:local', 'ssh:old', 'ssh:before']
    h.context.elements = {
      tabs: {
        querySelector: selector => selector === `[data-tab-key="${node.dataset.tabKey}"]` ? node : null,
        classList: { remove () {} },
        hasPointerCapture: () => false
      }
    }
    h.starts[0].resolve({ sessionId: 'replacement' })
    await reconnecting
    assert.equal(h.context.tabPointer, drag)
    assert.equal(drag.key, draggedKey === 'ssh:old' ? 'ssh:replacement' : draggedKey)
    assert.equal(node.dataset.tabKey, 'ssh:replacement')
    assert.deepEqual(Array.from(h.context.tabOrder), ['ssh:after', 'files:local', 'ssh:replacement', 'ssh:before'])
    assert.deepEqual(Array.from(drag.originalOrder), ['ssh:before', 'ssh:replacement', 'files:local', 'ssh:after'])
    // 用真实 Escape 收尾路径确认撤销只恢复位置，不再恢复已退役的会话 ID。
    h.context.tabDragFrame = null
    const start = source.indexOf('function finishTabDrag (')
    assert.notEqual(start, -1)
    vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), h.context)
    h.context.finishTabDrag(true)
    assert.equal(h.context.tabPointer, null)
    assert.deepEqual(Array.from(h.context.tabOrder), ['ssh:before', 'ssh:replacement', 'files:local', 'ssh:after'])
  }
})

test('switching to SFTP while reconnecting keeps the file workspace active', async () => {
  const h = harness()
  const reconnecting = h.context.reconnectSession(h.session)
  h.state.sftpActive = true
  h.starts[0].resolve({ sessionId: 'replacement' })
  await reconnecting
  assert.equal(h.state.sftpActive, true)
  assert.notEqual(h.state.activeSessionId, 'replacement')
  assert.deepEqual(h.activated, [])
})

test('a replacement already added by another tab repaint is not duplicated', async () => {
  const h = harness()
  const reconnecting = h.context.reconnectSession(h.session)
  h.context.tabOrder.push('ssh:replacement')
  h.starts[0].resolve({ sessionId: 'replacement' })
  await reconnecting
  assert.deepEqual(Array.from(h.context.tabOrder), ['ssh:before', 'ssh:replacement', 'files:local', 'ssh:after'])
})

test('closing the old tab while start is pending releases the late replacement without reopening it', async () => {
  const h = harness()
  const reconnecting = h.context.reconnectSession(h.session)
  await h.context.removeSession(h.session, true)
  assert.equal(h.state.sftpActive, true)
  assert.deepEqual(h.activated, ['files:local'])
  h.starts[0].resolve({ sessionId: 'replacement' })
  await reconnecting
  assert.equal(h.state.sessions.has('old'), false)
  assert.equal(h.state.sessions.has('replacement'), false)
  assert.deepEqual(h.closed, ['replacement'])
  assert.deepEqual(h.disposed, ['old', 'replacement'])
  assert.deepEqual(h.activated, ['files:local'])
  assert.equal(h.state.sftpActive, true)
  assert.deepEqual(h.presentations, [{ id: 'old', reconnecting: true }])
})

test('native start rejection preserves the disconnected terminal and restores the retry button', async () => {
  const h = harness()
  const reconnecting = h.context.reconnectSession(h.session)
  h.starts[0].reject(new Error('native start failed'))
  await reconnecting
  assert.equal(h.state.sessions.get('old'), h.session)
  assert.equal(h.state.activeSessionId, 'old')
  assert.equal(h.session.reconnecting, false)
  assert.equal(h.state.connectingProfiles.size, 0)
  assert.deepEqual(h.presentations, [{ id: 'old', reconnecting: true }, { id: 'old', reconnecting: false }])
  assert.deepEqual(h.disposed, [])
  assert.deepEqual(h.activated, [])
  assert.ok(h.notices.some(notice => notice.message.includes('native start failed')))
})

test('failed renderer construction closes its native session and keeps the original available for retry', async () => {
  const h = harness()
  h.context.createTerminalSession = () => { throw new Error('terminal construction failed') }
  const reconnecting = h.context.reconnectSession(h.session)
  h.starts[0].resolve({ sessionId: 'replacement' })
  await reconnecting
  assert.deepEqual(h.closed, ['replacement'])
  assert.equal(h.state.sessions.get('old'), h.session)
  assert.equal(h.session.reconnecting, false)
  assert.deepEqual(h.disposed, [])
  assert.deepEqual(h.writes, [])
})

test('unexpected reconnect rejection still restores the button without losing the original session', async () => {
  const h = harness()
  h.context.connectProfile = async () => { throw new Error('unexpected failure') }
  await assert.doesNotReject(h.context.reconnectSession(h.session))
  assert.equal(h.state.sessions.get('old'), h.session)
  assert.equal(h.session.reconnecting, false)
  assert.deepEqual(h.presentations, [{ id: 'old', reconnecting: true }, { id: 'old', reconnecting: false }])
  assert.deepEqual(h.disposed, [])
  assert.deepEqual(h.closed, [])
})

test('another pending connection for the same profile does not start a duplicate or strand the retry button', async () => {
  const h = harness()
  h.state.connectingProfiles.add(h.session.profileId)
  await h.context.reconnectSession(h.session)
  assert.deepEqual(h.starts, [])
  assert.deepEqual(h.presentations, [])
  assert.notEqual(h.session.reconnecting, true)
  assert.equal(h.state.sessions.get('old'), h.session)
  assert.equal(h.notices.length, 1)
})

test('connected, connecting, closing and stale sessions cannot trigger reconnect', async () => {
  for (const status of ['running', 'closing']) {
    const h = harness()
    h.session.status = status
    for (const connected of [true, false]) {
      h.session.connected = connected
      await h.context.reconnectSession(h.session)
    }
    assert.deepEqual(h.starts, [])
    assert.deepEqual(h.presentations, [])
  }
  const h = harness()
  h.state.sessions.set('old', { ...h.session })
  await h.context.reconnectSession(h.session)
  assert.deepEqual(h.starts, [])
  assert.deepEqual(h.presentations, [])
})

test('a deleted connection profile reports the issue without starting or discarding the old terminal', async () => {
  const h = harness()
  h.state.profiles = []
  await h.context.reconnectSession(h.session)
  assert.deepEqual(h.starts, [])
  assert.equal(h.state.sessions.get('old'), h.session)
  assert.notEqual(h.session.reconnecting, true)
  assert.equal(h.notices.length, 1)
  assert.deepEqual(h.disposed, [])
})

test('real terminal input drops disconnected keystrokes but preserves one-shot handshake and connected input', () => {
  const writes = []
  const predicted = []
  let input
  const session = { status: 'exited', connected: true, typeahead: { input: data => predicted.push(data), reset () {} } }
  const context = vm.createContext({
    session,
    sessionId: 'old',
    terminal: { onData: listener => { input = listener }, writeln: message => assert.fail(message) },
    api: { sessions: { write: async (id, data) => writes.push({ id, data }) } },
    errorMessage: error => error.message
  })
  const start = source.indexOf('session.inputDisposable = terminal.onData(data => {')
  assert.notEqual(start, -1)
  // 执行原始输入回调而不是复刻判断，保证修复不能悄悄改成离线缓存后重放。
  vm.runInContext(source.slice(start, source.indexOf('\n  })', start) + 5), context)
  input('offline command\r')
  session.status = 'closing'
  input('late key')
  assert.deepEqual(writes, [])
  assert.deepEqual(predicted, [])
  session.status = 'running'
  session.connected = false
  input('handshake secret\r')
  assert.deepEqual(predicted, [])
  session.connected = true
  input('ls\r')
  assert.deepEqual(writes, [{ id: 'old', data: 'handshake secret\r' }, { id: 'old', data: 'ls\r' }])
  assert.deepEqual(predicted, ['ls\r'])
})
