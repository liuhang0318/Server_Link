const ERASE_ECHOES = ['\b \b', '\b\x1b[K', '\x1b[D\x1b[K']
const MAX_PENDING = 256

/**
 * 在原终端命令尾预显尚未确认的按键；真正的输出和历史始终由 xterm 维护。
 * ponytail: 仅识别带当前用户名的常见单行 shell 提示符，不声称能检测所有隐藏输入；
 * 自定义提示符、控制键、全屏程序和长行立即回退真实回显，不注入远端脚本或重发按键。
 */
export class TerminalTypeahead {
  constructor (terminal, mount, { username, enabled = true } = {}) {
    this.terminal = terminal
    this.mount = mount
    this.enabled = enabled
    this.disposed = false
    this.epoch = 0
    this.writesPending = 0
    this.pending = []
    this.echoPrefix = ''
    this.command = ''
    this.maxLength = 0
    this.anchor = null
    this.needsNewLine = false
    this.inputSeen = false
    const user = typeof username === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/.test(username) ? username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : null
    const host = '[a-zA-Z0-9][a-zA-Z0-9._-]*'
    this.prompt = user ? new RegExp(`^(?:\\[${user}@${host} [^\\]\\r\\n]{1,160}\\][#$] |${user}@${host}:[^\\r\\n]{1,160}[#$] |${user}@${host} [^\\r\\n]{1,160} % )$`) : null
  }

  /** 只绘制预测；调用方仍须立即将原始 data 发送一次，不等待任何回显。 */
  input (data) {
    if (this.disposed || !this.enabled) return
    const firstInput = !this.inputSeen
    this.inputSeen = true
    if (typeof data !== 'string' || !data || [...data].some(character => {
      const code = character.charCodeAt(0)
      return code !== 8 && code !== 127 && (code < 32 || code > 126)
    })) return this.reset()
    // 首次 open/fit 可发生在初始提示符之后；只在首个按键前重认一次，后续 reset 不复用旧提示符。
    if (!this.anchor && firstInput && this.writesPending === 0) {
      this.needsNewLine = false
      this.recognizePrompt()
    }
    if (!this.anchor) return
    if (!this.validPosition()) return this.reset()
    for (const character of data) {
      if (character === '\b' || character === '\x7f') {
        if (!this.command.length) return this.reset()
        this.command = this.command.slice(0, -1)
        this.pending.push({ erase: true })
      } else {
        this.command += character
        this.pending.push({ character })
      }
      // 不预测自动换行和滚屏，避免把本地字覆盖到另一条命令或远端输出上。
      if (this.pending.length > MAX_PENDING || this.anchor.x + this.command.length >= this.terminal.cols - 1) return this.reset()
      this.maxLength = Math.max(this.maxLength, this.command.length)
    }
    this.render()
  }

  /** 原始远端字节一律交给 xterm；回调后再更新遮罩，防止异步解析造成双重字符。 */
  output (data) {
    if (this.disposed) return
    if (this.anchor && !this.consumeEcho(data)) this.reset()
    if (typeof data === 'string' && data.includes('\n')) this.needsNewLine = false
    const epoch = this.epoch
    this.writesPending++
    this.terminal.write(data, () => {
      this.writesPending--
      if (this.disposed || epoch !== this.epoch) return
      if (this.anchor && !this.validPosition()) this.reset()
      if (!this.anchor && this.writesPending === 0) this.recognizePrompt()
      this.render()
    })
  }

  /** 撤销预测并等待新一行提示符；旧 write 回调不得重新信任被取消的命令。 */
  reset () {
    this.epoch++
    this.needsNewLine = true
    this.anchor = null
    this.pending = []
    this.echoPrefix = ''
    this.command = ''
    this.maxLength = 0
    if (this.overlay) {
      this.overlay.hidden = true
      this.text.textContent = ''
    }
  }

  /** 用户显式开启时可识别当前空提示符；关闭不会影响原始终端输入链路。 */
  setEnabled (enabled) {
    if (this.disposed || this.enabled === Boolean(enabled)) return
    this.enabled = Boolean(enabled)
    this.reset()
    if (this.enabled && this.writesPending === 0) {
      this.needsNewLine = false
      this.recognizePrompt()
    }
  }

  /** 关闭连接时清除预测内容，晚到的 xterm 回调不会重建 DOM。 */
  dispose () {
    this.reset()
    this.disposed = true
    this.overlay?.remove()
    this.overlay = null
  }

