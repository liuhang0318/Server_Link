'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const vm = require('node:vm')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const source = readFileSync(path.join(__dirname, '../src/main.js'), 'utf8')

/** 运行实际批次入口，以延迟连接覆盖完成前的用户导航；不会调用原生或远端接口。 */
async function harness () {
  const { connectBatch } = await import('../src/connection-batch.mjs')
  const profiles = ['a', 'b'].map(id => ({ id, name: `prod-${id}`, group: 'prod', host: `${id}.test`, username: 'root', port: 22 }))
  const pending = new Map()
  const activations = []
  const focusOrigins = []
  const state = { profiles, sessions: new Map(), connectingProfiles: new Set(), activeSessionId: null, sftpActive: false }
  const context = vm.createContext({
    state,
    document: { activeElement: null },
    connectingGroups: new Set(),
    expandedProfileGroups: new Set(),
    renderProfiles () {},
    notify () {},
    connectBatch,
    connectProfile: profileId => new Promise(resolve => pending.set(profileId, id => {
      if (id) state.sessions.set(id, { id, profileId, status: 'running' })
      resolve(id)
    })),
    activateSession: (id, options) => { state.activeSessionId = id; state.sftpActive = false; activations.push(id); focusOrigins.push(options?.focusOrigin) }
  })
  loadFunction(context, 'connectProfileGroup')
  return { context, state, pending, activations, focusOrigins, group: { key: 'group:prod', name: 'prod', profiles } }
}

/** 截取真实顶层函数，不在测试内重写焦点或筛选规则。 */
function loadFunction (context, name) {
  const start = source.indexOf(`function ${name} (`)
  assert.notEqual(start, -1)
  const begin = source.slice(start - 6, start) === 'async ' ? start - 6 : start
  vm.runInContext(source.slice(begin, source.indexOf('\n}', start) + 2), context)
}

test('batch completion preserves an existing SSH view, SFTP, a round trip and a closed original tab', async () => {
  for (const destination of ['same', 'other-ssh', 'sftp', 'round-trip', 'closed']) {
    const h = await harness()
    h.state.activeSessionId = 'original'
    const task = h.context.connectProfileGroup(h.group)
    if (destination === 'other-ssh') h.state.activeSessionId = 'other'
    if (destination === 'sftp') { h.state.activeSessionId = null; h.state.sftpActive = true }
    if (destination === 'round-trip') { h.state.activeSessionId = 'other'; h.state.activeSessionId = 'original' }
    if (destination === 'closed') h.state.activeSessionId = null
    const expected = { id: h.state.activeSessionId, sftp: h.state.sftpActive }
    h.pending.get('b')('ssh-b')
    h.pending.get('a')('ssh-a')
    await task
    assert.deepEqual(h.activations, [], destination)
    assert.deepEqual({ id: h.state.activeSessionId, sftp: h.state.sftpActive }, expected)
    assert.equal(h.context.connectingGroups.size, 0)
  }
})

test('a batch started in SFTP and a fully reused batch never switch the current view', async () => {
  const h = await harness()
  h.state.sftpActive = true
  const task = h.context.connectProfileGroup(h.group)
  h.pending.get('a')('ssh-a')
  h.pending.get('b')('ssh-b')
  await task
  h.pending.clear()
  await h.context.connectProfileGroup(h.group)
  assert.equal(h.pending.size, 0)
  assert.deepEqual(h.activations, [])
  assert.equal(h.state.sftpActive, true)
})

test('an initially empty workspace selects once, but never over navigation during the batch', async () => {
  for (const destination of ['empty', 'ssh', 'sftp', 'opened-then-closed']) {
    const h = await harness()
    const task = h.context.connectProfileGroup(h.group)
    if (destination === 'ssh') h.state.activeSessionId = 'chosen'
    if (destination === 'sftp') h.state.sftpActive = true
    if (destination === 'opened-then-closed') {
      h.state.activeSessionId = 'temporary'
      h.state.viewRevision = 1
      h.state.activeSessionId = null
      h.state.viewRevision = 2
    }
    h.pending.get('b')('ssh-b')
    h.pending.get('a')('ssh-a')
    await task
    assert.deepEqual(h.activations, destination === 'empty' ? ['ssh-b'] : [])
    if (destination === 'ssh') assert.equal(h.state.activeSessionId, 'chosen')
    if (destination === 'sftp') assert.equal(h.state.sftpActive, true)
  }
})

