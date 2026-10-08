'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

/** 分开模拟 xterm 的解析回调和行绘制，防止把 buffer 更新误当成用户已看到真实回显。 */
async function harness (username = 'root') {
  const { TerminalTypeahead } = await import('../src/terminal-typeahead.mjs')
  const metrics = { geometryReads: 0, styleWrites: 0, textWrites: 0 }
  class Node {
    constructor () {
      this.children = []
      this.style = new Proxy({}, { set: (target, key, value) => { metrics.styleWrites++; target[key] = value; return true } })
      this.hidden = false
      this.text = ''
    }

    get textContent () { return this.text }
    set textContent (value) { metrics.textWrites++; this.text = value }
    append (...nodes) { this.children.push(...nodes) }
    remove () { this.removed = true }
    setAttribute (name, value) { this[name] = value }
    getBoundingClientRect () { metrics.geometryReads++; return { width: 960, height: 480 } }
  }
  const screen = new Node()
  const rows = new Node()
  rows.style.letterSpacing = '0.03125px'
  const mount = { querySelector: selector => selector === '.xterm-rows' ? rows : screen, ownerDocument: { createElement: () => new Node() } }
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
  const renderListeners = new Set()
  const paintedLines = []
  const terminal = {
    buffer: { active: buffer },
    cols: 120,
    rows: 24,
    dimensions: { css: { cell: { width: 8, height: 20 } } },
    options: { fontFamily: 'monospace', fontSize: 14, theme: { background: '#11161e' } },
    write: (data, callback) => { writes.push(data); callbacks.push({ data, callback }) },
    onRender: listener => { renderListeners.add(listener); return { dispose: () => renderListeners.delete(listener) } }
  }
  let escape = ''
  function parse (data) {
    for (const character of data) {
      if (character === '\x07') continue
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
  function parsePending (count = callbacks.length) {
    while (callbacks.length && count-- > 0) { const { data, callback } = callbacks.shift(); parse(data); callback() }
  }
  function paint (start = 0, end = terminal.rows - 1) {
    for (let row = start; row <= end; row++) paintedLines[row] = lines[row] || ''
    for (const listener of renderListeners) listener({ start, end })
  }
  function flush () { parsePending(); paint() }
  function output (data) { prediction.output(data); flush() }
  function visible () { return screen.children.find(node => !node.hidden && !node.removed) }
  output('[root@demo ~]# ')
  return { prediction, terminal, buffer, screen, rows, metrics, writes, flush, parsePending, paint, output, visible, lines, paintedLines, renderListeners }
}

test('typing and partial acknowledgements do not read layout or rewrite unchanged prediction text', async () => {
  const h = await harness()
  Object.assign(h.metrics, { geometryReads: 0, styleWrites: 0, textWrites: 0 })
  const command = 'abcdefghijklmnopqrstuvwxyz'.repeat(3)
  for (let index = 0; index < command.length; index++) {
    h.prediction.input(command[index])
    if (index >= 3) h.output(command[index - 3])
  }
  console.log(`TYPEAHEAD_COST ${JSON.stringify(h.metrics)}`)
  assert.equal(h.metrics.geometryReads, 0)
  assert.equal(h.metrics.textWrites, command.length)
  assert.ok(h.metrics.styleWrites < command.length * 3 + 30, 'stable geometry must not be reassigned for every key and echo')
  assert.equal(h.visible().children[0].textContent, command)
  h.output(command.slice(-3))
  assert.equal(h.visible(), undefined)
  assert.equal(h.lines[0], '[root@demo ~]# ' + command)
})

test('prediction uses public cell dimensions and renderer spacing across geometry changes', async () => {
  const h = await harness()
  h.prediction.input('fi')
  assert.equal(h.visible().style.letterSpacing, '0.03125px')
  assert.equal(h.visible().style.fontKerning, 'none')
  assert.equal(h.visible().style.height, '20px')
  h.terminal.dimensions.css.cell = { width: 8.5, height: 21 }
  h.rows.style.letterSpacing = '0.0625px'
  h.prediction.input('x')
  assert.equal(h.visible().style.letterSpacing, '0.0625px')
  assert.equal(h.visible().style.height, '21px')
  assert.equal(h.visible().children[1].style.transform, 'translateX(25.5px)')
  assert.equal(h.metrics.geometryReads, 0)
})

test('prediction covers the displayed canvas grid at the first and last rows after Retina rounding', async () => {
  // 奇数行/列的半像素网格会让 WebGL 画布整体取整；旧光标不能从预显层底边露出。
  for (const rows of [24, 31]) {
    for (const row of [0, rows - 1]) {
      const h = await harness()
      h.terminal.cols = 121
      h.terminal.rows = rows
      const canvas = { width: Math.round(121 * 8.5), height: Math.round(rows * 21.5) }
      h.terminal.dimensions.css = { cell: { width: 8.5, height: 21.5 }, canvas }
      h.prediction.mount.ownerDocument.defaultView = { devicePixelRatio: 2 }
      h.prediction.reset()
      const prompt = '[root@demo ~]# '
      h.output('\r' + '\n'.repeat(row) + prompt)
      h.prediction.input('ab')
      const overlay = h.visible()
      const width = canvas.width / h.terminal.cols
      const height = canvas.height / rows
      assert.equal(overlay.style.left, `${prompt.length * width}px`)
      assert.equal(overlay.style.top, `${row * height}px`)
      assert.equal(overlay.style.height, `${height}px`)
      assert.equal(overlay.style.lineHeight, `${height}px`)
      assert.equal(overlay.style.boxShadow, '0 -0.5px 0 #11161e, 0 0.5px 0 #11161e')
      assert.equal(overlay.children[1].style.transform, `translateX(${2 * width}px)`)
      h.output('a')
      assert.equal(h.visible(), overlay, 'partial remote echo keeps the aligned cover')
      h.output('b')
      assert.equal(h.visible(), undefined, 'painted echo hands the cursor back to xterm')
      assert.equal(h.metrics.geometryReads, 0)
    }
  }
})

test('missing or zero renderer dimensions hide prediction without synchronous layout measurement', async () => {
  for (const dimensions of [undefined, { css: { cell: { width: 0, height: 20 } } }]) {
    const h = await harness()
    h.terminal.dimensions = dimensions
    h.prediction.input('a')
    assert.equal(h.visible(), undefined)
    assert.equal(h.metrics.geometryReads, 0)
    h.output('a')
    assert.equal(h.lines[0], '[root@demo ~]# a')
  }
})

test('GPU spacing is measured once per font/backend and backend changes preserve pending input', async () => {
  const h = await harness()
  const mount = h.prediction.mount
  const createElement = mount.ownerDocument.createElement
  let measurements = 0
  mount.querySelector = selector => selector === '.xterm-screen' ? h.screen : null
  mount.ownerDocument.createElement = tag => tag === 'canvas'
    ? { getContext: () => ({ measureText: () => { measurements++; return { width: 8.25 } } }) }
    : createElement(tag)
  h.prediction.input('ab')
  assert.equal(h.visible().style.letterSpacing, '-0.25px')
  h.prediction.input('c')
  h.output('a')
  assert.equal(measurements, 1)
  assert.equal(h.visible().children[0].textContent, 'abc')
  h.prediction.invalidateRenderer()
  mount.querySelector = selector => selector === '.xterm-rows' ? h.rows : h.screen
  h.prediction.render()
  assert.equal(h.visible().style.letterSpacing, '0.03125px')
  assert.equal(h.visible().children[0].textContent, 'abc')
  h.output('bc')
  assert.equal(h.visible(), undefined)
})

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

test('ordinary typing stays immediate across colored shell echoes, including split SGR packets', async () => {
  for (const color of ['\x1b[32m', '\x1b[1;34m', '\x1b[38;5;8m', '\x1b[38;2;8;10;20m']) {
    const h = await harness()
    h.prediction.input('git')
    h.output('g')
    for (const byte of color) h.output(byte)
    h.prediction.input(' ')
    assert.equal(h.visible().children[0].textContent, 'git ')
    h.output('it\x1b[0m ')
    h.prediction.input('status')
    assert.equal(h.visible().children[0].textContent, 'git status')
    h.output(color + 'status\x1b[m')
    assert.equal(h.visible(), undefined)
    assert.equal(h.lines[0], '[root@demo ~]# git status')
    assert.equal(h.writes.join(''), '[root@demo ~]# g' + color + 'it\x1b[0m ' + color + 'status\x1b[m')
  }
})

test('concealed rendition and incomplete extended colors revoke prediction instead of exposing input', async () => {
  for (const decoration of ['\x1b[8m', '\x1b[1;8m', '\x1b[38;5m', '\x1b[38;2;10m']) {
    const h = await harness()
    h.prediction.input('a')
    h.output(decoration + 'a')
    h.prediction.input('secret')
    assert.equal(h.visible(), undefined)
  }
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

test('control keys, unsupported text and long lines fall back without replay', async () => {
  for (const input of ['\r', '\t', '\x03', '\x1b[A', '中文', 'x'.repeat(300)]) {
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

test('deleting to an empty command and extra backspaces do not disable the next ordinary input', async () => {
  const h = await harness()
  h.prediction.input('a')
  h.output('a')
  h.prediction.input('\x7f\x7f\x7f')
  h.output('\b \b\x07')
  h.prediction.input('new')
  assert.equal(h.visible().children[0].textContent, 'new')
  assert.equal(h.lines[0].trimEnd(), '[root@demo ~]#')
  h.output('new')
  assert.equal(h.visible(), undefined)
  assert.equal(h.lines[0], '[root@demo ~]# new')
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

test('Enter keeps the last unacknowledged letter visible through parsing until its row is painted', async () => {
  for (const queuedBeforeEnter of [false, true]) {
    const h = await harness()
    h.prediction.input('echo ab')
    h.output('echo ab')
    h.prediction.input('c')
    if (queuedBeforeEnter) h.prediction.output('c')
    h.prediction.input('\r')
    // 回车后的输入仍由原链路发送，但不能混入已提交命令或预显潜在口令。
    h.prediction.input('secret')
    assert.equal(h.visible().children[0].textContent, 'echo abc')
    if (!queuedBeforeEnter) h.prediction.output('c')
    h.prediction.input('secret')
    h.parsePending()
    assert.equal(h.lines[0], '[root@demo ~]# echo abc')
    assert.equal(h.paintedLines[0], '[root@demo ~]# echo ab')
    assert.equal(h.visible().children[0].textContent, 'echo abc')
    h.paint(1, 1)
    assert.equal(h.visible().children[0].textContent, 'echo abc')
    h.paint(0, 0)
    assert.equal(h.visible(), undefined)
    assert.equal(h.paintedLines[0], '[root@demo ~]# echo abc')
    h.prediction.input('secret')
    assert.equal(h.visible(), undefined)
    assert.deepEqual(h.writes, ['[root@demo ~]# ', 'echo ab', 'c'])
    h.output('\r\n[root@demo ~]# ')
    h.prediction.input('ls')
    assert.equal(h.visible().children[0].textContent, 'ls')
  }
})

test('Tab keeps the typed prefix visible until delayed echoes are painted, without fabricating completion', async () => {
  for (const parsedBeforeTab of [false, true]) {
    const h = await harness()
    h.prediction.input('git sta')
    h.output('git s')
    h.prediction.output('ta')
    if (parsedBeforeTab) h.parsePending()
    h.prediction.input('\t')
    assert.equal(h.visible().children[0].textContent, 'git sta')
    // 补全后的键入仍由 SSH 发送，不再追加到已经封存的旧预显中。
    h.prediction.input('\t')
    h.prediction.input('secret')
    assert.equal(h.visible().children[0].textContent, 'git sta')
    h.parsePending()
    h.paint(1, 1)
    assert.equal(h.visible().children[0].textContent, 'git sta')
    h.paint(0, 0)
    assert.equal(h.visible(), undefined)
    assert.equal(h.paintedLines[0], '[root@demo ~]# git sta')
    h.output('tus ')
    assert.equal(h.paintedLines[0], '[root@demo ~]# git status ')
    assert.deepEqual(h.writes, ['[root@demo ~]# ', 'git s', 'ta', 'tus '])
  }
})

test('Tab handles split echo, shell redraw and candidate lists without repainting the old prediction', async () => {
  for (const completion of ['tus ', '\r[root@demo ~]# git status ', '\r\nstatus  stash\r\n[root@demo ~]# git sta']) {
    const h = await harness()
    h.prediction.input('git sta')
    h.prediction.input('\t')
    h.output('git s')
    assert.equal(h.visible().children[0].textContent, 'git sta')
    h.prediction.output('ta' + completion)
    h.parsePending()
    assert.equal(h.visible().children[0].textContent, 'git sta')
    h.paint()
    assert.equal(h.visible(), undefined)
    h.prediction.input('\r')
    h.prediction.input('secret')
    assert.equal(h.visible(), undefined)
    assert.deepEqual(h.writes, ['[root@demo ~]# ', 'git s', 'ta' + completion])
    h.output('\r\n[root@demo ~]# ')
    h.prediction.input('ls')
    assert.equal(h.visible().children[0].textContent, 'ls')
  }
})

test('typing after a confirmed Tab completion resumes immediate prediction from the real completed tail', async () => {
  for (const completion of ['tus ', '\r[root@demo ~]# git status ']) {
    const h = await harness()
    h.prediction.input('git sta')
    h.prediction.input('\t')
    h.output('git sta' + completion)
    assert.equal(h.visible(), undefined)
    h.prediction.input('--short')
    assert.equal(h.visible().children[0].textContent, 'git status --short')
    assert.equal(h.lines[0], '[root@demo ~]# git status ')
    h.output('--short')
    assert.equal(h.visible(), undefined)
    assert.deepEqual(h.writes, ['[root@demo ~]# ', 'git sta' + completion, '--short'])
  }
})

test('intervening input and untrusted completion replies never rearm prediction', async () => {
  for (const input of ['\r', '\x03', '\x1b[D', '\t', 'x']) {
    const h = await harness()
    h.prediction.input('git sta')
    h.prediction.input('\t')
    h.prediction.input(input)
    h.output('git status ')
    h.prediction.input('secret')
    assert.equal(h.visible(), undefined, JSON.stringify(input))
  }
  for (const reply of ['\r\nPassword: ', '\r\n[root@demo elsewhere]# git status ', '\r\n[root@demo ~]# other ', '\x1b[?1049h', 'tus \x1b[8m']) {
    const h = await harness()
    h.prediction.input('git sta')
    h.prediction.input('\t')
    h.output('git sta' + reply)
    h.prediction.input('secret')
    assert.equal(h.visible(), undefined, reply)
  }
})

test('Enter tolerates split and combined final echoes without blank frames or duplicated terminal bytes', async () => {
  for (const chunks of [['abc\r\nPassword: '], ['a', 'bc', '\r', '\nPassword: '], ['a', 'bc\r\nPassword: ']]) {
    const h = await harness()
    h.prediction.input('abc')
    h.prediction.input('\r')
    for (const chunk of chunks) {
      h.prediction.output(chunk)
      h.prediction.input('secret')
      if (!h.paintedLines[0].endsWith('abc')) assert.equal(h.visible().children[0].textContent, 'abc')
      h.parsePending()
      if (!h.paintedLines[0].endsWith('abc')) assert.equal(h.visible().children[0].textContent, 'abc')
      h.paint()
    }
    assert.equal(h.visible(), undefined)
    assert.equal(h.lines[0], '[root@demo ~]# abc')
    assert.equal(h.lines[1], 'Password: ')
    assert.deepEqual(h.writes, ['[root@demo ~]# ', ...chunks])
    h.prediction.input('secret')
    assert.equal(h.visible(), undefined)
  }
})

test('Enter after backspace keeps the corrected command until fragmented deletion is drawn', async () => {
  for (const erased of ['\b \b', '\b\x1b[K', '\x1b[D\x1b[K']) {
    const h = await harness()
    h.prediction.input('abc')
    h.output('abc')
    h.prediction.input('\x7f')
    h.prediction.input('\r')
    for (const byte of erased) {
      h.prediction.output(byte)
      h.parsePending()
      assert.equal(h.visible().children[0].textContent, 'ab')
      h.paint()
    }
    assert.equal(h.visible(), undefined)
    assert.equal(h.paintedLines[0].trimEnd(), '[root@demo ~]# ab')
    h.output('\r\n[root@demo ~]# ')
    h.prediction.input('z')
    assert.equal(h.visible().children[0].textContent, 'z')
  }
})

test('new keystrokes between parse and paint do not expose the old rendered tail', async () => {
  const h = await harness()
  h.prediction.input('a')
  h.prediction.output('a')
  h.parsePending()
  h.prediction.input('b')
  h.paint()
  assert.equal(h.visible().children[0].textContent, 'ab')
  h.prediction.output('b')
  h.parsePending()
  h.prediction.input('\r')
  assert.equal(h.visible().children[0].textContent, 'ab')
  h.paint()
  assert.equal(h.visible(), undefined)
  assert.equal(h.paintedLines[0], '[root@demo ~]# ab')
})

test('an early rendered batch cannot retire a command while later echo chunks remain queued', async () => {
  const h = await harness()
  h.prediction.input('abc')
  h.prediction.input('\r')
  h.prediction.output('a')
  h.prediction.output('bc\r\n[root@demo ~]# ')
  h.parsePending(1)
  h.paint()
  assert.equal(h.paintedLines[0], '[root@demo ~]# a')
  assert.equal(h.visible().children[0].textContent, 'abc')
  h.parsePending()
  assert.equal(h.visible().children[0].textContent, 'abc')
  h.paint()
  assert.equal(h.visible(), undefined)
  assert.equal(h.paintedLines[0], '[root@demo ~]# abc')
  h.prediction.input('ls')
  assert.equal(h.visible().children[0].textContent, 'ls')
})

test('reset, disable and disposal during handoff invalidate late parse and render callbacks', async () => {
  for (const parseFirst of [false, true]) {
    for (const cancel of [h => h.prediction.reset(), h => h.prediction.setEnabled(false), h => h.prediction.dispose()]) {
      const h = await harness()
      h.prediction.input('a')
      h.prediction.input('\r')
      h.prediction.output('a\r\n[root@demo ~]# ')
      if (parseFirst) h.parsePending()
      cancel(h)
      h.flush()
      h.prediction.input('secret')
      assert.equal(h.visible(), undefined)
      assert.equal(h.paintedLines[0], '[root@demo ~]# a')
      if (h.prediction.disposed) assert.equal(h.renderListeners.size, 0)
    }
  }
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