  /** 只有正常缓冲区的未换行命令尾可预测；滚动历史、重排与全屏模式均不覆盖。 */
  validPosition () {
    const buffer = this.terminal.buffer.active
    const anchor = this.anchor
    return anchor && buffer.type === 'normal' && buffer.viewportY === buffer.baseY &&
      buffer.baseY === anchor.baseY && buffer.cursorY === anchor.y &&
      this.terminal.cols === anchor.cols && this.terminal.rows === anchor.rows &&
      buffer.cursorX >= anchor.x && !buffer.getLine(buffer.baseY + buffer.cursorY)?.isWrapped
  }

  /** 从已解析的终端单元格识别提示符，ANSI 颜色不参与匹配，未知提示符默认禁用。 */
  recognizePrompt () {
    if (!this.enabled || !this.prompt || this.needsNewLine || this.pending.length) return
    const buffer = this.terminal.buffer.active
    if (buffer.type !== 'normal' || buffer.viewportY !== buffer.baseY || buffer.cursorX >= this.terminal.cols - 2) return
    const line = buffer.getLine(buffer.baseY + buffer.cursorY)
    if (!line || line.isWrapped || !this.prompt.test(line.translateToString(false, 0, buffer.cursorX))) return
    if (line.translateToString(true, buffer.cursorX).trim()) return
    this.anchor = { x: buffer.cursorX, y: buffer.cursorY, baseY: buffer.baseY, cols: this.terminal.cols, rows: this.terminal.rows }
    this.command = ''
    this.maxLength = 0
  }

  /** 顺序核对打印字符与常见行尾退格；分包只保留短前缀，不吞掉或重放远端字节。 */
  consumeEcho (data) {
    if (typeof data !== 'string' || data.length > 8192) return false
    let remaining = this.echoPrefix + data
    this.echoPrefix = ''
    while (remaining) {
      const next = this.pending[0]
      if (!next) return false
      const candidates = next.erase ? ERASE_ECHOES : [next.character]
      const complete = candidates.find(candidate => remaining.startsWith(candidate))
      if (complete) {
        remaining = remaining.slice(complete.length)
        this.pending.shift()
      } else if (candidates.some(candidate => candidate.startsWith(remaining))) {
        this.echoPrefix = remaining
        return true
      } else return false
    }
    return true
  }

  /** 预测层不接管焦点、不写入 xterm 历史；覆盖命令尾同时遮住旧光标和退格残字。 */
  render () {
    if (!this.anchor || (!this.pending.length && !this.echoPrefix && !this.writesPending)) {
      if (this.overlay) this.overlay.hidden = true
      return
    }
    const screen = this.mount.querySelector('.xterm-screen')
    const rect = screen?.getBoundingClientRect()
    if (!rect?.width || !rect.height) {
      if (this.overlay) this.overlay.hidden = true
      return
    }
    if (!this.overlay) {
      const document = this.mount.ownerDocument
      this.overlay = document.createElement('span')
      this.overlay.className = 'terminal-typeahead'
      this.overlay.setAttribute('aria-hidden', 'true')
      this.text = document.createElement('span')
      this.text.className = 'terminal-typeahead-text'
      this.caret = document.createElement('span')
      this.caret.className = 'terminal-typeahead-caret'
      this.overlay.append(this.text, this.caret)
      screen.append(this.overlay)
    }
    const cellWidth = rect.width / this.terminal.cols
    const cellHeight = rect.height / this.terminal.rows
    const options = this.terminal.options
    Object.assign(this.overlay.style, {
      position: 'absolute',
      pointerEvents: 'none',
      userSelect: 'none',
      zIndex: '8',
      whiteSpace: 'pre',
      left: `${this.anchor.x * cellWidth}px`,
      top: `${this.anchor.y * cellHeight}px`,
      width: `${(this.maxLength + 1) * cellWidth}px`,
      height: `${cellHeight}px`,
      fontFamily: options.fontFamily,
      fontSize: `${options.fontSize}px`,
      lineHeight: `${cellHeight}px`,
      letterSpacing: `${options.letterSpacing || 0}px`,
      background: options.theme?.background || '#11161e',
      color: options.theme?.foreground || '#dbe5f5'
    })
    this.text.textContent = this.command
    Object.assign(this.caret.style, { position: 'absolute', left: `${this.command.length * cellWidth}px`, top: '0', height: `${cellHeight}px` })
    this.overlay.hidden = false
  }
}
