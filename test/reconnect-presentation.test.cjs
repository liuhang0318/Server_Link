'use strict'

const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const source = readFileSync(path.join(__dirname, '../src/main.js'), 'utf8')

/** 执行真实展示函数，仅替换 DOM 和终端，避免把断线提示误加到握手/自动重试阶段。 */
function presentation (overrides = {}, active = true) {
  const node = () => {
    const classes = new Set()
    return { classes, classList: { contains: name => classes.has(name), toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) }, setAttribute (name, value) { this[name] = value } }
  }
  let focused = 0
  const session = {
    id: 'fixture',
    status: 'running',
    phase: 'connecting',
    connected: false,
    showLogs: false,
    opened: true,
    reconnecting: false,
    progressLabel: node(),
    progressRail: node(),
    card: node(),
    logView: node(),
    logsButton: node(),
    container: node(),
    terminalMount: node(),
    reconnectPanel: node(),
    reconnectTitle: node(),
    reconnectButton: node(),
    terminal: { focus: () => { focused++ } },
    ...overrides
  }
  const context = vm.createContext({ state: { activeSessionId: active ? 'fixture' : 'other', sftpActive: false }, window: { requestAnimationFrame () {} } })
  vm.runInContext(source.slice(source.indexOf('function syncTerminalPresentation ('), source.indexOf('async function reconnectSession (')), context)
  context.syncTerminalPresentation(session)
  return { session, focused: () => focused }
}

test('center reconnect only appears after final exit, not online, authenticating or automatic retry', () => {
  for (const phase of ['connecting', 'verifying', 'authenticating', 'retrying', 'failed', 'connected']) {
    const h = presentation({ phase, connected: phase === 'connected' })
    assert.equal(h.session.reconnectPanel.classes.has('hidden'), true, phase)
  }
  const disconnected = presentation({ connected: true, status: 'exited' })
  assert.equal(disconnected.session.reconnectPanel.classes.has('hidden'), false)
  assert.equal(disconnected.session.reconnectTitle.textContent, '连接已断开')
  assert.equal(disconnected.session.reconnectButton.textContent, '重新连接')
  assert.equal(disconnected.session.terminalMount.classes.has('hidden'), false)
  assert.equal(disconnected.session.card.classes.has('hidden'), true)
})

test('failed initial connections can retry and pending retry feedback never steals background focus', () => {
  const h = presentation({ status: 'exited', reconnecting: true }, false)
  assert.equal(h.session.reconnectTitle.textContent, '连接未成功')
  assert.equal(h.session.reconnectButton.disabled, true)
  assert.equal(h.session.reconnectButton.textContent, '正在重连…')
  assert.equal(h.session.reconnectPanel['aria-busy'], 'true')
  assert.equal(h.focused(), 0)
})
