'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const vm = require('node:vm')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const source = readFileSync(path.join(__dirname, '../src/main.js'), 'utf8')

/** 执行真实快捷键入口，用混排/失效标签验证选择，不替换排序规则，也不提供连接创建能力。 */
function harness () {
  const calls = []
  const state = {
    sessions: new Map([['a', { id: 'a' }], ['b', { id: 'b', status: 'exited' }]]),
    sftpConnections: new Map([['s', { connectionId: 's' }]]),
    activeSessionId: 'a',
    sftpActive: false,
    sftp: null,
    filesOpen: true
  }
  let modal = false
  let sidebarHidden = false
  const context = vm.createContext({
    state,
    tabOrder: ['ssh:b', 'files:local', 'ssh:a', 'sftp:s', 'ssh:closed'],
    tabPointer: null,
    profileDrag: null,
    document: { querySelector: selector => selector === 'dialog[open]' ? modal : { classList: { contains: () => sidebarHidden } } },
    elements: { tabs: { querySelector: selector => ({ scrollIntoView: () => calls.push(['reveal', selector]), querySelector: () => ({ focus: () => calls.push(['focus', selector]) }) }) } },
    activateSession: id => { state.sftpActive = false; state.activeSessionId = id; calls.push(['ssh', id]) },
    activateSftp: id => { state.sftpActive = true; state.sftp = state.sftpConnections.get(id); calls.push(['sftp', id]) },
    openFileWorkspace: () => { state.sftpActive = true; state.sftp = null; calls.push(['local']) },
    setSidebarHidden: hidden => { sidebarHidden = hidden; calls.push(['sidebar', hidden]) },
    closeActiveSession: async () => calls.push(['close']),
    notify: message => calls.push(['notify', message]),
    errorMessage: error => error.message
  })
  for (const name of ['switchTab', 'handleAppAction']) {
    const start = source.indexOf(`function ${name} (`)
    assert.notEqual(start, -1)
    vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), context)
  }
  return { context, state, calls, setModal: value => { modal = value } }
}

test('previous/next follows dragged mixed order, wraps and reveals the selected tab without connecting', () => {
  const h = harness()
  h.context.handleAppAction('next-tab')
  assert.equal(h.state.sftp.connectionId, 's')
  h.context.handleAppAction('next-tab')
  assert.equal(h.state.activeSessionId, 'b')
  h.context.handleAppAction('previous-tab')
  assert.equal(h.state.sftp.connectionId, 's')
  h.context.handleAppAction('previous-tab')
  assert.equal(h.state.activeSessionId, 'a')
  h.context.handleAppAction('previous-tab')
  assert.equal(h.state.sftp, null)
  assert.equal(h.state.sftpActive, true)
  assert.equal(h.calls.filter(call => call[0] === 'reveal').length, 5)
  assert.deepEqual(h.context.tabOrder, ['ssh:b', 'files:local', 'ssh:a', 'sftp:s', 'ssh:closed'])
})

test('numbered shortcuts select visual positions, 9 means last and absent positions are no-ops', () => {
  const h = harness()
  for (const [action, expected] of [['tab-1', ['ssh', 'b']], ['tab-2', ['local']], ['tab-3', ['ssh', 'a']], ['tab-9', ['sftp', 's']]]) {
    h.calls.length = 0
    h.context.handleAppAction(action)
    assert.deepEqual(h.calls[0], expected)
  }
  h.calls.length = 0
  for (const action of ['tab-5', 'tab-8', 'tab-0', 'tab-10', 'unknown']) h.context.handleAppAction(action)
  assert.deepEqual(h.calls, [])
  h.state.sftpConnections.clear()
  h.context.handleAppAction('tab-9')
  assert.deepEqual(h.calls[0], ['ssh', 'a'])
})

test('shortcuts respect dialogs and active drag gestures; sidebar toggle never switches sessions', () => {
  const h = harness()
  for (const barrier of ['modal', 'tabPointer', 'profileDrag']) {
    if (barrier === 'modal') h.setModal(true)
    else h.context[barrier] = {}
    for (const action of ['previous-tab', 'next-tab', 'tab-1', 'tab-9', 'toggle-sidebar']) h.context.handleAppAction(action)
    assert.deepEqual(h.calls, [])
    h.setModal(false)
    h.context.tabPointer = null
    h.context.profileDrag = null
  }
  h.context.handleAppAction('toggle-sidebar')
  h.context.handleAppAction('toggle-sidebar')
  assert.deepEqual(h.calls, [['sidebar', true], ['sidebar', false]])
  assert.equal(h.state.activeSessionId, 'a')
})

test('empty and stale active selections are handled without touching closed sessions', () => {
  const h = harness()
  h.state.activeSessionId = 'missing'
  h.context.switchTab('previous-tab')
  assert.deepEqual(h.calls[0], ['sftp', 's'])
  h.state.sftpActive = false
  h.state.activeSessionId = 'missing'
  h.context.switchTab('next-tab')
  assert.equal(h.state.activeSessionId, 'b')
  h.state.sessions.clear()
  h.state.sftpConnections.clear()
  h.state.filesOpen = false
  h.calls.length = 0
  for (const action of ['previous-tab', 'next-tab', 'tab-1', 'tab-9']) h.context.switchTab(action)
  assert.deepEqual(h.calls, [])
})
