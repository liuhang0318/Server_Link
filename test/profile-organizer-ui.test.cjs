'use strict'

const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const source = readFileSync(path.join(__dirname, '../src/main.js'), 'utf8')

/** 截取真实顶层函数；不复制交互逻辑，只隔离 DOM 与 IPC。 */
function loadFunctions (context, names) {
  for (const name of names) {
    const start = source.indexOf(`function ${name} (`)
    assert.notEqual(start, -1, `missing renderer function ${name}`)
    const begin = source.slice(start - 6, start) === 'async ' ? start - 6 : start
    vm.runInContext(source.slice(begin, source.indexOf('\n}', start) + 2), context)
  }
}

/** 使用可控的实际 Promise 检验提交时序，组织测试不得调用连接或传输接口。 */
async function harness () {
  const { groupProfiles, moveProfileOrder } = await import('../src/profile-groups.mjs')
  const profiles = [
    { id: 'jp', name: 'jp', group: '', order: 0 },
    { id: 'prod2', name: 'Prod2', order: 1 },
    { id: 'prod1', name: 'Prod1', order: 2 },
    { id: 'api', name: 'api', group: 'Operations', order: 3 },
    { id: 'web', name: 'web', group: 'Operations', order: 4 },
    { id: 'home', name: 'home', group: '', order: 5 }
  ]
  const pending = []
  const changes = []
  const notifications = []
  const renders = []
  const networkCalls = []
  let refreshes = 0
  let selectionSyncs = 0
  let refreshed = profiles
  let refreshError = null
  const state = { profiles, sessions: new Map([['ssh', { id: 'ssh' }]]), sftpConnections: new Map([['sftp', { connectionId: 'sftp' }]]), activeSessionId: 'ssh', sftpActive: false }
  const api = {
    profiles: {
      organize: change => {
        changes.push(change)
        return new Promise((resolve, reject) => pending.push({ resolve, reject }))
      },
      list: async () => { refreshes++; if (refreshError) throw refreshError; return refreshed }
    },
    // Proxy 捕获任意新增 SSH/SFTP 调用，防止归组或重排意外触发远端操作。
    sessions: new Proxy({}, { get: (_object, name) => (...args) => { networkCalls.push(['ssh', name, args]); assert.fail('organization must not operate SSH') } }),
    sftp: new Proxy({}, { get: (_object, name) => (...args) => { networkCalls.push(['sftp', name, args]); assert.fail('organization must not operate SFTP') } })
  }
  const context = vm.createContext({
    state,
    api,
    groupProfiles,
    moveProfileOrder,
    profileSelection: new Set(),
    profileOrganizationSaving: false,
    expandedProfileGroups: new Set(),
    notify: (message, error = false) => notifications.push({ message, error }),
    errorMessage: error => error.message,
    renderProfiles: () => renders.push({ saving: context.profileOrganizationSaving, profiles: state.profiles }),
    syncProfileSelection: () => { selectionSyncs++ }
  })
  loadFunctions(context, ['profileDropChange', 'saveProfileOrganization', 'selectProfiles'])
  return {
    context,
    state,
    profiles,
    changes,
    pending,
    notifications,
    renders,
    networkCalls,
    groups: () => groupProfiles(state.profiles),
    refreshes: () => refreshes,
    selectionSyncs: () => selectionSyncs,
    setRefresh: (profiles, error = null) => { refreshed = profiles; refreshError = error }
  }
}

test('profile drop joins one or multiple servers to a group and keeps full hidden-member order', async () => {
  const h = await harness()
  const operations = h.groups().find(group => group.key === 'group:operations')
  const single = h.context.profileDropChange({ ids: ['jp'], kind: 'profile' }, operations, null, false)
  assert.deepEqual({ ...single }, { ids: ['jp'], group: 'Operations', order: ['prod2', 'prod1', 'api', 'web', 'jp', 'home'] })
  const multiple = h.context.profileDropChange({ ids: ['home', 'jp'], kind: 'profile' }, operations, 'api', false)
  assert.deepEqual({ ...multiple }, { ids: ['home', 'jp'], group: 'Operations', order: ['prod2', 'prod1', 'jp', 'home', 'api', 'web'] })
  assert.equal(h.state.profiles, h.profiles)
  assert.deepEqual(h.changes, [])
  assert.deepEqual(h.networkCalls, [])
})

