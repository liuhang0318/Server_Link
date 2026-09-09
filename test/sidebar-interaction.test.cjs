'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const vm = require('node:vm')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const source = readFileSync(path.join(__dirname, '../src/main.js'), 'utf8')

/** 执行真实入口和伸缩逻辑，桩只隔离 DOM、动画时钟与连接 IPC。 */
function harness (reduced = false) {
  const pending = new Map()
  const timers = new Map()
  const resized = []
  let timerId = 0
  let hidden = false
  let focused = null
  const button = { attrs: {}, setAttribute (key, value) { this.attrs[key] = value }, focus () { focused = this } }
  const sidebar = { attrs: {}, setAttribute (key, value) { this.attrs[key] = value }, contains: node => node === sidebar }
  const app = { classList: { contains: () => hidden, toggle: (name, value) => { hidden = value } } }
  const localPane = { scrollIntoView () {} }
  const search = { focus () { focused = this }, select () {} }
  const state = { sessions: new Map(), sftpConnections: new Map(), sftpConnecting: new Set(), sftp: null, sftpActive: false, activeSessionId: 'ssh-a' }
  const makeSession = id => ({ id, opened: true, terminalMount: { classList: { contains: () => false } }, terminal: { cols: 80, rows: 24 }, fitAddon: { fit: () => resized.push(`fit:${id}`) } })
  state.sessions.set('ssh-a', makeSession('ssh-a'))
  state.sessions.set('ssh-b', makeSession('ssh-b'))
  const document = {
    get activeElement () { return focused },
    querySelector: selector => ({ '#app': app, '.sidebar': sidebar, '#sidebar-toggle': button, '.local-pane': localPane, '#servers-dialog': { close () {} } }[selector]),
    querySelectorAll: () => [{ value: 'a' }, { value: 'b' }]
  }
  const context = vm.createContext({
    document,
    state,
    sidebarResizeTimer: null,
    tabOrder: [],
    localDirectory: {},
    selectingServers: false,
    uploadTargets: new Set(),
    profileSearch: search,
    window: { matchMedia: () => ({ matches: reduced }), addEventListener: (type, handler) => { context.keydown = handler } },
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId },
    clearTimeout: id => timers.delete(id),
    profileById: id => ({ id, name: id, auth: 'key' }),
    createRemotePane: connection => { connection.ui = { pane: { querySelector: () => ({}), scrollIntoView () {} } } },
    animateSurface () {},
    setSftpBusy () {},
    renderSftpFiles () {},
    renderTabs () {},
    renderRemoteChoices () {},
    renderProfiles () {},
    syncWorkspaceState () {},
    notify () {},
    errorMessage: error => error.message,
    connectBatch: (connections, connect) => Promise.all(connections.map(connect)),
    api: {
      sftp: { connect: id => new Promise(resolve => pending.set(id, resolve)) },
      sessions: { resize: async id => resized.push(`resize:${id}`) }
    }
  })
  for (const name of ['fitActiveTerminal', 'finishSidebarResize', 'setSidebarHidden', 'enterFileWorkspace', 'openFileWorkspace', 'prepareSftp', 'connectSftp', 'connectSelectedServers', 'activateSftp']) {
    const start = source.indexOf(`function ${name} (`)
    const begin = source.slice(start - 6, start) === 'async ' ? start - 6 : start
    vm.runInContext(source.slice(begin, source.indexOf('\n}', start) + 2), context)
  }
  return { context, state, button, sidebar, pending, timers, resized, search, hidden: () => hidden, focus: node => { focused = node }, focused: () => focused }
}

