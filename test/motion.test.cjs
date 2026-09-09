'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const vm = require('node:vm')
const { readFileSync } = require('node:fs')
const path = require('node:path')

test('surface motion replaces previous animation and respects reduced motion and detached nodes', async t => {
  const { animateSurface } = await import('../src/motion.mjs')
  const previousWindow = global.window
  let reduced = false
  global.window = { matchMedia: () => ({ matches: reduced }) }
  t.after(() => { if (previousWindow === undefined) delete global.window; else global.window = previousWindow })
  const calls = []
  const element = {
    isConnected: true,
    animate: (frames, options) => {
      const animation = { canceled: false, cancel () { this.canceled = true } }
      calls.push({ frames, options, animation })
      return animation
    }
  }
  animateSurface(element)
  animateSurface(element, 'settle')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].animation.canceled, true)
  assert.equal(calls[1].options.duration, 160)
  assert.equal(calls[0].frames.some(frame => 'transform' in frame), false)
  reduced = true
  animateSurface(element)
  assert.equal(calls[1].animation.canceled, true)
  assert.equal(calls.length, 2)
  reduced = false
  element.isConnected = false
  animateSurface(element)
  assert.equal(calls.length, 2)
})

test('native close action closes only a selected server and leaves modal/local workspace intact', async () => {
  const source = readFileSync(path.join(__dirname, '../src/main.js'), 'utf8')
  let modal = false
  let closed = 0
  const notices = []
  const state = { sessions: new Map([['ssh-a', {}]]), activeSessionId: 'ssh-a', sftpActive: false, sftp: null }
  const context = vm.createContext({
    state,
    document: { querySelector: () => modal },
    notify: text => notices.push(text),
    errorMessage: error => error.message,
    closeActiveSession: async () => { closed++ }
  })
  vm.runInContext(source.slice(source.indexOf('function handleAppAction ('), source.indexOf('const resizeObserver =')), context)
  context.handleAppAction('unknown')
  assert.equal(closed, 0)
  modal = true
  context.handleAppAction('close-connection')
  assert.equal(closed, 0)
  modal = false
  context.handleAppAction('close-connection')
  assert.equal(closed, 1)
  state.sftpActive = true
  context.handleAppAction('close-connection')
  assert.equal(closed, 1)
  state.sftp = { connectionId: 'remote-a' }
  context.handleAppAction('close-connection')
  assert.equal(closed, 2)
  assert.equal(notices.length, 2)
})
