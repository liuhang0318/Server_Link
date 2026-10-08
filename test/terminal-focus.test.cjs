'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const vm = require('node:vm')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const source = readFileSync(path.join(__dirname, '../src/main.js'), 'utf8')

/** 运行真实导航/展示函数；仅桩化 DOM、帧队列和原生 IPC，不连接服务器或发送按键。 */
function harness () {
  const frames = []
  const starts = []
  const focusCalls = []
  let tabRenders = 0
  let modal = false
  const node = () => {
    const classes = new Set()
    return {
      isConnected: true,
      classList: { contains: name => classes.has(name), toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) },
      setAttribute () {},
      contains (target) { return target === this || target?.parent === this },
      matches: () => false,
      closest: () => null
    }
  }
  const document = { body: node(), activeElement: null, querySelector: selector => selector === 'dialog[open]' && modal ? {} : null }
  document.activeElement = document.body
  const state = { sessions: new Map(), activeSessionId: null, sftpActive: false, sftp: null, viewKey: null, viewRevision: 0, connectingProfiles: new Set() }
  const elements = { emptyState: node(), terminalStack: node(), sftpPanel: node(), sessionStatus: node() }
  const makeSession = (id, connected = true) => {
    const session = { id, navigationId: id, profileId: id, status: 'running', phase: connected ? 'connected' : 'connecting', connected, opened: true, showLogs: false, reconnecting: false, focusOrigin: null, fitAddon: { fit () {} } }
    for (const key of ['container', 'terminalMount', 'progressLabel', 'progressRail', 'card', 'logView', 'logsButton', 'reconnectPanel', 'reconnectTitle', 'reconnectButton']) session[key] = node()
    session.input = { parent: session.terminalMount }
    session.terminal = { cols: 80, rows: 24, focus: () => { document.activeElement = session.input; focusCalls.push(id) } }
    if (!connected) session.terminalMount.classList.toggle('hidden', true)
    state.sessions.set(id, session)
    return session
  }
  const context = vm.createContext({
    state,
    elements,
    document,
    presentedView: null,
    window: { requestAnimationFrame: callback => frames.push(callback) },
    highlightProfile () {},
    syncTerminalRenderer () {},
    animateSurface () {},
    renderTabs: () => { tabRenders++ },
    renderProfiles () {},
    profileById: id => ({ id }),
    createTerminalSession: id => makeSession(id, false),
    notify: message => assert.fail(message),
    errorMessage: error => error.message,
    api: { sessions: { start: id => new Promise(resolve => starts.push({ id, resolve })), resize: async () => {}, write: () => assert.fail('focus/navigation must not send terminal input') } }
  })
  for (const name of ['focusTerminal', 'syncTerminalPresentation', 'syncWorkspaceState', 'activateSession', 'connectProfile', 'reconnectSession', 'switchTab']) {
    const start = source.indexOf(`function ${name} (`)
    assert.notEqual(start, -1)
    const begin = source.slice(start - 6, start) === 'async ' ? start - 6 : start
    vm.runInContext(source.slice(begin, source.indexOf('\n}', start) + 2), context)
  }
  const flush = () => { while (frames.length) frames.shift()() }
  return { context, document, state, node, makeSession, starts, focusCalls, flush, setModal: value => { modal = value }, renders: () => tabRenders }
}

test('slow connection completion preserves the search or form entered after activation', () => {
  for (const destination of ['search', 'form']) {
    const h = harness()
    const session = h.makeSession('a', false)
    h.context.activateSession('a')
    h.flush()
    const input = h.node()
    h.document.activeElement = input
    if (destination === 'form') h.setModal(true)
    session.connected = true
    session.phase = 'connected'
    h.context.syncTerminalPresentation(session)
    h.flush()
    assert.equal(h.document.activeElement, input, destination)
    assert.deepEqual(h.focusCalls, [])
  }
})

