'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { Writable } = require('node:stream')
const { SftpManager } = require('../lib/sftp-manager.cjs')
const { MAX_UPLOAD_ENTRIES, MAX_UPLOAD_DEPTH, scanUploadSources, openUploadSource } = require('../lib/upload-sources.cjs')

const connectionId = '89c89d7c-68b8-41b7-a065-9ec8f41d61ca'

/** 内存文件服务保留标准 rename 的非覆盖语义，测试不连接真实服务器。 */
function fixture () {
  const entries = new Map([['/target', { type: 'directory' }]])
  const calls = []
  const hooks = {}
  const missing = () => Object.assign(new Error('missing'), { code: 2 })
  const sftp = {
    lstat: (name, callback) => callback(entries.has(name) ? null : missing(), entries.get(name)),
    mkdir: (name, _options, callback) => {
      calls.push(['mkdir', name])
      if (entries.has(name)) return callback(new Error('exists'))
      entries.set(name, { type: 'directory' })
      hooks.mkdir?.(name)
      callback()
    },
    createWriteStream: name => {
      calls.push(['write', name])
      const chunks = []
      const stream = new Writable({
        write: (chunk, _encoding, callback) => {
          setImmediate(() => {
            stream.bytesWritten += chunk.length
            chunks.push(Buffer.from(chunk))
            callback()
            hooks.write?.(name)
          })
        },
        final: callback => {
          entries.set(name, { type: 'file', data: Buffer.concat(chunks) })
          callback()
        }
      })
      stream.bytesWritten = 0
      process.nextTick(() => {
        entries.set(name, { type: 'file', data: Buffer.alloc(0) })
        stream.emit('open')
      })
      return stream
    },
    rename: (from, to, callback) => {
      calls.push(['rename', from, to])
      hooks.beforeRename?.(from, to)
      if (entries.has(to)) return callback(new Error('同名目标已存在'))
      for (const [name, entry] of [...entries]) {
        if (name === from || name.startsWith(`${from}/`)) {
          entries.set(to + name.slice(from.length), entry)
          entries.delete(name)
        }
      }
      callback()
      hooks.afterRename?.(from, to)
    },
    unlink: (name, callback) => {
      calls.push(['unlink', name])
      assert.equal(entries.get(name)?.type, 'file')
      entries.delete(name)
      callback()
    },
    rmdir: (name, callback) => {
      calls.push(['rmdir', name])
      assert.equal([...entries.keys()].some(entry => entry.startsWith(`${name}/`)), false, 'cleanup must remove children before parents')
      entries.delete(name)
      callback()
    },
    end: () => { calls.push(['end']) }
  }
  const manager = new SftpManager({ knownHostsPath: '/tmp/serverlink-test-unused-hosts', confirmHost: async () => false })
  const record = { id: connectionId, ownerId: 7, sftp, client: { end: () => {} } }
  manager.connections.set(connectionId, record)
  return { manager, record, entries, calls, hooks }
}

