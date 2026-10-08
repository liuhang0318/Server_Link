const ERASE_ECHOES = ['\b \b', '\b\x1b[K', '\x1b[D\x1b[K']
const MAX_PENDING = 256

/** 颜色/粗体不移动光标；conceal(8) 必须退出预显，256/RGB 颜色参数里的 8 不属于隐藏输入。 */
function visibleRendition (parameters) {
  const codes = parameters.split(';').map(Number)
  for (let index = 0; index < codes.length; index++) {
    if (codes[index] === 8) return false
    if ([38, 48, 58].includes(codes[index])) {
      const count = codes[++index] === 5 ? 1 : codes[index] === 2 ? 3 : 0
      if (!count || index + count >= codes.length) return false
      if (codes.slice(index + 1, index + count + 1).some(value => value > 255)) return false
      index += count
    }
  }
  return true
}

/**
 * 在原终端命令尾预显尚未确认的按键；真正的输出和历史始终由 xterm 维护。
 * ponytail: 仅识别带当前用户名的常见单行 shell 提示符，不声称能检测所有隐藏输入；
 * 自定义提示符、控制键、全屏程序和长行停止预测并回退真实回显，不注入远端脚本或重发按键。
 */
export class TerminalTypeahead {
  constructor (terminal, mount, { username, enabled = true } = {}) {
    this.terminal = terminal
    this.mount = mount
    this.enabled = enabled
    this.disposed = false
    this.epoch = 0
    this.writesPending = 0
    this.renderPending = false
    this.submitted = false
    this.retiring = false
    this.completion = null
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
    // write 回调仅代表解析完成；真实行绘制后才撤下预显，避免暴露尚未更新的末尾字符。
    this.renderDisposable = terminal.onRender(range => this.afterRender(range))
  }