test('an old activation frame cannot focus over a later input or modal', () => {
  for (const modal of [false, true]) {
    const h = harness()
    h.makeSession('a')
    h.context.activateSession('a')
    const input = h.node()
    h.document.activeElement = input
    h.setModal(modal)
    h.flush()
    assert.equal(h.document.activeElement, input)
    assert.deepEqual(h.focusCalls, [])
  }
})

test('explicit selection still focuses the terminal and accepts the selected keyboard tab', () => {
  for (const origin of ['button', 'keyboard-tab']) {
    const h = harness()
    const session = h.makeSession('a')
    h.document.activeElement = h.node()
    h.context.activateSession('a')
    if (origin === 'keyboard-tab') h.document.activeElement = { matches: selector => selector === '.tab-select', closest: () => ({ dataset: { tabKey: 'ssh:a' } }) }
    h.flush()
    assert.equal(h.document.activeElement, session.input, origin)
  }
})

test('returning to the same input node before the handshake finishes never restores old focus intent', () => {
  for (const kind of ['input', 'textarea', 'select', 'contenteditable']) {
    const h = harness()
    const input = h.node()
    input.matches = selector => kind !== 'contenteditable' && selector === 'input, textarea, select'
    input.isContentEditable = kind === 'contenteditable'
    h.document.activeElement = input
    const session = h.makeSession('a', false)
    h.context.activateSession('a')
    h.flush()
    h.document.activeElement = h.document.body
    h.document.activeElement = input
    session.connected = true
    h.context.syncTerminalPresentation(session)
    h.flush()
    assert.equal(h.document.activeElement, input, kind)
    assert.deepEqual(h.focusCalls, [])
  }
})

test('real keyboard tab selection moves focus out of search before focusing the selected terminal', () => {
  const h = harness()
  const session = h.makeSession('a')
  h.document.activeElement = { matches: selector => selector === 'input, textarea, select' }
  h.context.tabOrder = ['ssh:a']
  h.context.tabPointer = null
  h.context.profileDrag = null
  const select = {
    matches: selector => selector === '.tab-select',
    closest: () => ({ dataset: { tabKey: 'ssh:a' } }),
    focus: () => { h.document.activeElement = select }
  }
  h.context.elements.tabs = { querySelector: () => ({ scrollIntoView () {}, querySelector: () => select }) }
  h.context.switchTab('tab-1')
  assert.equal(h.document.activeElement, select)
  h.flush()
  assert.equal(h.document.activeElement, session.input)
})

test('normal connection focus survives the originating sidebar button being rebuilt', async () => {
  const h = harness()
  const button = h.node()
  h.document.activeElement = button
  const task = h.context.connectProfile('new')
  button.isConnected = false
  h.document.activeElement = h.document.body
  h.starts[0].resolve({ sessionId: 'new' })
  await task
  const session = h.state.sessions.get('new')
  session.connected = true
  h.context.syncTerminalPresentation(session)
  h.flush()
  assert.equal(h.document.activeElement, session.input)
})

test('a pending start keeps its focus origin rather than adopting the current search input', async () => {
  const h = harness()
  const task = h.context.connectProfile('new')
  const input = h.node()
  h.document.activeElement = input
  h.starts[0].resolve({ sessionId: 'new' })
  await task
  const session = h.state.sessions.get('new')
  session.connected = true
  h.context.syncTerminalPresentation(session)
  h.flush()
  assert.equal(h.document.activeElement, input)
  assert.deepEqual(h.focusCalls, [])
})

test('late start responses do not replace a later SSH, SFTP or round-trip selection', async () => {
  for (const destination of ['ssh', 'sftp', 'round-trip']) {
    const h = harness()
    h.makeSession('a')
    h.makeSession('b')
    h.context.activateSession('a')
    h.flush()
    const task = h.context.connectProfile('new')
    if (destination === 'sftp') {
      h.state.sftpActive = true
      h.state.sftp = { connectionId: 's', status: 'ready' }
      h.context.syncWorkspaceState()
    } else {
      h.context.activateSession('b')
      if (destination === 'round-trip') h.context.activateSession('a')
    }
    const expected = h.state.viewKey
    h.starts[0].resolve({ sessionId: 'new' })
    await task
    h.flush()
    assert.equal(h.state.viewKey, expected, destination)
    assert.ok(h.state.sessions.has('new'))
  }
})

