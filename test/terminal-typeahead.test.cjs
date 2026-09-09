'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

/** 最小异步 xterm/DOM 桩；write 必须经 flush 才改变真实屏幕，覆盖解析尚未完成的竞争。 */
async function harness (username = 'root') {
  const { TerminalTypeahead } = await import('../src/terminal-typeahead.mjs')
  class Node {
    constructor () { this.children = []; this.style = {}; this.hidden = false; this.textContent = '' }
    append (...nodes) { this.children.push(...nodes) }
    remove () { this.removed = true }
    setAttribute (name, value) { this[name] = value }
    getBoundingClientRect () { return { width: 960, height: 480 } }
  }
  const screen = new Node()
  const mount = { querySelector: () => screen, ownerDocument: { createElement: () => new Node() } }
  const lines = ['']
  const buffer = {
    type: 'normal',
    cursorX: 0,
    cursorY: 0,
    baseY: 0,
    viewportY: 0,
    getLine (index) {
      return { isWrapped: false, translateToString: (trim, start = 0, end = 120) => trim ? (lines[index] || '').slice(start, end).trimEnd() : (lines[index] || '').slice(start, end) }
    }
  }
  const writes = []
  const callbacks = []
  const terminal = {
    buffer: { active: buffer },
    cols: 120,
    rows: 24,
    options: { fontFamily: 'monospace', fontSize: 14, theme: { background: '#11161e' } },
    write: (data, callback) => { writes.push(data); callbacks.push({ data, callback }) }
  }
  let escape = ''
  function parse (data) {
    for (const character of data) {
      if (escape || character === '\x1b') {
        escape += character
        if (escape.length > 2 && /[a-zA-Z]$/.test(escape)) {
          if (escape === '\x1b[K') lines[buffer.cursorY] = lines[buffer.cursorY].slice(0, buffer.cursorX)
          if (escape === '\x1b[D') buffer.cursorX = Math.max(0, buffer.cursorX - 1)
          if (escape === '\x1b[?1049h') buffer.type = 'alternate'
          if (escape === '\x1b[?1049l') buffer.type = 'normal'
          escape = ''
        }
      } else if (character === '\r') buffer.cursorX = 0
      else if (character === '\n') { buffer.cursorY++; lines[buffer.cursorY] = '' } else if (character === '\b') buffer.cursorX = Math.max(0, buffer.cursorX - 1)
      else {
        const line = lines[buffer.cursorY] || ''
        lines[buffer.cursorY] = line.slice(0, buffer.cursorX).padEnd(buffer.cursorX, ' ') + character + line.slice(buffer.cursorX + 1)
        buffer.cursorX++
      }
    }
  }
  const prediction = new TerminalTypeahead(terminal, mount, { username })
  function flush () { while (callbacks.length) { const { data, callback } = callbacks.shift(); parse(data); callback() } }
  function output (data) { prediction.output(data); flush() }
  function visible () { return screen.children.find(node => !node.hidden && !node.removed) }
  output('[root@demo ~]# ')
  return { prediction, terminal, buffer, screen, writes, flush, output, visible, lines }
}

test('inline typing is immediate and never writes fabricated bytes or takes focus', async () => {
  const h = await harness()
  h.prediction.input('echo hello')
  assert.deepEqual(h.writes, ['[root@demo ~]# '])
  assert.equal(h.visible().children[0].textContent, 'echo hello')
  assert.equal(h.visible()['aria-hidden'], 'true')
  assert.equal(h.visible().style.pointerEvents, 'none')
  assert.equal(h.lines[0], '[root@demo ~]# ')
  h.output('echo hello')
  assert.equal(h.visible(), undefined)
  assert.equal(h.lines[0], '[root@demo ~]# echo hello')
})

test('partial acknowledgements and asynchronous writes keep one stable inline prediction', async () => {
  const h = await harness()
  h.prediction.input('ab')
  h.prediction.output('a')
  assert.equal(h.visible().children[0].textContent, 'ab')
  h.prediction.input('c')
  h.flush()
  assert.equal(h.visible().children[0].textContent, 'abc')
  h.prediction.output('bc')
  assert.equal(h.visible().children[0].textContent, 'abc')
  h.flush()
  assert.equal(h.visible(), undefined)
  assert.equal(h.lines[0], '[root@demo ~]# abc')
  assert.deepEqual(h.writes, ['[root@demo ~]# ', 'a', 'bc'])
})