test('dropping servers outside a group explicitly ungroups them without changing any connection name', async () => {
  const h = await harness()
  const home = h.groups().find(group => group.key === 'single:home')
  const before = structuredClone(h.profiles)
  const change = h.context.profileDropChange({ ids: ['api', 'web'], kind: 'profile' }, home, 'home', true)
  assert.deepEqual({ ...change }, { ids: ['api', 'web'], group: '', order: ['jp', 'prod2', 'prod1', 'home', 'api', 'web'] })
  assert.deepEqual(h.profiles, before)
})

test('dragging a whole group only reorders its block and targets either full edge of another group', async () => {
  const h = await harness()
  const operations = h.groups().find(group => group.key === 'group:operations')
  const drag = { ids: ['prod2', 'prod1'], kind: 'group' }
  const after = h.context.profileDropChange(drag, operations, 'api', true)
  const before = h.context.profileDropChange(drag, h.groups()[0], 'jp', false)
  assert.deepEqual({ ...after }, { order: ['jp', 'api', 'web', 'prod2', 'prod1', 'home'] })
  assert.deepEqual({ ...before }, { order: ['prod2', 'prod1', 'jp', 'api', 'web', 'home'] })
  assert.equal(Object.hasOwn(after, 'ids'), false)
  assert.equal(Object.hasOwn(after, 'group'), false)
})

test('self-drops and group-header drops containing only the moved members are ignored', async () => {
  const h = await harness()
  const prod = h.groups().find(group => group.key === 'group:prod')
  assert.equal(h.context.profileDropChange({ ids: ['prod1'], kind: 'profile' }, prod, 'prod1', true), null)
  assert.equal(h.context.profileDropChange({ ids: ['prod2', 'prod1'], kind: 'profile' }, prod, null, false), null)
  assert.equal(h.context.profileDropChange({ ids: ['prod2', 'prod1'], kind: 'group' }, prod, null, true), null)
  assert.deepEqual(h.changes, [])
})

test('same-group card sorting does not turn automatic prefix grouping into a manual assignment', async () => {
  const h = await harness()
  const prod = h.groups().find(group => group.key === 'group:prod')
  const change = h.context.profileDropChange({ ids: ['prod1'], kind: 'profile' }, prod, 'prod2', false)
  assert.deepEqual({ ...change }, { order: ['jp', 'prod1', 'prod2', 'api', 'web', 'home'] })
  const appended = h.context.profileDropChange({ ids: ['prod2'], kind: 'profile' }, prod, null, false)
  assert.deepEqual({ ...appended }, { order: ['jp', 'prod1', 'prod2', 'api', 'web', 'home'] })
  assert.equal(Object.hasOwn(change, 'group'), false)
  assert.equal(Object.hasOwn(change, 'ids'), false)
})

test('organization updates state only after successful persistence and opens the assigned group without touching connections', async () => {
  const h = await harness()
  const sessions = h.state.sessions
  const sftpConnections = h.state.sftpConnections
  const change = { ids: ['jp'], group: 'Operations', order: h.profiles.map(profile => profile.id) }
  const saved = h.profiles.map(profile => profile.id === 'jp' ? { ...profile, group: 'Operations' } : profile)
  const saving = h.context.saveProfileOrganization(change)
  assert.equal(h.context.profileOrganizationSaving, true)
  assert.equal(h.state.profiles, h.profiles)
  assert.deepEqual(h.renders, [{ saving: true, profiles: h.profiles }])
  h.pending[0].resolve(saved)
  assert.equal(await saving, true)
  assert.equal(h.state.profiles, saved)
  assert.equal(h.context.profileOrganizationSaving, false)
  assert.equal(h.context.expandedProfileGroups.has('group:operations'), true)
  assert.deepEqual(h.renders.map(render => render.saving), [true, false])
  assert.deepEqual(h.notifications, [{ message: '服务器分组与顺序已保存', error: false }])
  assert.equal(h.refreshes(), 0)
  assert.equal(h.state.sessions, sessions)
  assert.equal(h.state.sftpConnections, sftpConnections)
  assert.equal(h.state.activeSessionId, 'ssh')
  assert.equal(h.state.sftpActive, false)
  assert.deepEqual(h.networkCalls, [])
})

