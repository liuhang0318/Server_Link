import { WebglAddon } from '@xterm/addon-webgl'

/** 一个窗口只让当前终端持有 GPU 上下文；切到后台即释放，避免多服务器耗尽 WebGL 上限。 */
export class TerminalRenderer {
  constructor (createAddon = () => new WebglAddon()) {
    this.createAddon = createAddon
    this.active = null
    this.failed = new WeakSet()
  }

  /** 仅切换绘制后端，不修改缓冲区或 SSH；驱动不支持/上下文丢失时永久回退该会话的 DOM 绘制。 */
  use (terminal, onChange = () => {}) {
    if (this.active?.terminal === terminal) return
    this.release()
    if (!terminal?.element || this.failed.has(terminal)) return
    let addon
    try {
      addon = this.createAddon()
      const active = { terminal, addon, onChange, lost: null }
      this.active = active
      active.lost = addon.onContextLoss(() => {
        this.failed.add(terminal)
        this.release(terminal)
      })
      terminal.loadAddon(addon)
      onChange()
    } catch {
      // 初始化中途失败也释放部分资源；绝不因 GPU 不可用而阻断输入或创建另一个 SSH 会话。
      this.failed.add(terminal)
      if (this.active?.terminal === terminal) this.release(terminal)
      else {
        try { addon?.dispose() } catch {}
      }
    }
  }

  /** 只释放指定的当前终端，关闭后台连接不能影响正在输入的另一台服务器。 */
  release (terminal = this.active?.terminal) {
    if (!this.active || this.active.terminal !== terminal) return
    const active = this.active
    this.active = null
    active.lost?.dispose()
    try { active.addon.dispose() } catch {}
    active.onChange()
  }
}