  /** 只绘制预测；调用方仍须立即将原始 data 发送一次，不等待任何回显。 */
  input (data) {
    if (this.disposed || !this.enabled) return
    const firstInput = !this.inputSeen
    this.inputSeen = true
    // 回车/Tab 只封存预测，不立即撤层；否则高延迟下先露出旧前缀，再逐字回显，像重复输入。
    // Tab 的补全和后续编辑由远端 shell 决定，不能在旧命令上继续猜测或重复发送按键。
    if (this.submitted || this.retiring) {
      // 补全返回前又有按键（尤其 Enter/方向键）时，无法确认 Shell 状态，禁止用旧回显重新预显。
      this.completion = null
      return
    }
    if ((data === '\r' || data === '\t') && this.anchor) {
      if (data === '\t' && this.command) {
        const { x, y, baseY } = this.anchor
        this.completion = { x, command: this.command, prompt: this.terminal.buffer.active.getLine(baseY + y)?.translateToString(false, 0, x) }
      }
      this.submitted = true
      this.needsNewLine = true
      return
    }
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
        // 在空命令上多按一次退格只会响铃/无操作，不能让接下来整行输入退出即时回显。
        if (!this.command.length) continue
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

  /** 原始远端字节一律交给 xterm；解析只标记待交接，不提前撤下尚未绘制的预显。 */
  output (data) {
    if (this.disposed) return
    // 补全恢复只处理纯文本/换行；控制序列可能改变隐藏输入等状态，不能仅凭旧行内容重新信任。
    if (this.completion && typeof data === 'string' && data.includes('\x1b')) this.completion = null
    if (this.anchor && !this.retiring && !this.consumeEcho(data)) {
      // 尾字与换行/命令输出可合在一包；先停止预测，保留画面直到该包真正绘制。
      this.retiring = true
      this.needsNewLine = true
    }
    if (typeof data === 'string' && data.includes('\n')) this.needsNewLine = false
    const epoch = this.epoch
    this.writesPending++
    this.terminal.write(data, () => {
      this.writesPending--
      if (this.disposed || epoch !== this.epoch) return
      this.renderPending = true
    })
  }

  /** 只在原命令行已绘制且回显解析队列排空后交接；无关行刷新不能提前隐藏尾字。 */
  afterRender ({ start, end }) {
    if (this.disposed || !this.renderPending || this.writesPending) return
    const row = this.anchor?.y ?? this.terminal.buffer.active.cursorY
    if (row < start || row > end) return
    this.renderPending = false
    if (this.anchor && (this.retiring || !this.validPosition())) {
      const needsNewLine = this.needsNewLine
      const completion = this.completion
      this.reset()
      // 本轮真实输出已有换行时允许识别新提示符；单纯尾字确认不能解封已提交的命令。
      this.needsNewLine = needsNewLine
      // 只有这次 Tab 后没有别的输入，且真实画面仍是相同提示符/命令前缀，才恢复行尾预显。
      if (completion) this.resumeCompletion(completion)
    }
    if (!this.anchor) this.recognizePrompt()
    this.render()
  }

  /** 撤销预测并等待新一行提示符；旧 write 回调不得重新信任被取消的命令。 */
  reset () {
    this.epoch++
    this.needsNewLine = true
    this.renderPending = false
    this.submitted = false
    this.retiring = false
    this.completion = null
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
    this.renderDisposable.dispose()
    this.overlay?.remove()
    this.overlay = null
  }

  /** GPU/DOM 切换只使绘制度量失效，不丢弃已输入但尚未回显的字符。 */
  invalidateRenderer () {
    this.rowContainer = null
    this.geometry = null
    this.fontMeasurement = null
  }

  /** GPU 字格会按设备像素取整；只在字体/后端变化时量字宽，避免与预显字体交接时横向跳动。 */
  rendererSpacing (cellWidth) {
    const options = this.terminal.options
    if (this.rowContainer?.style.letterSpacing) return this.rowContainer.style.letterSpacing
    const font = `${options.fontWeight || 'normal'} ${options.fontSize}px ${options.fontFamily}`
    if (this.fontMeasurement?.font !== font) {
      this.measureContext ??= this.mount.ownerDocument.createElement('canvas').getContext?.('2d')
      if (!this.measureContext) return `${options.letterSpacing || 0}px`
      this.measureContext.font = font
      this.fontMeasurement = { font, width: this.measureContext.measureText('W').width }
    }
    return `${cellWidth - this.fontMeasurement.width}px`
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
    if (!this.enabled || !this.prompt || this.needsNewLine || this.submitted || this.retiring || this.pending.length) return
    const buffer = this.terminal.buffer.active
    if (buffer.type !== 'normal' || buffer.viewportY !== buffer.baseY || buffer.cursorX >= this.terminal.cols - 2) return
    const line = buffer.getLine(buffer.baseY + buffer.cursorY)
    if (!line || line.isWrapped || !this.prompt.test(line.translateToString(false, 0, buffer.cursorX))) return
    if (line.translateToString(true, buffer.cursorX).trim()) return
    this.anchor = { x: buffer.cursorX, y: buffer.cursorY, baseY: buffer.baseY, cols: this.terminal.cols, rows: this.terminal.rows }
    this.command = ''
    this.maxLength = 0
  }

  /** 补全只从已绘制的同一 Shell 行恢复；不推测候选项，不在 Enter、隐藏输入或中间编辑时重新武装。 */
  resumeCompletion ({ x, command, prompt }) {
    if (!this.enabled || !prompt) return
    const buffer = this.terminal.buffer.active
    if (buffer.type !== 'normal' || buffer.viewportY !== buffer.baseY || buffer.cursorX < x || buffer.cursorX >= this.terminal.cols - 1) return
    const line = buffer.getLine(buffer.baseY + buffer.cursorY)
    if (!line || line.isWrapped || line.translateToString(false, 0, x) !== prompt || line.translateToString(true, buffer.cursorX).trim()) return
    const completed = line.translateToString(false, x, buffer.cursorX)
    if (!completed.startsWith(command) || !/^[\x20-\x7e]+$/u.test(completed)) return
    this.anchor = { x, y: buffer.cursorY, baseY: buffer.baseY, cols: this.terminal.cols, rows: this.terminal.rows }
    this.command = completed
    this.maxLength = completed.length
    this.needsNewLine = false
  }

  /** 以实际字符确认输入，忽略不移动光标的可见 SGR 装饰；原始 ANSI 字节仍完整交给 xterm。 */
  consumeEcho (data) {
    if (typeof data !== 'string' || data.length > 8192) return false
    let remaining = this.echoPrefix + data
    this.echoPrefix = ''
    while (remaining) {
      if (remaining[0] === '\x07') { remaining = remaining.slice(1); continue }
      if (remaining.startsWith('\x1b')) {
        const control = remaining.slice(1)
        const rendition = /^\[([0-9;]*)m/u.exec(control)
        if (rendition) {
          if (!visibleRendition(rendition[1])) return false
          remaining = remaining.slice(rendition[0].length + 1)
          continue
        }
        // 高亮可跨包到达；只保留可能是 SGR 的短前缀，不能因单个 ESC 让后续整行退回网络回显。
        if (remaining.length < 128 && /^(?:\[[0-9;]*)?$/u.test(control)) {
          this.echoPrefix = remaining
          return true
        }
      }
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

  /** 直接使用 xterm 已计算的格子尺寸；输入热路径不触发布局测量，只更新变化的字和光标。 */
  render () {
    if (!this.anchor || (!this.pending.length && !this.echoPrefix && !this.writesPending && !this.renderPending)) {
      if (this.overlay) this.overlay.hidden = true
      return
    }
    const { cell, canvas } = this.terminal.dimensions?.css || {}
    if (!cell?.width || !cell.height) {
      if (this.overlay) this.overlay.hidden = true
      return
    }
    this.screen ??= this.mount.querySelector('.xterm-screen')
    if (!this.screen) return
    this.rowContainer ??= this.mount.querySelector('.xterm-rows')
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
      // 预显不接管焦点/历史；限制内部布局与重绘范围，样式只初始化一次。
      Object.assign(this.overlay.style, { position: 'absolute', pointerEvents: 'none', userSelect: 'none', zIndex: '8', whiteSpace: 'pre', contain: 'layout style paint', fontKerning: 'none' })
      Object.assign(this.caret.style, { position: 'absolute', left: '0', top: '0', height: '100%' })
      this.screen.append(this.overlay)
    }
    // WebGL 画布整体会取整，公开的 cell 却未补偿缩放；按最终画布分格，避免旧光标从底边漏成亮点。
    // 仅用 xterm 缓存的度量，不在打字时读取布局；尺寸未就绪时仍兼容原有单元格度量。
    const cellWidth = canvas?.width ? canvas.width / this.terminal.cols : cell.width
    const cellHeight = canvas?.height ? canvas.height / this.terminal.rows : cell.height
    const options = this.terminal.options
    // DOM renderer 对 Retina 小数格宽有字距校正；复用内联值而非 getComputedStyle，交接时不左右抖动。
    const spacing = this.rendererSpacing(cellWidth)
    const background = options.theme?.background || '#11161e'
    const foreground = options.theme?.foreground || '#dbe5f5'
    // Canvas 滤波与 DOM 裁切可能相差一个设备像素；只外扩上下背景，不拉长光标或挪动文字。
    const edge = 1 / (this.mount.ownerDocument.defaultView?.devicePixelRatio || 1)
    const geometry = JSON.stringify([this.anchor.x, this.anchor.y, cellWidth, cellHeight, options.fontFamily, options.fontSize, spacing, background, foreground, edge])
    if (geometry !== this.geometry) {
      Object.assign(this.overlay.style, {
        left: `${this.anchor.x * cellWidth}px`,
        top: `${this.anchor.y * cellHeight}px`,
        height: `${cellHeight}px`,
        fontFamily: options.fontFamily,
        fontSize: `${options.fontSize}px`,
        lineHeight: `${cellHeight}px`,
        letterSpacing: spacing,
        background,
        boxShadow: `0 -${edge}px 0 ${background}, 0 ${edge}px 0 ${background}`,
        color: foreground
      })
      this.geometry = geometry
    }
    const width = `${(this.maxLength + 1) * cellWidth}px`
    if (this.overlay.style.width !== width) this.overlay.style.width = width
    // 远端只确认一部分字符时，文字和光标没有变化，不销毁文字节点或再次改样式。
    if (this.text.textContent !== this.command) this.text.textContent = this.command
    const caret = `translateX(${this.command.length * cellWidth}px)`
    if (this.caret.style.transform !== caret) this.caret.style.transform = caret
    this.overlay.hidden = false
  }
}
