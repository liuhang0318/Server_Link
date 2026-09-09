'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const vm = require('node:vm')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const source = readFileSync(path.join(__dirname, '../src/main.js'), 'utf8')
const css = readFileSync(path.join(__dirname, '../src/style.css'), 'utf8')

/** 执行实际拖放处理器，断言落点反馈、子元素移动和文件夹转交，不访问浏览器或文件系统。 */
function dragHarness () {
  const handlers = {}
  const classes = new Set()
  const uploads = []
  const connection = { status: 'ready', busy: false, title: 'Fixture', path: '/demo' }
  const target = {
    dataset: {},
    addEventListener: (name, handler) => { handlers[name] = handler },
    contains: child => child === 'child',
    getBoundingClientRect: () => ({ left: 10, right: 100, top: 10, bottom: 100 }),
    classList: {
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
      remove: (...names) => names.forEach(name => classes.delete(name))
    }
  }
  const context = vm.createContext({
    state: { draggedRemote: null },
    draggedLocalIds: null,
    isFileDrag: () => true,
    clearFileDragFeedback: () => classes.clear(),
    notify () {},
    uploadDroppedFiles: (current, files) => uploads.push({ current, files })
  })
  vm.runInContext(source.slice(source.indexOf('function bindSftpDropTarget ('), source.indexOf('/** 提交前显示具体来源')), context)
  context.bindSftpDropTarget(target, () => connection)
  const folder = { name: 'fixture-folder' }
  const event = { preventDefault () {}, clientX: 50, clientY: 50, relatedTarget: null, dataTransfer: { files: [folder], dropEffect: '' } }
  return { handlers, classes, connection, target, uploads, event, folder }
}

test('valid folder drag highlights its pane without flicker when moving across children', () => {
  const h = dragHarness()
  h.handlers.dragover(h.event)
  assert.equal(h.classes.has('drop-target'), true)
  assert.equal(h.event.dataTransfer.dropEffect, 'copy')
  assert.match(h.target.dataset.dropMessage, /文件夹/u)
  h.handlers.dragleave(h.event)
  assert.equal(h.classes.has('drop-target'), true)
  h.handlers.dragleave({ ...h.event, clientX: 101 })
  assert.equal(h.classes.has('drop-target'), false)
  h.handlers.drop(h.event)
  assert.equal(h.uploads.length, 1)
  assert.equal(h.uploads[0].files[0], h.folder)
  assert.match(css, /\.remote-pane\.drop-target::after/u)
})

test('busy target rejects drops and never starts upload', () => {
  const h = dragHarness()
  h.connection.busy = true
  h.handlers.dragover(h.event)
  assert.equal(h.classes.has('drop-rejected'), true)
  assert.equal(h.event.dataTransfer.dropEffect, 'none')
  h.handlers.drop(h.event)
  assert.equal(h.uploads.length, 0)
})