test('organization failure refreshes stale profiles, reports the error and releases saving state', async () => {
  const h = await harness()
  const refreshed = h.profiles.slice(1)
  h.setRefresh(refreshed)
  const saving = h.context.saveProfileOrganization({ ids: ['jp'], group: 'Operations' })
  h.pending[0].reject(new Error('服务器列表已变化'))
  assert.equal(await saving, false)
  assert.equal(h.state.profiles, refreshed)
  assert.equal(h.refreshes(), 1)
  assert.equal(h.context.profileOrganizationSaving, false)
  assert.equal(h.context.expandedProfileGroups.size, 0)
  assert.deepEqual(h.notifications, [{ message: '服务器列表已变化', error: true }])
  assert.deepEqual(h.renders.map(render => render.saving), [true, false])
  assert.deepEqual(h.networkCalls, [])
})

test('failed refresh preserves last known profiles and concurrent saves never enqueue a second mutation', async () => {
  const h = await harness()
  h.setRefresh(null, new Error('无法读取配置'))
  const first = h.context.saveProfileOrganization({ order: h.profiles.map(profile => profile.id) })
  assert.equal(await h.context.saveProfileOrganization({ ids: ['jp'], group: 'ignored' }), false)
  assert.equal(h.changes.length, 1)
  assert.equal(h.renders.length, 1)
  h.pending[0].reject(new Error('写入失败'))
  assert.equal(await first, false)
  assert.equal(h.state.profiles, h.profiles)
  assert.equal(h.context.profileOrganizationSaving, false)
  assert.deepEqual(h.notifications, [{ message: '写入失败', error: true }])
  // 失败释放忙态，用户重试使用新请求，不自动重放失效的组织变更。
  const retry = h.context.saveProfileOrganization({ order: h.profiles.map(profile => profile.id) })
  h.pending[1].resolve(h.profiles)
  assert.equal(await retry, true)
  assert.equal(h.changes.length, 2)
  assert.deepEqual(h.networkCalls, [])
})

test('selection supports 100 servers, rejects overflow atomically and still allows deselection', async () => {
  const h = await harness()
  const ids = Array.from({ length: 101 }, (_, index) => `server-${index}`)
  h.state.profiles = ids.map(id => ({ id, name: id }))
  h.context.selectProfiles(ids.slice(0, 99), true)
  assert.equal(h.context.profileSelection.size, 99)
  h.context.selectProfiles(ids.slice(99), true)
  assert.deepEqual([...h.context.profileSelection], ids.slice(0, 99))
  assert.deepEqual(h.notifications, [{ message: '一次最多选择 100 台服务器', error: true }])
  h.context.selectProfiles([ids[99], ids[99]], true)
  assert.equal(h.context.profileSelection.size, 100)
  h.context.selectProfiles(ids.slice(0, 2), false)
  assert.equal(h.context.profileSelection.size, 98)
  assert.equal(h.context.profileSelection.has(ids[0]), false)
  assert.equal(h.selectionSyncs(), 4)
  assert.deepEqual(h.changes, [])
  assert.deepEqual(h.networkCalls, [])
})

test('profile list refresh is deferred through a drag and completes once after the drag ends', () => {
  let rebuilds = 0
  let removedSorting = 0
  const list = {
    scrollTop: 215,
    replaceChildren: () => { rebuilds++ },
    classList: { toggle () {}, remove: () => { removedSorting++ } },
    querySelectorAll: () => [],
    append () {}
  }
  const context = vm.createContext({
    profileDrag: { ids: ['active-drag'], kind: 'profile', handle: { hasPointerCapture: () => false } },
    profileDragFrame: null,
    state: { profiles: [] },
    elements: { profileList: list },
    managingProfiles: false,
    profileSearch: { value: '' },
    visibleProfiles: () => [],
    syncProfileSelection () {},
    document: { activeElement: {}, querySelector: () => ({}), createElement: () => ({}) }
  })
  loadFunctions(context, ['renderProfiles', 'clearProfileDropFeedback', 'finishProfileDrag'])
  context.renderProfiles()
  context.renderProfiles()
  assert.equal(rebuilds, 0)
  context.finishProfileDrag()
  assert.equal(rebuilds, 1)
  assert.equal(removedSorting, 1)
  assert.equal(context.profileDrag, null)
  context.finishProfileDrag()
  assert.equal(rebuilds, 1)
})

