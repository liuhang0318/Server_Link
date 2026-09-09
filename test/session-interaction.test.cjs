'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const vm = require('node:vm')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const source = readFileSync(path.join(__dirname, '../src/main.js'), 'utf8')

/** 执行真实关闭流程，延迟 IPC 用于模拟原生进程仍在退出时用户继续切换标签。 */
function closeHarness (order, active = 'a') {
  const pending = new Map()
  const activated = []
  const disposed = []
  const remote = { connectionId: 'r' }
  const state = {
    sessions: new Map(['a', 'b', 'c'].map(id => [id, { id, profileId: id, status: 'running', terminal: { dispose: () => disposed.push(id) }, container: { remove () {} } }])),
    sftpConnections: new Map([['r', remote]]),
    activeSessionId: active,
    sftpActive: false,
    sftp: remote,
    filesOpen: true,
    pendingEvents: new Map(),
    retiredSessionIds: new Set()
  }
  const context = vm.createContext({
    state,
    tabOrder: order,
    setTimeout () {},
    renderTabs () {},
    syncWorkspaceState () {},
    activateSession: id => { state.activeSessionId = id; state.sftpActive = false; activated.push(`ssh:${id}`) },
    activateSftp: id => { state.activeSessionId = null; state.sftpActive = true; state.sftp = state.sftpConnections.get(id); activated.push(`sftp:${id}`) },
    openFileWorkspace: () => { state.activeSessionId = null; state.sftpActive = true; state.sftp = null; activated.push('files:local') },
    api: { sessions: { close: id => new Promise(resolve => pending.set(id, resolve)) } }
  })
  vm.runInContext(source.slice(source.indexOf('async function reconnectActiveSession ('), source.indexOf('async function closeActiveSession (')), context)
  return { context, state, pending, activated, disposed }
}

test('SSH close selects its dragged mixed-tab neighbor before native close and never steals later focus', async () => {
  const h = closeHarness(['ssh:c', 'ssh:a', 'sftp:r', 'files:local', 'ssh:b'])
  const session = h.state.sessions.get('a')
  const closing = h.context.removeSession(session, true)
  assert.equal(h.state.sessions.has('a'), false)
  assert.equal(h.state.retiredSessionIds.has('a'), true)
  assert.deepEqual(h.activated, ['sftp:r'])
  await h.context.removeSession(session, true)
  assert.deepEqual(h.disposed, ['a'])
  h.state.activeSessionId = 'b'
  h.state.sftpActive = false
  h.pending.get('a')()
  await closing
  assert.equal(h.state.activeSessionId, 'b')
  assert.deepEqual(h.activated, ['sftp:r'])
})

test('closing a background SSH session preserves the local workspace and its focus', async () => {
  const h = closeHarness(['files:local', 'ssh:a', 'ssh:b'], null)
  h.state.sftpActive = true
  const closing = h.context.removeSession(h.state.sessions.get('a'), true)
  assert.deepEqual(h.activated, [])
  h.pending.get('a')()
  await closing
  assert.equal(h.state.sftpActive, true)
  assert.equal(h.state.activeSessionId, null)
  assert.deepEqual(h.activated, [])
})

test('closing the last visual SSH tab chooses the left local tab, not the newest SSH session', async () => {
  const h = closeHarness(['ssh:c', 'ssh:b', 'files:local', 'ssh:a'])
  h.state.sessions.get('a').status = 'exited'
  await h.context.removeSession(h.state.sessions.get('a'), true)
  assert.deepEqual(h.activated, ['files:local'])
  assert.equal(h.pending.size, 0)
})

/** 延迟创建替代终端，覆盖切走、关闭与创建失败时旧标签的保留语义。 */
function reconnectHarness () {
  const h = closeHarness(['ssh:c', 'ssh:a', 'sftp:r', 'files:local', 'ssh:b'])
  h.context.connectProfile = (profileId, options) => {
    assert.equal(profileId, 'a')
    assert.equal(options.activate, false)
    return new Promise(resolve => {
      h.finishConnect = id => {
        if (id) {
          h.state.sessions.set(id, { id, status: 'running', terminal: { dispose: () => h.disposed.push(id) }, container: { remove () {} } })
          h.context.tabOrder.push(`ssh:${id}`)
        }
        resolve(id)
      }
    })
  }
  return h
}

test('reconnect replaces the original tab in place without changing focus after native shutdown', async () => {
  const h = reconnectHarness()
  const reconnecting = h.context.reconnectActiveSession()
  assert.equal(h.state.sessions.has('a'), true)
  h.finishConnect('replacement')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual([...h.context.tabOrder], ['ssh:c', 'ssh:replacement', 'sftp:r', 'files:local', 'ssh:b'])
  assert.deepEqual(h.activated, ['ssh:replacement'])
  assert.equal(h.state.sessions.has('a'), false)
  h.state.activeSessionId = 'b'
  h.pending.get('a')()
  await reconnecting
  assert.equal(h.state.activeSessionId, 'b')
})