test('first connected keystroke recognizes a bare initial prompt after open/fit without rearming later resets', async () => {
  const h = await harness()
  // 首个 prompt 可先于 connected 诊断以及 terminal.open/fit 到达。
  h.prediction.reset()
  h.prediction.input('a')
  assert.equal(h.visible().children[0].textContent, 'a')
  h.output('a')
  h.prediction.input('\x7f')
  h.output('\b \b')
  h.prediction.reset()
  h.prediction.input('secret')
  assert.equal(h.visible(), undefined)
  const password = await harness()
  password.prediction.reset()
  password.output('\r\nPassword: ')
  password.prediction.input('secret')
  assert.equal(password.visible(), undefined)
})

test('tail deletion masks confirmed characters and recognizes fragmented erase echoes', async () => {
  for (const erased of ['\b \b', '\b\x1b[K', '\x1b[D\x1b[K']) {
    const h = await harness()
    h.prediction.input('ab')
    h.output('ab')
    h.prediction.input('\x7f')
    assert.equal(h.visible().children[0].textContent, 'a')
    for (const byte of erased) h.output(byte)
    assert.equal(h.visible(), undefined)
    h.prediction.input('c')
    assert.equal(h.visible().children[0].textContent, 'ac')
    h.output('c')
    assert.equal(h.lines[0].trimEnd(), '[root@demo ~]# ac')
  }
})

test('control keys, unsupported text, empty backspace and long lines fall back without replay', async () => {
  for (const input of ['\r', '\t', '\x03', '\x1b[A', '中文', '\x7f', 'x'.repeat(300)]) {
    const h = await harness()
    h.prediction.input(input)
    assert.equal(h.visible(), undefined)
    h.prediction.input('secret')
    assert.equal(h.visible(), undefined)
    assert.deepEqual(h.writes, ['[root@demo ~]# '])
    h.output('\r\n[root@demo ~]# ')
    h.prediction.input('a')
    assert.equal(h.visible().children[0].textContent, 'a')
  }
})

test('password and unknown prompts never enable prediction, configured username is required', async () => {
  for (const prompt of ['Password: ', 'root@demo password: ', 'Enter passphrase: ', '>>> ', '[other@demo ~]# ']) {
    const h = await harness()
    h.prediction.input('\r')
    h.output('\r\n' + prompt)
    h.prediction.input('secret')
    assert.equal(h.visible(), undefined)
  }
  const noUser = await harness('')
  noUser.prediction.input('secret')
  assert.equal(noUser.visible(), undefined)
})

test('ordinary bash and zsh username prompts arm after color/control parsing', async () => {
  for (const prompt of ['root@demo:~# ', 'root@demo ~/repo % ', '\x1b[32m[root@demo service]# \x1b[0m']) {
    const h = await harness()
    h.prediction.reset()
    h.output('\r\n' + prompt)
    h.prediction.input('ls')
    assert.equal(h.visible().children[0].textContent, 'ls')
  }
})

test('unexpected output, alternate screen, resize and scrollback revoke trust', async () => {
  const unexpected = await harness()
  unexpected.prediction.input('abc')
  unexpected.output('Warning: output changed')
  assert.equal(unexpected.visible(), undefined)
  unexpected.prediction.input('secret')
  assert.equal(unexpected.visible(), undefined)
  for (const change of [h => { h.terminal.cols = 80 }, h => { h.buffer.viewportY = 1 }, h => { h.output('\x1b[?1049h') }]) {
    const h = await harness()
    h.prediction.input('a')
    change(h)
    h.prediction.input('b')
    assert.equal(h.visible(), undefined)
  }
})

test('Enter/reset while xterm parses cannot resurrect a stale trusted prompt', async () => {
  const h = await harness()
  h.prediction.input('a')
  h.prediction.output('a')
  h.prediction.input('\r')
  h.flush()
  h.prediction.input('secret')
  assert.equal(h.visible(), undefined)
  h.output('\r\nPassword: ')
  h.prediction.input('secret')
  assert.equal(h.visible(), undefined)
})

test('explicit disable and disposal cancel prediction without suppressing real output', async () => {
  const h = await harness()
  h.prediction.input('a')
  h.prediction.setEnabled(false)
  h.output('a')
  assert.equal(h.visible(), undefined)
  assert.equal(h.lines[0], '[root@demo ~]# a')
  h.output('\r\n[root@demo ~]# ')
  h.prediction.setEnabled(true)
  h.prediction.input('b')
  assert.equal(h.visible().children[0].textContent, 'b')
  h.prediction.output('b')
  h.prediction.dispose()
  h.flush()
  assert.equal(h.visible(), undefined)
  assert.equal(h.screen.children.filter(node => !node.removed).length, 0)
})