/** 原生指针和帧时钟由桩驱动，命中、取消和最终提交执行真实 renderer 函数。 */
async function pointerHarness () {
  const h = await harness()
  const frames = new Map()
  const canceled = []
  const released = []
  const captured = new Set()
  const listeners = new Map()
  const previews = []
  const targets = []
  let frameId = 0
  let hit = () => null
  const makeNode = (top = 0, height = 60) => {
    const classes = new Set()
    return {
      classes,
      style: {},
      dataset: {},
      events: {},
      removed: false,
      classList: {
        add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)),
        toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name)
      },
      setAttribute (key, value) { this[key] = value },
      addEventListener (type, handler) { this.events[type] = handler },
      focus (options) { this.focusOptions = options },
      setPointerCapture: id => captured.add(id),
      hasPointerCapture: id => captured.has(id),
      releasePointerCapture: id => { captured.delete(id); released.push(id) },
      getBoundingClientRect: () => ({ top, height, bottom: top + height, left: 0, right: 300 }),
      closest () { return this },
      remove () { this.removed = true }
    }
  }
  const list = makeNode(0, 500)
  list.scrollTop = 100
  list.querySelectorAll = selector => selector === '.profile-item' ? targets : targets.filter(target => [...target.classes].some(name => name.startsWith('profile-drop-')))
  Object.assign(h.context, {
    profileDrag: null,
    profileDragFrame: null,
    profileDropTargets: new WeakMap(),
    managingProfiles: false,
    elements: { profileList: list },
    createButton: (text, className, action) => {
      const node = makeNode()
      node.textContent = text
      node.className = className
      node.events.click = action
      return node
    },
    document: {
      createElement: () => makeNode(),
      body: { append: node => previews.push(node) },
      elementFromPoint: (x, y) => hit(x, y)
    },
    window: {
      requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId },
      cancelAnimationFrame: id => { canceled.push(id); frames.delete(id) },
      addEventListener: (type, callback) => listeners.set(type, callback)
    }
  })
  loadFunctions(h.context, ['createProfileDragHandle', 'bindProfileDropTarget', 'moveProfileDrag', 'updateProfileDrag', 'clearProfileDropFeedback', 'finishProfileDrag'])
  const begin = source.indexOf("window.addEventListener('pointermove', moveProfileDrag)")
  const end = source.indexOf("document.querySelector('#open-files').addEventListener", begin)
  assert.notEqual(begin, -1)
  assert.notEqual(end, -1)
  vm.runInContext(source.slice(begin, end), h.context)
  return {
    ...h,
    frames,
    canceled,
    released,
    captured,
    listeners,
    previews,
    list,
    setHit: callback => { hit = callback },
    target: (group, profileId, top = 100) => {
      const node = makeNode(top)
      node.dataset.profileId = profileId
      targets.push(node)
      h.context.bindProfileDropTarget(node, group, profileId)
      return node
    }
  }
}

function pointerEvent (overrides = {}) {
  return { button: 0, isPrimary: true, pointerId: 7, clientX: 100, clientY: 100, preventDefault () {}, stopPropagation () {}, ...overrides }
}

test('pointer sorting only captures a primary left press and sub-threshold clicks never save or connect', async () => {
  const h = await pointerHarness()
  const handle = h.context.createProfileDragHandle(['jp'], 'jp', 'profile')
  assert.equal(handle['aria-disabled'], 'false')
  h.context.profileOrganizationSaving = true
  handle.events.pointerdown(pointerEvent())
  h.context.profileOrganizationSaving = false
  handle.events.pointerdown(pointerEvent({ button: 2 }))
  handle.events.pointerdown(pointerEvent({ isPrimary: false }))
  assert.equal(h.context.profileDrag, null)
  assert.equal(h.captured.size, 0)
  handle.events.pointerdown(pointerEvent())
  assert.equal(h.captured.has(7), true)
  assert.equal(handle.focusOptions.preventScroll, true)
  h.listeners.get('pointermove')(pointerEvent({ clientX: 103 }))
  assert.equal(h.context.profileDrag.moved, false)
  assert.equal(h.previews.length, 0)
  h.listeners.get('pointerup')(pointerEvent({ clientX: 103 }))
  assert.equal(h.context.profileDrag, null)
  assert.deepEqual(h.released, [7])
  assert.equal(h.frames.size, 0)
  assert.deepEqual(h.changes, [])
  assert.deepEqual(h.networkCalls, [])
})

