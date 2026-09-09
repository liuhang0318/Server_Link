'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const vm = require('node:vm')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const source = readFileSync(path.join(__dirname, '../src/main.js'), 'utf8')

test('each upload target unlocks independently and old batch completion cannot clear a new upload', async () => {
  const pending = new Map()
  const targets = ['fast', 'slow'].map(connectionId => ({ connectionId, title: connectionId, path: '/', status: 'ready', busy: false }))
  const context = vm.createContext({
    localUploading: false,
    syncLocalActions () {},
    renderRemoteChoices () {},
    renderSftpFiles () {},
    refreshSftpAfterOperation: async () => {},
    setSftpBusy: (busy, _message, target) => { target.busy = busy },
    document: { querySelector: () => ({ classList: { remove () {} }, append () {}, replaceChildren () {} }), createElement: () => ({}) },
    api: { local: { upload: (_ids, selected) => new Promise(resolve => pending.set(selected[0].connectionId, resolve)) } }
  })
  vm.runInContext(source.slice(source.indexOf('async function uploadLocalSelection ('), source.indexOf('/** 恢复每个 SFTP')), context)
  const finished = context.uploadLocalSelection(targets, ['fixture-folder'])
  assert.equal(pending.size, 2)
  pending.get('fast')([{ name: 'folder', canceled: true, success: false }])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(targets[0].busy, false)
  assert.equal(targets[1].busy, true)
  // 已取消的目标可开始独立新上传；另一台旧批次结束不准改变新任务的 busy。
  targets[0].busy = true
  pending.get('slow')([{ name: 'folder', success: true }])
  await finished
  assert.equal(targets[0].busy, true)
  assert.equal(targets[1].busy, false)
  assert.equal(context.localUploading, false)
})

test('dismissing the native chooser hides the preparing indicator and releases the connection', async () => {
  let hidden = false
  const connection = { busy: false, connectionId: 'fixture', path: '/', ui: { transfer: { classList: { add: () => { hidden = true } } } } }
  const context = vm.createContext({
    api: { sftp: { upload: async () => ({ canceled: true }) } },
    setSftpBusy: busy => { connection.busy = busy },
    renderSftpFiles () {}
  })
  vm.runInContext(source.slice(source.indexOf('async function uploadSftpFile ('), source.indexOf('async function downloadSftpFile (')), context)
  await context.uploadSftpFile(connection)
  assert.equal(hidden, true)
  assert.equal(connection.busy, false)
})