test('an empty-workspace batch skips closed results and never activates an all-failed batch', async () => {
  const h = await harness()
  const task = h.context.connectProfileGroup(h.group)
  h.pending.get('a')('ssh-a')
  h.pending.get('b')('ssh-b')
  h.state.sessions.delete('ssh-b')
  await task
  assert.deepEqual(h.activations, ['ssh-a'])

  const failed = await harness()
  const failedTask = failed.context.connectProfileGroup(failed.group)
  failed.pending.get('a')(null)
  failed.pending.get('b')(null)
  await failedTask
  assert.deepEqual(failed.activations, [])
  assert.equal(failed.context.connectingGroups.size, 0)
})

test('an empty-workspace batch preserves its original focus intent instead of adopting a later search', async () => {
  const h = await harness()
  const origin = { name: 'connect-group' }
  h.context.document.activeElement = origin
  const task = h.context.connectProfileGroup(h.group)
  h.context.document.activeElement = { name: 'search' }
  h.pending.get('a')('ssh-a')
  h.pending.get('b')('ssh-b')
  await task
  assert.deepEqual(h.focusOrigins, [origin])
})

/** 只提供渲染所需的最小 DOM；点击真实创建的组按钮，验证文案和传入批次的一致性。 */
function makeNode (tag = 'div') {
  return {
    tag,
    dataset: {},
    children: [],
    events: {},
    className: '',
    scrollTop: 0,
    classList: { toggle () {} },
    append (...children) { this.children.push(...children) },
    replaceChildren () { this.children = [] },
    addEventListener (event, listener) { this.events[event] = listener },
    setAttribute (key, value) { this[key] = value },
    getAttribute (key) { return this[key] },
    querySelectorAll (selector) {
      return this.children.flatMap(child => [
        ...((selector.startsWith('.') ? child.className.split(' ').includes(selector.slice(1)) : child.tag === selector) ? [child] : []),
        ...child.querySelectorAll(selector)
      ])
    },
    querySelector (selector) { return this.querySelectorAll(selector)[0] ?? null }
  }
}

test('group action connects only visible search matches, then the entire group when search is cleared', async () => {
  const h = await harness()
  const { groupProfiles } = await import('../src/profile-groups.mjs')
  const profileList = makeNode()
  const search = { value: 'a.test' }
  const batches = []
  const original = structuredClone(h.state.profiles)
  Object.assign(h.context, {
    groupProfiles,
    profileSearch: search,
    profileDrag: null,
    managingProfiles: false,
    elements: { profileList },
    document: { activeElement: {}, createElement: makeNode, querySelector: () => makeNode() },
    syncProfileSelection () {},
    highlightProfile () {},
    bindProfileDropTarget () {},
    createProfileDragHandle: () => makeNode(),
    connectProfileGroup: group => batches.push(group)
  })
  h.state.sftpConnecting = new Set()
  for (const name of ['createButton', 'visibleProfiles', 'renderProfiles']) loadFunction(h.context, name)
  h.context.renderProfiles()
  let button = profileList.querySelector('.group-connect')
  assert.equal(button.textContent, '连接筛选结果')
  assert.match(button['aria-label'], /筛选出的 1 台/u)
  assert.equal(profileList.querySelector('.group-count').textContent, '1')
  button.events.click({ preventDefault () {}, stopPropagation () {} })
  assert.deepEqual(Array.from(batches[0].profiles, profile => profile.id), ['a'])

  search.value = ''
  h.context.renderProfiles()
  button = profileList.querySelector('.group-connect')
  assert.equal(button.textContent, '全部连接')
  button.events.click({ preventDefault () {}, stopPropagation () {} })
  assert.deepEqual(Array.from(batches[1].profiles, profile => profile.id), ['a', 'b'])
  assert.deepEqual(h.state.profiles, original)
})