async function temporaryDirectory (t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'serverlink-upload-batch-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}

test('folder upload publishes complete structure and empty directories with batch byte progress', async t => {
  const directory = await temporaryDirectory(t)
  const folder = path.join(directory, 'folder')
  await fs.mkdir(path.join(folder, 'nested', 'empty'), { recursive: true })
  await fs.writeFile(path.join(folder, 'nested', 'data.txt'), 'hello')
  const other = path.join(directory, 'other.txt')
  await fs.writeFile(other, 'world!')
  const { manager, record, entries } = fixture()
  const progress = []
  const result = await manager.uploadBatch(7, connectionId, '/target', [folder, other], event => progress.push(event))
  assert.deepEqual(result.map(item => item.success), [true, true])
  assert.equal(entries.get('/target/folder/nested/empty').type, 'directory')
  assert.equal(entries.get('/target/folder/nested/data.txt').data.toString(), 'hello')
  assert.equal(entries.get('/target/other.txt').data.toString(), 'world!')
  assert.equal([...entries.keys()].some(name => name.includes('.serverlink-')), false)
  assert.equal(record.upload, null)
  assert.equal(progress[0].phase, 'preparing')
  assert.equal(progress[0].total, 0)
  assert.equal(progress.at(-1).phase, 'completed')
  assert.equal(progress.at(-1).total, 11)
  assert.equal(progress.at(-1).transferred, 11)
  assert.equal(progress.at(-1).fileCount, 2)
  assert.ok(progress.some(event => event.name === 'folder/nested/data.txt'))
  assert.ok(progress.every(event => !JSON.stringify(event).includes(directory)))
})

test('empty top-level folder is uploaded and existing destination directories are never merged', async t => {
  const directory = await temporaryDirectory(t)
  const folder = path.join(directory, 'empty')
  await fs.mkdir(folder)
  const { manager, entries, calls } = fixture()
  assert.equal((await manager.uploadBatch(7, connectionId, '/target', [folder]))[0].success, true)
  const firstCallCount = calls.length
  const result = await manager.uploadBatch(7, connectionId, '/target', [folder])
  assert.equal(result[0].success, false)
  assert.match(result[0].error, /同名/u)
  assert.equal(calls.length, firstCallCount)
  assert.equal(entries.get('/target/empty').type, 'directory')
})

test('cancel during an active file removes staging only, preserves completed items and cancels queued items', async t => {
  const directory = await temporaryDirectory(t)
  const paths = ['first.txt', 'large.bin', 'queued.txt'].map(name => path.join(directory, name))
  await fs.writeFile(paths[0], 'complete')
  await fs.writeFile(paths[1], Buffer.alloc(1024 * 1024))
  await fs.writeFile(paths[2], 'must not upload')
  const { manager, record, entries, calls, hooks } = fixture()
  let firstComplete = false
  hooks.afterRename = (_from, to) => { if (to === '/target/first.txt') firstComplete = true }
  hooks.write = () => { if (firstComplete) manager.cancelUpload(7, connectionId) }
  const progress = []
  const results = await manager.uploadBatch(7, connectionId, '/target', paths, event => progress.push(event))
  assert.equal(results[0].success, true)
  assert.ok(results.slice(1).every(item => item.canceled && !item.success))
  assert.deepEqual([...entries.keys()].sort(), ['/target', '/target/first.txt'])
  assert.equal(progress.at(-1).phase, 'canceled')
  assert.equal(record.upload, null)
  assert.equal(calls.some(call => call[0] === 'end'), false)
  assert.equal(manager.cancelUpload(7, connectionId), false)
  assert.equal(manager.assertOwned(7, connectionId), true)
})

test('cancel while preparing is registered before scanning and a duplicate batch cannot start', async t => {
  const directory = await temporaryDirectory(t)
  const file = path.join(directory, 'fixture.txt')
  await fs.writeFile(file, 'unchanged')
  const { manager, calls } = fixture()
  let duplicate
  const result = await manager.uploadBatch(7, connectionId, '/target', [file], event => {
    if (event.phase !== 'preparing') return
    duplicate = assert.rejects(manager.uploadBatch(7, connectionId, '/target', [file]), /已有上传任务/u)
    assert.throws(() => manager.cancelUpload(8, connectionId), /not found/u)
    assert.equal(manager.cancelUpload(7, connectionId), true)
  })
  await duplicate
  assert.equal(result[0].canceled, true)
  assert.deepEqual(calls, [])
})

test('cancel folder after nested mkdir removes only its own staging tree in reverse order', async t => {
  const directory = await temporaryDirectory(t)
  const folder = path.join(directory, 'folder')
  await fs.mkdir(path.join(folder, 'nested', 'empty'), { recursive: true })
  await fs.writeFile(path.join(folder, 'later.txt'), 'data')
  const { manager, entries, calls, hooks } = fixture()
  entries.set('/target/keep.txt', { type: 'file', data: Buffer.from('safe') })
  hooks.mkdir = name => { if (name.endsWith('/nested')) manager.cancelUpload(7, connectionId) }
  const result = await manager.uploadBatch(7, connectionId, '/target', [folder])
  assert.equal(result[0].canceled, true)
  assert.deepEqual([...entries.keys()].sort(), ['/target', '/target/keep.txt'])
  assert.ok(calls.filter(call => ['unlink', 'rmdir'].includes(call[0])).every(call => call[1].startsWith('/target/.serverlink-')))
})

test('a destination created during folder transfer is preserved and staging is cleaned', async t => {
  const directory = await temporaryDirectory(t)
  const folder = path.join(directory, 'folder')
  await fs.mkdir(folder)
  await fs.writeFile(path.join(folder, 'data.txt'), 'data')
  const { manager, entries, hooks } = fixture()
  hooks.beforeRename = (_from, to) => {
    if (to === '/target/folder') entries.set(to, { type: 'directory', marker: 'existing' })
  }
  const result = await manager.uploadBatch(7, connectionId, '/target', [folder])
  assert.equal(result[0].success, false)
  assert.equal(entries.get('/target/folder').marker, 'existing')
  assert.deepEqual([...entries.keys()].sort(), ['/target', '/target/folder'])
})

test('close connection, owner or application aborts an in-flight batch', async t => {
  const directory = await temporaryDirectory(t)
  const file = path.join(directory, 'file.txt')
  await fs.writeFile(file, 'data')
  for (const close of [manager => manager.close(7, connectionId), manager => manager.closeOwner(7), manager => manager.closeAll()]) {
    const { manager } = fixture()
    const result = await manager.uploadBatch(7, connectionId, '/target', [file], event => {
      if (event.phase === 'preparing') close(manager)
    })
    assert.equal(result[0].canceled, true)
    assert.equal(manager.connections.size, 0)
  }
})

test('source scanning rejects symbolic links, invalid names and excessive folder depth', async t => {
  const directory = await temporaryDirectory(t)
  const outside = path.join(directory, 'outside.txt')
  const linked = path.join(directory, 'linked')
  const folder = path.join(directory, 'folder')
  await fs.writeFile(outside, 'not a selected file')
  await fs.symlink(outside, linked)
  await fs.mkdir(folder)
  await fs.symlink(outside, path.join(folder, 'inside-link'))
  const bad = path.join(directory, 'bad\nname')
  await fs.writeFile(bad, 'bad')
  const deep = path.join(directory, 'deep')
  await fs.mkdir(path.join(deep, ...Array(MAX_UPLOAD_DEPTH + 1).fill('a')), { recursive: true })
  const signal = new AbortController().signal
  const result = await scanUploadSources([linked, folder, bad, deep], signal)
  assert.ok(result.every(item => item.error && item.entries.length === 0))
})

test('source scanning can be canceled and file/parent replacement fails before a source handle is exposed', async t => {
  const directory = await temporaryDirectory(t)
  const folder = path.join(directory, 'folder')
  await fs.mkdir(folder)
  const file = path.join(folder, 'file.txt')
  await fs.writeFile(file, 'selected')
  const controller = new AbortController()
  const scanning = scanUploadSources([folder], controller.signal)
  controller.abort()
  await assert.rejects(scanning, { name: 'AbortError' })

  const signal = new AbortController().signal
  const [source] = await scanUploadSources([folder], signal)
  const entry = source.entries.find(item => item.type === 'file')
  const renamed = path.join(directory, 'renamed')
  await fs.rename(folder, renamed)
  await fs.symlink(renamed, folder)
  await assert.rejects(openUploadSource(entry, signal), /目录.*变化/u)
  await fs.unlink(folder)
  await fs.rename(renamed, folder)
  await fs.rename(file, path.join(folder, 'original.txt'))
  await fs.symlink(path.join(folder, 'original.txt'), file)
  await assert.rejects(openUploadSource(entry, signal))
})

test('directory scan stops at the shared file-and-directory entry limit before remote writes', async t => {
  const directory = await temporaryDirectory(t)
  const folder = path.join(directory, 'too-many')
  await fs.mkdir(folder)
  for (let start = 0; start < MAX_UPLOAD_ENTRIES; start += 64) {
    await Promise.all(Array.from({ length: Math.min(64, MAX_UPLOAD_ENTRIES - start) }, (_, index) => fs.writeFile(path.join(folder, `${start + index}.txt`), '')))
  }
  const { manager, calls } = fixture()
  const [result] = await manager.uploadBatch(7, connectionId, '/target', [folder])
  assert.equal(result.success, false)
  assert.match(result.error, /10000/u)
  assert.deepEqual(calls, [])
})
