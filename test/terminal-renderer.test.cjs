'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

/** 用可触发丢失事件的 addon 桩执行真实控制器，不需要显卡，也不复刻窗口/SSH 行为。 */
async function harness () {
  const { TerminalRenderer } = await import('../src/terminal-renderer.mjs')
  const addons = []
  const makeTerminal = () => ({ element: {}, loadAddon (addon) { this.addon = addon } })
  const renderer = new TerminalRenderer(() => {
    const addon = {
      disposed: 0,
      onContextLoss: handler => { addon.lose = handler; return { dispose: () => { addon.unsubscribed = true } } },
      dispose: () => { addon.disposed++ }
    }
    addons.push(addon)
    return addon
  })
  return { renderer, addons, makeTerminal }
}

test('only the active opened terminal holds a context and repeated presentation does not recreate it', async () => {
  const h = await harness()
  let changes = 0
  const a = h.makeTerminal()
  const b = h.makeTerminal()
  h.renderer.use({})
  assert.equal(h.addons.length, 0)
  h.renderer.use(a, () => { changes++ })
  h.renderer.use(a)
  assert.equal(h.addons.length, 1)
  assert.equal(changes, 1)
  h.renderer.use(b)
  assert.equal(h.addons[0].disposed, 1)
  assert.equal(changes, 2)
  assert.equal(h.renderer.active.terminal, b)
  h.renderer.release(a)
  assert.equal(h.addons[1].disposed, 0)
  h.renderer.use(null)
  assert.equal(h.addons[1].disposed, 1)
  assert.equal(h.renderer.active, null)
})

test('context loss falls back once without retrying a broken terminal or affecting another one', async () => {
  const h = await harness()
  const a = h.makeTerminal()
  const b = h.makeTerminal()
  h.renderer.use(a)
  h.addons[0].lose()
  assert.equal(h.renderer.active, null)
  assert.equal(h.addons[0].disposed, 1)
  assert.equal(h.addons[0].unsubscribed, true)
  h.renderer.use(a)
  assert.equal(h.addons.length, 1)
  h.renderer.use(b)
  h.addons[0].lose()
  assert.equal(h.renderer.active.terminal, b)
  assert.equal(h.addons[1].disposed, 0)
})

test('unavailable GPU and partially loaded addons do not prevent the terminal from remaining usable', async () => {
  const h = await harness()
  const a = h.makeTerminal()
  a.loadAddon = () => { throw new Error('GPU unavailable') }
  assert.doesNotThrow(() => h.renderer.use(a))
  assert.equal(h.addons[0].disposed, 1)
  assert.equal(h.renderer.active, null)
  h.renderer.use(a)
  assert.equal(h.addons.length, 1)
  h.renderer.createAddon = () => { throw new Error('driver unavailable') }
  assert.doesNotThrow(() => h.renderer.use(h.makeTerminal()))
})
