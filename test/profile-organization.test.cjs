'use strict'

const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { readFileSync } = require('node:fs')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const { ProfileStore } = require('../lib/profile-store.cjs')
const { normalizeProfileInput } = require('../lib/ssh-args.cjs')

const input = { name: '生产1', host: 'example.com', username: 'root', port: 22, auth: 'agent', privateKeyPath: null }

/** 每个用例使用独立临时配置，不触及用户的服务器、凭据或正在运行的连接。 */
async function fixture (t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'serverlink-organization-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const store = new ProfileStore(directory)
  const profiles = []
  for (let index = 1; index <= 3; index++) profiles.push(await store.create({ ...input, name: `生产${index}` }))
  return { directory, store, profiles, ids: profiles.map(profile => profile.id) }
}

test('organization loads legacy v1 profiles and strips unrelated stored secret fields', async t => {
  const { directory, store, profiles } = await fixture(t)
  const document = { version: 1, profiles: profiles.map(profile => ({ ...profile, password: 'not-allowed', passphrase: 'not-allowed', extra: true })) }
  await fs.writeFile(store.filePath, JSON.stringify(document))
  const reloaded = new ProfileStore(directory)
  assert.deepEqual(await reloaded.list(), profiles)
  const organized = await reloaded.organize({ ids: [profiles[0].id], group: '测试' })
  assert.equal(organized[0].group, '测试')
  assert.equal(organized.every(profile => !Object.hasOwn(profile, 'order')), true)
  assert.doesNotMatch(await fs.readFile(store.filePath, 'utf8'), /not-allowed|passphrase|password|extra/u)
})

test('organization persists one atomic group and order change and survives connection edits and reload', async t => {
  const { directory, store, profiles, ids } = await fixture(t)
  let writes = 0
  const persist = store.persist.bind(store)
  store.persist = async value => { writes++; return persist(value) }
  const organized = await store.organize({ ids: [ids[0], ids[2]], group: '  核心服务  ', order: [ids[2], ids[1], ids[0]] })
  assert.equal(writes, 1)
  assert.deepEqual(organized.map(profile => profile.id), [ids[2], ids[1], ids[0]])
  assert.deepEqual(organized.map(profile => profile.order), [0, 1, 2])
  assert.deepEqual(organized.map(profile => profile.group), ['核心服务', undefined, '核心服务'])
  assert.deepEqual(await new ProfileStore(directory).list(), organized)

  organized[0].group = 'cannot-mutate-store'
  assert.equal((await store.get(ids[2])).group, '核心服务')
  const edited = await store.update(ids[0], { ...input, name: '新版配置', host: 'updated.example.com' })
  assert.equal(edited.group, '核心服务')
  assert.equal(edited.order, 2)
  assert.equal(edited.createdAt, profiles[0].createdAt)
  assert.equal(edited.host, 'updated.example.com')
  assert.deepEqual(await new ProfileStore(directory).list(), await store.list())
  await assert.rejects(store.update(ids[0], { ...input, group: '绕过专用接口' }), /unsupported field/u)
  assert.throws(() => normalizeProfileInput({ ...input, order: 0 }), /unsupported field/u)
})

test('explicit ungroup and restored automatic grouping differ without changing stored order', async t => {
  const { store, ids } = await fixture(t)
  await store.organize({ order: ids.toReversed() })
  await store.organize({ ids: [ids[0], ids[1]], group: '共同分组' })
  const ungrouped = await store.organize({ ids: [ids[0]], group: '' })
  assert.equal(ungrouped.find(profile => profile.id === ids[0]).group, '')
  const restored = await store.organize({ ids: [ids[0]], group: null })
  assert.equal(Object.hasOwn(restored.find(profile => profile.id === ids[0]), 'group'), false)
  assert.equal(restored.find(profile => profile.id === ids[1]).group, '共同分组')
  assert.deepEqual(restored.map(profile => profile.id), ids.toReversed())
  assert.deepEqual(restored.map(profile => profile.order), [0, 1, 2])
  const created = await store.create({ ...input, name: '后来新增' })
  assert.equal(Object.hasOwn(created, 'order'), false)
  assert.equal((await store.list()).at(-1).id, created.id)
})

test('organization rejects malformed, stale, duplicate, excessive and non-metadata input without writes', async t => {
  const { store, ids } = await fixture(t)
  const before = await store.list()
  const diskBefore = await fs.readFile(store.filePath, 'utf8')
  let writes = 0
  store.persist = async () => { writes++ }
  const invalid = [
    null, [], {}, new Date(), { ids }, { group: '组' },
    { ids: [], group: '组' }, { ids: new Array(1), group: '组' }, { ids: [ids[0], ids[0]], group: '组' },
    { ids: [randomUUID()], group: '组' }, { ids: ['invalid-id'], group: '组' },
    { ids: Array.from({ length: 101 }, randomUUID), group: '组' },
    { order: [] }, { order: new Array(3) }, { order: ids.slice(1) }, { order: [...ids, randomUUID()] },
    { order: [ids[0], ids[0], ids[2]] }, { order: [ids[0], randomUUID(), ids[2]] },
    { order: Array.from({ length: 10001 }, randomUUID) },
    { ids: [ids[0]], group: '组', host: 'injected.example.com' },
    { ids: [ids[0]], group: '组', password: 'secret' },
    { order: ids, privateKeyPath: '/etc/passwd' },
    { ids: [ids[0]], group: '组', [Symbol('extra')]: true }
  ]
  for (const group of [undefined, false, 1, {}, 'x'.repeat(81), '组\n', '\t组', 'a\u0000b', 'a\u007fb', 'a\u0085b']) {
    invalid.push({ ids: [ids[0]], group })
  }
  for (const change of invalid) await assert.rejects(store.organize(change))
  assert.equal(writes, 0)
  assert.deepEqual(await store.list(), before)
  assert.equal(await fs.readFile(store.filePath, 'utf8'), diskBefore)
})

