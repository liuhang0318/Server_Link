'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { ProfileStore } = require('../lib/profile-store.cjs')

test('batch profiles share root/key, persist together and reject invalid batches without partial writes', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'serverlink-batch-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const store = new ProfileStore(directory)
  await store.init()
  const common = { username: 'root', port: 22, auth: 'key', privateKeyPath: '/tmp/shared key' }
  const created = await store.createBatch(common, '192.0.2.10\r\n\n生产 API,192.0.2.11\n备份，backup.example.com')
  assert.equal(created.length, 3)
  assert.equal(new Set(created.map(item => item.id)).size, 3)
  assert.deepEqual(created.map(item => item.name), ['192.0.2.10', '生产 API', '备份'])
  for (const item of created) {
    for (const [key, value] of Object.entries(common)) assert.equal(item[key], value)
  }
  assert.deepEqual(await new ProfileStore(directory).list(), created)
  const before = await fs.readFile(store.filePath, 'utf8')
  await assert.rejects(store.createBatch(common, '192.0.2.12\nwrong;host'), /第 2 行/u)
  await assert.rejects(store.createBatch(common, 'example.com\nEXAMPLE.com'), /重复/u)
  await assert.rejects(store.createBatch(common, '\n  \n'), /1～100/u)
  await assert.rejects(store.createBatch(common, Array(101).fill('192.0.2.12').join('\n')), /1～100/u)
  await assert.rejects(store.createBatch({ ...common, password: 'secret' }, '192.0.2.12'), /无效/u)
  assert.equal(await fs.readFile(store.filePath, 'utf8'), before)
  assert.deepEqual(await store.list(), created)
})