test('switching away while reconnect starts leaves the replacement in the background', async () => {
  const h = reconnectHarness()
  const reconnecting = h.context.reconnectActiveSession()
  h.state.activeSessionId = null
  h.state.sftpActive = true
  h.state.sftp = null
  h.finishConnect('replacement')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(h.activated, [])
  assert.equal(h.state.activeSessionId, null)
  assert.equal(h.state.sftp, null)
  h.pending.get('a')()
  await reconnecting
  assert.deepEqual(h.activated, [])
})

test('closing the original tab during reconnect releases the late replacement', async () => {
  const h = reconnectHarness()
  const reconnecting = h.context.reconnectActiveSession()
  const closing = h.context.removeSession(h.state.sessions.get('a'), true)
  h.pending.get('a')()
  await closing
  h.finishConnect('replacement')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.state.sessions.has('replacement'), false)
  assert.deepEqual(h.activated, ['sftp:r'])
  h.pending.get('replacement')()
  await reconnecting
  assert.deepEqual(h.disposed, ['a', 'replacement'])
})

test('failed replacement creation keeps the original terminal and tab order', async () => {
  const h = reconnectHarness()
  const reconnecting = h.context.reconnectActiveSession()
  h.finishConnect(null)
  await reconnecting
  assert.equal(h.state.sessions.has('a'), true)
  assert.equal(h.state.activeSessionId, 'a')
  assert.deepEqual(h.disposed, [])
  assert.deepEqual([...h.context.tabOrder], ['ssh:c', 'ssh:a', 'sftp:r', 'files:local', 'ssh:b'])
})

/** 最小 DOM 桩模拟 replaceChildren 丢失焦点，验证真实重绘只恢复标签原有焦点。 */
function tabsHarness (focusedKey) {
  const focusCalls = []
  const document = { activeElement: {} }
  class Node {
    constructor () {
      this.dataset = {}
      this.children = []
      this.classList = { toggle () {} }
    }

    setAttribute () {}
    contains (node) { return this.children.includes(node) }
    closest () { return this.dataset.tabKey ? this : null }
    replaceChildren (...children) {
      if (this.contains(document.activeElement)) document.activeElement = {}
      this.children = children
    }

    append (...children) {
      for (const child of children) {
        this.children = this.children.filter(node => node !== child)
        this.children.push(child)
      }
    }

    prepend (child) { this.children.unshift(child) }
    focus (options) { document.activeElement = this; focusCalls.push({ key: this.dataset.tabKey, preventScroll: options.preventScroll }) }
  }
  document.createElement = () => new Node()
  const tabs = new Node()
  tabs.scrollLeft = 420
  if (focusedKey) {
    const previous = new Node()
    previous.dataset.tabKey = focusedKey
    tabs.append(previous)
    document.activeElement = previous
  }
  const externalFocus = document.activeElement
  const remote = { connectionId: 'remote-r', profileId: 'r', title: 'Remote', path: '/', status: 'ready' }
  const state = {
    filesOpen: true,
    sessions: new Map([['a', { id: 'a', title: 'SSH A', status: 'running' }]]),
    sftpConnections: new Map([['remote-r', remote]]),
    activeSessionId: 'a',
    sftp: remote,
    sftpActive: false
  }
  const context = vm.createContext({
    document,
    elements: { tabs },
    state,
    tabOrder: ['ssh:a', 'files:local', 'sftp:remote-r'],
    tabPointer: null,
    createButton: () => new Node(),
    openFileWorkspace () {},
    bindSftpDropTarget () {}
  })
  vm.runInContext(source.slice(source.indexOf('function renderTabs ('), source.indexOf('/** 根据指针位置预览')), context)
  return { context, state, tabs, document, externalFocus, focusCalls }
}

test('tab repaint preserves keyboard focus and horizontal position when a pending SFTP ID changes', () => {
  const h = tabsHarness('sftp:pending:r')
  h.context.renderTabs()
  assert.equal(h.document.activeElement.dataset.tabKey, 'sftp:remote-r')
  assert.deepEqual(h.focusCalls, [{ key: 'sftp:remote-r', preventScroll: true }])
  assert.equal(h.tabs.scrollLeft, 420)
  assert.equal(h.state.activeSessionId, 'a')
})

test('background tab repaint never steals input focus from outside the tab bar', () => {
  const h = tabsHarness(null)
  h.context.renderTabs()
  assert.equal(h.document.activeElement, h.externalFocus)
  assert.deepEqual(h.focusCalls, [])
})
