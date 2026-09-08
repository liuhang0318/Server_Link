'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { removeOlderPackages } = require('../build/package-mac.cjs')

test('installer cleanup preserves newer versions, unrelated files and symlinks', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'serverlink-cleanup-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  await fs.mkdir(path.join(directory, 'obsolete'))
  const files = [
    'ServerLink-0.2.0-arm64.dmg', 'ServerLink-0.2.0-arm64.dmg.sha256',
    'obsolete/ServerLink-0.1.0-arm64.dmg',
    'ServerLink-0.2.1-arm64.dmg', 'ServerLink-0.10.0-arm64.dmg',
    'ServerLink-0.1.0-x64.dmg', 'profiles.json'
  ]
  for (const file of files) await fs.writeFile(path.join(directory, file), 'fixture')
  await fs.symlink(path.join(directory, 'profiles.json'), path.join(directory, 'ServerLink-0.0.1-arm64.dmg'))
  const removed = await removeOlderPackages(directory, '0.2.1')
  assert.equal(removed.length, 3)
  for (const file of files.slice(3)) await fs.access(path.join(directory, file))
  assert.ok((await fs.lstat(path.join(directory, 'ServerLink-0.0.1-arm64.dmg'))).isSymbolicLink())
  for (const file of files.slice(0, 3)) {
    await assert.rejects(fs.access(path.join(directory, file)), { code: 'ENOENT' })
  }
  assert.deepEqual(await removeOlderPackages(directory, '0.2.1'), [])
})