test('invalid stored organization fields fail validation instead of entering renderer state', async t => {
  const { directory, store, profiles } = await fixture(t)
  for (const metadata of [{ group: null }, { group: ['group'] }, { group: 'unsafe\n' }, { order: -1 }, { order: 1.2 }, { order: '0' }, { order: Number.MAX_SAFE_INTEGER + 1 }]) {
    await fs.writeFile(store.filePath, JSON.stringify({ version: 1, profiles: [{ ...profiles[0], ...metadata }] }))
    await assert.rejects(new ProfileStore(directory).list())
  }
})

test('failed organization persistence keeps both group and order unchanged and queue stays usable', async t => {
  const { directory, store, ids } = await fixture(t)
  const before = await store.list()
  const persist = store.persist.bind(store)
  store.persist = async () => { throw new Error('simulated disk failure') }
  await assert.rejects(store.organize({ ids: [ids[0]], group: '未保存', order: ids.toReversed() }), /disk failure/u)
  assert.deepEqual(await store.list(), before)
  assert.deepEqual(await new ProfileStore(directory).list(), before)
  store.persist = persist
  await store.organize({ ids: [ids[0]], group: '已保存' })
  assert.equal((await store.get(ids[0])).group, '已保存')
})

test('queued organization validates latest membership and preserves independent concurrent changes', async t => {
  const { store, ids } = await fixture(t)
  // 创建和删除先入队时，旧的完整排序不能覆盖队列内最新集合。
  const created = store.create({ ...input, name: '新增' })
  const staleCreateOrder = store.organize({ ids: [ids[0]], group: '不能部分保存', order: ids })
  await assert.rejects(staleCreateOrder, /列表已变化/u)
  const newest = await created
  assert.equal(Object.hasOwn(await store.get(ids[0]), 'group'), false)
  const removing = store.remove(newest.id)
  const staleRemoveOrder = store.organize({ order: [...ids, newest.id] })
  await assert.rejects(staleRemoveOrder, /列表已变化/u)
  await removing

  await Promise.all([
    store.organize({ ids: [ids[0]], group: 'A' }),
    store.organize({ ids: [ids[1]], group: 'B' }),
    store.update(ids[2], { ...input, name: '并发编辑' })
  ])
  assert.deepEqual((await store.list()).map(profile => profile.group), ['A', 'B', undefined])
  assert.equal((await store.get(ids[2])).name, '并发编辑')

  const mutable = { ids: [ids[2]], group: '快照', order: ids.toReversed() }
  const saving = store.organize(mutable)
  mutable.ids[0] = ids[0]
  mutable.order.reverse()
  mutable.group = '后来更改'
  await saving
  assert.equal((await store.get(ids[2])).group, '快照')
  assert.deepEqual((await store.list()).map(profile => profile.id), ids.toReversed())
})

test('organization IPC requires the bundled main document and preload exposes only its fixed channel', async () => {
  const source = readFileSync(path.join(__dirname, '../main.cjs'), 'utf8')
  const handlers = new Map()
  const calls = []
  const rendererUrl = 'file:///fixture/dist/index.html'
  const context = vm.createContext({
    bundledRendererUrl: rendererUrl,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    profileStore: { organize: async change => { calls.push(change); return ['latest-profiles'] } }
  })
  // 执行真实校验和注册函数，其他 IPC 仅注册不调用，不需要启动 Electron 或真实连接。
  vm.runInContext(source.slice(source.indexOf('function assertMainFrame ('), source.indexOf('/** Resolves an IPC')), context)
  vm.runInContext(source.slice(source.indexOf('function registerIpc ('), source.indexOf('/** Creates the only application')), context)
  vm.runInContext('registerIpc()', context)
  const organize = handlers.get('profiles:organize')
  const sender = { id: 1, mainFrame: { url: rendererUrl }, getURL: () => rendererUrl }
  const change = { ids: [randomUUID()], group: '测试组' }
  assert.deepEqual(await organize({ sender, senderFrame: sender.mainFrame }, change), ['latest-profiles'])
  assert.throws(() => organize({ sender, senderFrame: { url: rendererUrl } }, change), /untrusted document/u)
  sender.mainFrame.url = 'https://untrusted.example'
  assert.throws(() => organize({ sender, senderFrame: sender.mainFrame }, change), /untrusted document/u)
  sender.mainFrame.url = rendererUrl
  sender.getURL = () => 'https://untrusted.example'
  assert.throws(() => organize({ sender, senderFrame: sender.mainFrame }, change), /untrusted document/u)
  assert.deepEqual(calls, [change])

  let api
  const invocations = []
  vm.runInNewContext(readFileSync(path.join(__dirname, '../preload.cjs'), 'utf8'), {
    require: name => {
      assert.equal(name, 'electron')
      return { contextBridge: { exposeInMainWorld: (_name, exposed) => { api = exposed } }, ipcRenderer: { invoke: (...args) => invocations.push(args) } }
    }
  })
  api.profiles.organize(change)
  assert.deepEqual(invocations, [['profiles:organize', change]])
  assert.equal(Object.isFrozen(api.profiles), true)
})