test('same-pane SFTP navigation changes revision but background status updates do not', () => {
  const h = harness()
  h.state.sftpActive = true
  h.context.syncWorkspaceState()
  assert.equal(h.state.viewRevision, 1)
  h.context.syncWorkspaceState()
  assert.equal(h.state.viewRevision, 1)
  h.state.sftp = { connectionId: 'a', status: 'ready' }
  h.context.syncWorkspaceState()
  h.state.sftp = { connectionId: 'b', status: 'ready' }
  h.context.syncWorkspaceState()
  assert.equal(h.state.viewRevision, 3)
})

test('SFTP handshake ID replacement does not cancel a concurrently requested SSH activation', async () => {
  const h = harness()
  h.state.sftpActive = true
  h.state.sftp = { connectionId: 'pending:a', status: 'connecting' }
  h.context.syncWorkspaceState()
  const revision = h.state.viewRevision
  const task = h.context.connectProfile('new')
  h.state.sftp.connectionId = 'ready:a'
  h.state.sftp.status = 'ready'
  h.context.syncWorkspaceState()
  assert.equal(h.state.viewRevision, revision)
  h.starts[0].resolve({ sessionId: 'new' })
  await task
  assert.equal(h.state.activeSessionId, 'new')
  assert.equal(h.state.sftpActive, false)
})

test('non-activating starts still render their new tab before any progress event', async () => {
  const h = harness()
  const task = h.context.connectProfile('new', { activate: false })
  h.starts[0].resolve({ sessionId: 'new' })
  await task
  assert.equal(h.renders(), 1)
  assert.equal(h.state.activeSessionId, null)
  assert.deepEqual(h.focusCalls, [])
})

test('reconnection carries the original focus intent across the replacement session', async () => {
  const h = harness()
  const previous = h.makeSession('old')
  previous.status = 'exited'
  h.context.activateSession('old')
  h.flush()
  h.focusCalls.length = 0
  h.context.tabOrder = ['ssh:old']
  h.context.tabPointer = null
  h.context.removeSession = async session => { h.state.sessions.delete(session.id) }
  const task = h.context.reconnectSession(previous)
  const input = h.node()
  h.document.activeElement = input
  h.starts[0].resolve({ sessionId: 'replacement' })
  await task
  const replacement = h.state.sessions.get('replacement')
  replacement.connected = true
  h.context.syncTerminalPresentation(replacement)
  h.flush()
  assert.equal(h.state.activeSessionId, 'replacement')
  assert.equal(h.document.activeElement, input)
  assert.deepEqual(h.focusCalls, [])
})

test('in-place SSH reconnect keeps a string navigation identity and does not cancel another requested activation', async () => {
  const h = harness()
  const previous = h.makeSession('old')
  previous.status = 'exited'
  h.context.activateSession('old')
  h.flush()
  const revision = h.state.viewRevision
  h.context.tabOrder = ['ssh:old']
  h.context.tabPointer = null
  h.context.removeSession = async session => { h.state.sessions.delete(session.id) }
  const reconnect = h.context.reconnectSession(previous)
  const newConnection = h.context.connectProfile('other')
  h.starts[0].resolve({ sessionId: 'replacement' })
  await reconnect
  assert.equal(h.state.viewRevision, revision)
  assert.equal(h.state.sessions.get('replacement').navigationId, 'old')
  h.starts[1].resolve({ sessionId: 'other' })
  await newConnection
  assert.equal(h.state.activeSessionId, 'other')
})
