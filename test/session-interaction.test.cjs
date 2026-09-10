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
  vm.runInContext(source.slice(source.indexOf('async function removeSession ('), source.indexOf('async function closeActiveSession (')), context)
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

/** 最小 DOM 桩模拟 replaceChildren 丢失焦点，验证真实重绘只恢复标签原有焦点。 */
function tabsHarness (focusedKey) {
  const focusCalls = []
  const closed = []
  const activated = []
  const document = { activeElement: {}, querySelector: () => ({ disabled: false }) }
  class Node {
    constructor (tag = 'div') {
      this.tagName = tag
      this.dataset = {}
      this.children = []
      this.events = {}
      this.classList = { toggle () {} }
    }

    setAttribute (key, value) { this[key] = value }
    addEventListener (type, listener) { this.events[type] = listener }
    contains (node) { return node === this || this.children.some(child => child.contains(node)) }
    closest (selector) {
      const match = selector === '[data-tab-key]' ? this.dataset.tabKey : this.className?.split(' ').includes(selector.slice(1))
      return match ? this : this.parent?.closest(selector)
    }

    querySelector (selector) {
      for (const child of this.children) {
        if (child.className?.split(' ').includes(selector.slice(1))) return child
        const match = child.querySelector(selector)
        if (match) return match
      }
      return null
    }

    replaceChildren (...children) {
      if (this.contains(document.activeElement)) document.activeElement = {}
      this.children = []
      this.append(...children)
    }

    append (...children) {
      for (const child of children) {
        this.children = this.children.filter(node => node !== child)
        child.parent = this
        this.children.push(child)
      }
    }

    prepend (child) { child.parent = this; this.children.unshift(child) }
    focus (options) { document.activeElement = this; focusCalls.push({ key: this.closest('[data-tab-key]')?.dataset.tabKey, preventScroll: options.preventScroll }) }
  }
  document.createElement = tag => new Node(tag)
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
    createButton: (text, className, action, label) => {
      const node = new Node('button')
      node.className = className
      node.textContent = text
      node.addEventListener('click', action)
      if (label) node.setAttribute('aria-label', label)
      return node
    },
    activateSession: id => activated.push(id),
    removeSession: async (session, requestClose) => closed.push({ id: session.id, requestClose }),
    notify: message => assert.fail(message),
    errorMessage: error => error.message,
    openFileWorkspace () {},
    bindSftpDropTarget () {},
    tabScrollState: () => ({ canScrollLeft: false, canScrollRight: false })
  })
  vm.runInContext(source.slice(source.indexOf('function setTabContent ('), source.indexOf('/** 根据指针位置预览')), context)
  return { context, state, tabs, document, externalFocus, focusCalls, closed, activated }
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

test('SSH has sibling select/close buttons instead of a visible badge; names remain literal', () => {
  const h = tabsHarness(null)
  const name = '<img src=x> long server name'
  h.state.sessions.get('a').title = name
  h.state.sftpConnections.get('remote-r').title = 'Remote · SFTP'
  h.context.renderTabs()
  const ssh = h.tabs.children.find(tab => tab.dataset.tabKey === 'ssh:a')
  const remote = h.tabs.children.find(tab => tab.dataset.tabKey === 'sftp:remote-r')
  const select = ssh.querySelector('.tab-select')
  const close = ssh.querySelector('.tab-close')
  assert.equal(ssh.tagName, 'div')
  assert.equal(select.tagName, 'button')
  assert.equal(close.tagName, 'button')
  assert.equal(select.contains(close), false)
  assert.equal(ssh.querySelector('.tab-label').textContent, name)
  assert.equal(ssh.querySelector('.tab-kind'), null)
  assert.equal(close.textContent, '×')
  assert.equal(close['aria-label'], `关闭 ${name} · SSH`)
  assert.equal(remote.children.find(node => node.className === 'tab-label').textContent, 'Remote')
  assert.equal(remote.children.find(node => node.className === 'tab-kind').textContent, 'SFTP')
  assert.equal(remote.dataset.kind, 'sftp')
  assert.equal(select['aria-label'], `${name} · SSH`)
  assert.equal(remote['aria-label'], 'Remote · SFTP')
})

test('clicking an SSH close icon stops pointer sorting and closes that session without selecting it', () => {
  const h = tabsHarness(null)
  h.state.activeSessionId = 'another-session'
  h.context.renderTabs()
  const close = h.tabs.children.find(tab => tab.dataset.tabKey === 'ssh:a').querySelector('.tab-close')
  const events = []
  close.events.pointerdown({ preventDefault: () => events.push('prevent'), stopPropagation: () => events.push('stop') })
  close.events.click({ stopPropagation: () => events.push('stop-click') })
  assert.deepEqual(events, ['prevent', 'stop', 'stop-click'])
  assert.deepEqual(h.closed, [{ id: 'a', requestClose: true }])
  assert.deepEqual(h.activated, [])
  assert.equal(h.state.activeSessionId, 'another-session')
  assert.equal(h.document.activeElement, h.externalFocus)
})

test('background tab repaint restores the same close control, not a selection or the terminal', () => {
  const h = tabsHarness(null)
  h.context.renderTabs()
  const before = h.tabs.children.find(tab => tab.dataset.tabKey === 'ssh:a').querySelector('.tab-close')
  before.focus({ preventScroll: true })
  h.context.renderTabs()
  const after = h.tabs.children.find(tab => tab.dataset.tabKey === 'ssh:a').querySelector('.tab-close')
  assert.notEqual(before, after)
  assert.equal(h.document.activeElement, after)
  assert.deepEqual(h.activated, [])
})

test('SSH enables inline echo by default without any toolbar toggle or replay path', () => {
  assert.match(source, /new TerminalTypeahead\(terminal, terminalMount, \{ username: profile.username, enabled: true \}\)/)
  assert.doesNotMatch(source, /typeaheadToggle|typeaheadEnabled|toggle-typeahead/)
  assert.match(source, /api\.sessions\.write\(sessionId, data\)/)
})