test('entering SFTP collapses once; manual expansion survives local/remote switches until re-entry', () => {
  const h = harness()
  h.focus(h.sidebar)
  h.context.openFileWorkspace()
  assert.equal(h.hidden(), true)
  assert.equal(h.state.activeSessionId, null)
  assert.equal(h.sidebar.inert, true)
  assert.equal(h.sidebar.attrs['aria-hidden'], 'true')
  assert.equal(h.button.attrs['aria-expanded'], 'false')
  assert.equal(h.button.title, '展开服务器侧栏')
  assert.equal(h.focused(), h.button)

  h.context.setSidebarHidden(false)
  assert.equal(h.sidebar.inert, false)
  assert.equal(h.button.attrs['aria-expanded'], 'true')
  assert.equal(h.button.title, '隐藏服务器侧栏')
  h.context.openFileWorkspace()
  const remote = h.context.prepareSftp('a')
  h.context.activateSftp(remote.connectionId)
  h.context.openFileWorkspace()
  assert.equal(h.hidden(), false)

  h.state.sftpActive = false
  h.state.activeSessionId = 'ssh-a'
  h.context.activateSftp(remote.connectionId)
  assert.equal(h.hidden(), true)
})

test('direct SFTP collapses before handshake, but completion never closes a manually expanded sidebar', async () => {
  const h = harness()
  const connecting = h.context.connectSftp('a')
  assert.equal(h.hidden(), true)
  assert.equal(h.state.sftp.status, 'connecting')
  h.context.setSidebarHidden(false)
  h.pending.get('a')({ connectionId: 'remote-a', path: '/', entries: [] })
  await connecting
  assert.equal(h.state.sftp.status, 'ready')
  assert.equal(h.hidden(), false)
})

test('batch entry shows pending panes in the collapsed workspace without recollapsing on completion', async () => {
  const h = harness()
  const connecting = h.context.connectSelectedServers({ preventDefault () {} })
  assert.equal(h.hidden(), true)
  assert.equal(h.state.sftpActive, true)
  assert.equal(h.state.sftpConnections.size, 2)
  h.context.setSidebarHidden(false)
  h.pending.get('b')({ connectionId: 'remote-b', path: '/', entries: [] })
  h.pending.get('a')({ connectionId: 'remote-a', path: '/', entries: [] })
  await connecting
  assert.equal(h.hidden(), false)
  assert.equal(h.state.sftp, null)
})

test('sidebar animation fits only the current terminal once and respects rapid reversals', () => {
  const h = harness()
  h.context.setSidebarHidden(true)
  h.context.fitActiveTerminal()
  h.context.setSidebarHidden(false)
  h.context.fitActiveTerminal()
  assert.equal(h.timers.size, 1)
  assert.deepEqual(h.resized, [])
  h.state.activeSessionId = 'ssh-b'
  h.context.finishSidebarResize()
  h.context.finishSidebarResize()
  assert.equal(h.timers.size, 0)
  assert.deepEqual(h.resized, ['fit:ssh-b', 'resize:ssh-b'])
})

test('reduced motion fallback never fits hidden or closed SSH sessions', () => {
  const h = harness(true)
  h.context.setSidebarHidden(true)
  assert.equal([...h.timers.values()][0].delay, 0)
  h.state.sessions.delete('ssh-a')
  h.context.finishSidebarResize()
  h.context.setSidebarHidden(false)
  h.state.activeSessionId = 'ssh-b'
  h.state.sftpActive = true
  h.context.finishSidebarResize()
  assert.deepEqual(h.resized, [])
})

test('Command+K expands the SFTP sidebar and focuses search without reopening it on later file actions', () => {
  const h = harness()
  h.context.openFileWorkspace()
  vm.runInContext(source.slice(source.lastIndexOf("window.addEventListener('keydown', event => {"), source.indexOf("elements.secretForm.addEventListener('submit'")), h.context)
  let prevented = false
  h.context.keydown({ metaKey: true, key: 'k', preventDefault () { prevented = true } })
  assert.equal(prevented, true)
  assert.equal(h.hidden(), false)
  assert.equal(h.focused(), h.search)
  h.context.openFileWorkspace()
  assert.equal(h.hidden(), false)
})
