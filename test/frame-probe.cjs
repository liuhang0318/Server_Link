'use strict'

// 仅供隔离 preview 注册；只记录时间/数量，不读取命令、主机、DOM 内容，不进入发布包。
const { ipcRenderer } = require('electron')
let previous = 0
let frames = []
let inputFrames = []
let longTasks = 0

/** 分位数以毫秒报告；inputToFrame 是按键事件到下一次 rAF，不冒充显示器实际呈现延迟。 */
function report () {
  if (frames.length < 30) return
  const percentile = (values, fraction) => {
    const ordered = values.slice().sort((a, b) => a - b)
    return ordered.length ? Number(ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))].toFixed(2)) : null
  }
  ipcRenderer.send('fixture:frames', {
    renderer: document.querySelector('.terminal-view.active .xterm-rows') ? 'dom' : document.querySelector('.terminal-view.active .xterm-screen canvas') ? 'webgl' : 'unopened',
    frames: frames.length,
    medianMs: percentile(frames, 0.5),
    p95Ms: percentile(frames, 0.95),
    inputEvents: inputFrames.length,
    inputToFrameP95Ms: percentile(inputFrames, 0.95),
    longTasks
  })
  frames = []
  inputFrames = []
  longTasks = 0
}

/** 只采集可见且有焦点窗口，排除切回 Codex/隐藏窗口造成的正常节流。 */
function sample (timestamp) {
  if (document.visibilityState === 'visible' && document.hasFocus()) {
    if (previous) frames.push(timestamp - previous)
    previous = timestamp
    if (frames.length >= 240) report()
  } else previous = 0
  requestAnimationFrame(sample)
}

window.addEventListener('keydown', () => {
  const started = performance.now()
  requestAnimationFrame(() => {
    if (document.hasFocus()) inputFrames.push(performance.now() - started)
  })
}, { capture: true, passive: true })
new PerformanceObserver(list => {
  if (document.hasFocus()) longTasks += list.getEntries().length
}).observe({ type: 'longtask', buffered: false })
window.addEventListener('beforeunload', report)
requestAnimationFrame(sample)
