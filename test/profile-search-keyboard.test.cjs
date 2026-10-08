'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const vm = require('node:vm')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const source = readFileSync(path.join(__dirname, '../src/main.js'), 'utf8')

/** 执行真实搜索及键盘入口，记录连接和焦点顺序，不启动任何 SSH。 */
function harness () {
  const calls = []
  let modal = false
  const state = {
    profiles: [
      { id: 'a', name: '生产API', host: 'api.example.com', username: 'root', group: '线上' },
      { id: 'b', name: '生产Web', host: 'web.example.com', username: 'deploy', group: '线上' }
    ],
    connectingProfiles: new Set()
  }
  const search = { value: 'API', blur: () => calls.push('blur') }
  const context = vm.createContext({
    state,
    profileSearch: search,
    managingProfiles: false,
    profileOrganizationSaving: false,
    document: { querySelector: () => modal },
    connectProfile: id => calls.push(`connect:${id}`),
    renderProfiles: () => calls.push('render')
  })
  for (const name of ['visibleProfiles', 'handleProfileSearchKey']) {
    const start = source.indexOf(`function ${name} (`)
    assert.notEqual(start, -1)
    vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), context)
  }
  return { state, search, calls, context, setModal: value => { modal = value }, key: overrides => context.handleProfileSearchKey({ key: 'Enter', preventDefault: () => calls.push('prevent'), ...overrides }) }
}

test('Enter connects only the unique literal search result after handing off search focus', () => {
  const h = harness()
  h.key()
  assert.deepEqual(h.calls, ['prevent', 'blur', 'connect:a'])
  for (const term of ['web.example.com', 'deploy']) {
    h.calls.length = 0
    h.search.value = term
    h.key()
    assert.deepEqual(h.calls, ['prevent', 'blur', 'connect:b'])
  }
})

test('empty, multiple, no results and an in-flight connection never cause an extra connection', () => {
  const h = harness()
  for (const term of ['', '  ', '生产', '线上', 'missing']) {
    h.search.value = term
    h.key()
    assert.deepEqual(h.calls, [])
  }
  h.search.value = 'API'
  h.state.connectingProfiles.add('a')
  h.key()
  assert.deepEqual(h.calls, ['prevent'])
})

test('IME, repeated keys, modifiers, management and dialogs cannot accidentally connect', () => {
  for (const options of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { key: 'a' }]) {
    const h = harness()
    h.key(options)
    assert.deepEqual(h.calls, [])
  }
  for (const flag of ['managingProfiles', 'profileOrganizationSaving', 'modal']) {
    const h = harness()
    if (flag === 'modal') h.setModal(true)
    else h.context[flag] = true
    h.key()
    assert.deepEqual(h.calls, [])
  }
})

test('Escape clears the filter without connecting or moving focus away from search', () => {
  const h = harness()
  h.key({ key: 'Escape' })
  assert.equal(h.search.value, '')
  assert.deepEqual(h.calls, ['prevent', 'render'])
  h.calls.length = 0
  h.key({ key: 'Escape' })
  assert.deepEqual(h.calls, [])
})
