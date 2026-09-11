'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const vm = require('node:vm')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const source = readFileSync(path.join(__dirname, '../src/main.js'), 'utf8')

/** 使用真实菜单派发与改名函数，只延迟原生菜单结果，覆盖右击对象在等待中关闭/重连的竞态。 */
function harness () {
  const calls = []
  const nodes = new Map()
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { value: '', focus () {}, select () {}, showModal () {}, close () {} })
    return nodes.get(selector)
  }
  const ssh = { id: 'ssh-id', profileId: 'ssh-profile', title: '后台终端', status: 'exited' }
  const sftp = { connectionId: 'sftp-id', profileId: 'sftp-profile', title: '文件服务 · SFTP', status: 'ready', busy: true, path: '/upload' }
  const state = { filesOpen: true, activeSessionId: 'different', sessions: new Map([[ssh.id, ssh]]), sftpConnections: new Map([[sftp.connectionId, sftp]]), connectingProfiles: new Set() }
  let choose
  let menuOptions
  const context = vm.createContext({
    state,
    localTabTitle: '本机文件',
    renameTabTarget: null,
    document: { querySelector: selector => selector === 'dialog[open]' ? null : node(selector) },
    api: {
      app: {
        tabMenu: options => { menuOptions = options; return new Promise(resolve => { choose = resolve }) },
        openConnectionWindow: async input => calls.push(['window', input])
      }
    },
    removeSession: async entry => calls.push(['close-ssh', entry]),
    closeSftp: async (entry, options) => calls.push(['close-sftp', entry, options]),
    closeFileWorkspace: async () => calls.push(['close-local']),
    openFileWorkspace: () => calls.push(['open-local']),
    connectProfile: async (...args) => { calls.push(['connect', ...args]); return 'ssh-id' },
    reconnectSession: async entry => calls.push(['reconnect', entry]),
    connectSftp: async (...args) => { calls.push(['sftp', ...args]); return 'sftp-id' },
    refreshSftp: async (...args) => calls.push(['refresh', ...args]),
    renderTabs: () => calls.push(['render']),
    notify: message => calls.push(['error', message]),
    errorMessage: error => error.message
  })
  for (const name of ['tabTarget', 'showTabMenu', 'renameTab', 'openInitialConnection']) {
    const start = source.search(new RegExp(`(?:async )?function ${name} \\(`, 'u'))
    assert.notEqual(start, -1)
    vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), context)
  }
  return {
    context,
    state,
    ssh,
    sftp,
    calls,
    node,
    get options () { return menuOptions },
    choose: action => choose(action),
    show: key => context.showTabMenu({ target: { closest: () => ({ dataset: { tabKey: key } }) }, preventDefault () {} })
  }
}

test('right-click SSH close targets the background tab and does not select it', async () => {
  const h = harness()
  const menu = h.show('ssh:ssh-id')
  assert.equal(h.options.reconnect, true)
  h.choose('close')
  await menu
  assert.deepEqual(h.calls, [['close-ssh', h.ssh]])
  assert.equal(h.state.activeSessionId, 'different')
})

test('menu does not operate on a closed/replaced tab or when dismissed', async () => {
  for (const action of ['close', 'reconnect', 'rename', 'duplicate', 'new-window', null]) {
    const h = harness()
    const menu = h.show('ssh:ssh-id')
    h.state.sessions.set('ssh-id', { ...h.ssh })
    h.choose(action)
    await menu
    assert.deepEqual(h.calls, [])
    assert.equal(h.context.renameTabTarget, null)
  }
})

test('only duplicate requests a fresh SSH session; reconnect uses the existing tab', async () => {
  for (const action of ['duplicate', 'reconnect']) {
    const h = harness()
    const menu = h.show('ssh:ssh-id')
    h.choose(action)
    await menu
    if (action === 'duplicate') {
      assert.equal(h.calls[0][0], 'connect')
      assert.equal(h.calls[0][2].forceNew, true)
    } else assert.deepEqual(h.calls, [['reconnect', h.ssh]])
  }
})

test('SFTP menu close retains force-close semantics during uploads; refresh respects busy state', async () => {
  const h = harness()
  const menu = h.show('sftp:sftp-id')
  assert.equal(h.options.busy, true)
  h.choose('close')
  await menu
  assert.equal(h.calls[0][0], 'close-sftp')
  assert.equal(h.calls[0][1], h.sftp)
  assert.equal(h.calls[0][2].force, true)
  h.calls.length = 0
  const refresh = h.show('sftp:sftp-id')
  h.choose('refresh')
  await refresh
  assert.deepEqual(h.calls, [])
  h.sftp.busy = false
  const ready = h.show('sftp:sftp-id')
  h.choose('refresh')
  await ready
  assert.deepEqual(h.calls, [['refresh', '/upload', h.sftp]])
})

test('rename applies to only the chosen tab, validates text and rejects stale targets', async () => {
  for (const key of ['ssh:ssh-id', 'sftp:sftp-id', 'files:local']) {
    const h = harness()
    const menu = h.show(key)
    h.choose('rename')
    await menu
    h.node('#tab-name').value = '  <部署>  '
    h.context.renameTab({ preventDefault () {} })
    if (key.startsWith('ssh:')) assert.equal(h.ssh.title, '<部署>')
    else if (key.startsWith('sftp:')) {
      assert.equal(h.sftp.tabTitle, '<部署>')
      assert.equal(h.sftp.title, '文件服务 · SFTP')
    } else assert.equal(h.context.localTabTitle, '<部署>')
    h.node('#tab-name').value = ' \n '
    h.context.renameTab({ preventDefault () {} })
    assert.match(h.node('#tab-name-error').textContent, /1～80/u)
  }
  const h = harness()
  const menu = h.show('ssh:ssh-id')
  h.choose('rename')
  await menu
  h.state.sessions.delete(h.ssh.id)
  h.node('#tab-name').value = '已过期'
  h.context.renameTab({ preventDefault () {} })
  assert.equal(h.ssh.title, '后台终端')
})

test('new-window requests contain only profile/type/title and each startup opens the proper workspace', async () => {
  for (const kind of ['ssh', 'sftp', 'local']) {
    const h = harness()
    const menu = h.show(kind === 'local' ? 'files:local' : `${kind}:${kind}-id`)
    h.choose('new-window')
    await menu
    assert.equal(h.calls[0][0], 'window')
    const initial = h.calls[0][1]
    assert.deepEqual(Object.keys(initial).sort(), ['kind', 'profileId', 'title'])
    await h.context.openInitialConnection(initial)
    assert.equal(h.calls[1][0], kind === 'ssh' ? 'connect' : kind === 'sftp' ? 'sftp' : 'open-local')
  }
})

test('right pointer press preserves terminal focus without starting a tab drag', () => {
  let listener
  let prevented = false
  const context = vm.createContext({ elements: { tabs: { addEventListener: (_event, callback) => { listener = callback } } }, tabPointer: null })
  const start = source.indexOf("elements.tabs.addEventListener('pointerdown', event => {")
  vm.runInContext(source.slice(start, source.indexOf('\n})', start) + 3), context)
  listener({ button: 2, preventDefault: () => { prevented = true } })
  assert.equal(prevented, true)
  assert.equal(context.tabPointer, null)
})