test('Escape, pointer cancellation and window blur remove only temporary drag state and never save', async () => {
  for (const type of ['keydown', 'pointercancel', 'blur']) {
    const h = await pointerHarness()
    const operations = h.groups().find(group => group.key === 'group:operations')
    const target = h.target(operations, 'api')
    h.setHit(() => target)
    const handle = h.context.createProfileDragHandle(['jp'], 'jp', 'profile')
    handle.events.pointerdown(pointerEvent())
    h.listeners.get('pointermove')(pointerEvent({ clientX: 110 }))
    assert.equal(h.context.profileDrag.moved, true)
    assert.equal(h.frames.size, 1)
    assert.equal(target.classes.has('profile-drop-before'), true)
    h.listeners.get(type)(pointerEvent({ key: 'Escape' }))
    assert.equal(h.context.profileDrag, null)
    assert.equal(h.context.profileDragFrame, null)
    assert.equal(h.frames.size, 0)
    assert.equal(h.previews[0].removed, true)
    assert.deepEqual(h.released, [7])
    assert.equal(h.list.classes.has('profile-sorting'), false)
    assert.equal(target.classes.size, 0)
    assert.deepEqual(h.changes, [])
    assert.equal(h.state.profiles, h.profiles)
    assert.deepEqual(h.networkCalls, [])
  }
})

test('fast pointerup commits its final coordinates rather than the previous animation-frame target', async () => {
  const h = await pointerHarness()
  const prod = h.target(h.groups().find(group => group.key === 'group:prod'), 'prod2', 70)
  const operations = h.target(h.groups().find(group => group.key === 'group:operations'), 'web', 220)
  h.setHit((_x, y) => y < 200 ? prod : operations)
  const handle = h.context.createProfileDragHandle(['jp'], 'jp', 'profile')
  handle.events.pointerdown(pointerEvent())
  h.listeners.get('pointermove')(pointerEvent({ clientX: 110 }))
  assert.equal(h.context.profileDrag.target.element, prod)
  // 不运行下一帧，直接松手到另一组下半区，验证最终命中会替换旧落点。
  h.listeners.get('pointerup')(pointerEvent({ clientX: 110, clientY: 270 }))
  assert.deepEqual({ ...h.changes[0] }, { ids: ['jp'], group: 'Operations', order: ['prod2', 'prod1', 'api', 'web', 'jp', 'home'] })
  assert.equal(h.context.profileDrag, null)
  assert.equal(h.frames.size, 0)
  assert.equal(h.canceled.length, 2)
  assert.deepEqual(h.released, [7])
  assert.equal(h.previews[0].removed, true)
  assert.deepEqual(h.networkCalls, [])
  h.pending[0].resolve(h.profiles)
  await new Promise(resolve => setImmediate(resolve))
})

test('self-target and off-list pointer releases do not mutate profiles or leave a frame running', async () => {
  for (const self of [true, false]) {
    const h = await pointerHarness()
    const jp = h.target(h.groups()[0], 'jp')
    h.setHit(() => self ? jp : null)
    const handle = h.context.createProfileDragHandle(['jp'], 'jp', 'profile')
    handle.events.pointerdown(pointerEvent())
    h.listeners.get('pointermove')(pointerEvent({ clientX: 110 }))
    h.listeners.get('pointerup')(pointerEvent({ clientX: 110 }))
    assert.equal(h.context.profileDrag, null)
    assert.equal(h.frames.size, 0)
    assert.deepEqual(h.released, [7])
    assert.equal(h.previews[0].removed, true)
    assert.deepEqual(h.changes, [])
    assert.deepEqual(h.networkCalls, [])
  }
})
