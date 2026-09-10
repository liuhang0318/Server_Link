'use strict'

// 原生菜单验收专用：真实 Electron/main/preload/dist，所有主机和文件服务均为无网络桩。
const { app, session } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const disconnectOnce = process.argv.includes('--disconnect-once')
const failOnce = process.argv.includes('--fail-once')
if (disconnectOnce && failOnce) throw new Error('请分别使用 --disconnect-once 或 --fail-once 验收断线与首次失败')

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'serverlink-native-preview-'))
app.setPath('userData', temporaryRoot)
for (const key of ['sessionData', 'logs']) {
  const directory = path.join(temporaryRoot, key)
  fs.mkdirSync(directory)
  app.setPath(key, directory)
}
app.commandLine.appendSwitch('disable-background-networking')

/** 只删除本次 mkdtemp 创建的目录，绝不清理用户安装版的配置或缓存。 */
function cleanup () {
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
}
process.once('exit', cleanup)
app.once('quit', () => {
  cleanup()
  console.log('SERVERLINK_NATIVE_PREVIEW_QUIT')
})
app.on('browser-window-created', (_event, window) => {
  // 仅记录隔离桩的固定动作及错误，诊断原生菜单是否到达 renderer；不加载用户窗口。
  const send = window.webContents.send.bind(window.webContents)
  window.webContents.send = (channel, ...args) => {
    if (channel === 'app:action') console.log(`SERVERLINK_NATIVE_PREVIEW_ACTION ${args[0]} focused=${window.isFocused()}`)
    return send(channel, ...args)
  }
  window.webContents.on('console-message', details => {
    if (details.level === 'error') console.error(`SERVERLINK_NATIVE_PREVIEW_RENDERER_ERROR ${details.message}`)
  })
  window.once('ready-to-show', () => {
    window.setTitle('ServerLink · 隔离快捷键验收')
    console.log(`SERVERLINK_NATIVE_PREVIEW_READY userData=${temporaryRoot}`)
  })
})
// 额外封住浏览器网络出口；静态文件照常加载，不发出 HTTP/WebSocket 请求。
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (_details, callback) => {
      // Electron 此处使用单参数结果对象，不是 Node error-first 回调。
      // eslint-disable-next-line n/no-callback-literal
      callback({ cancel: true })
    }
  )
})

// --organize 提供独立名称与同前缀样本，便于验收拖动、手动分组及整组连接。
const profileNames = process.argv.includes('--organize')
  ? ['东京', '后台API', '游戏服', 'mamo线上1', 'mamo线上2']
  : ['快捷键演示1', '快捷键演示2']
const profiles = profileNames.map((name, offset) => ({
  id: `00000000-0000-4000-8000-00000000000${offset + 1}`,
  name,
  host: `native-preview-${offset + 1}.example.com`,
  port: 22,
  username: 'demo',
  auth: 'agent',
  privateKeyPath: null
}))

/** 无持久化配置桩，不读取或修改任何真实连接配置。 */
class ProfileStore {
  async init () {}
  async list () { return profiles.map(profile => ({ ...profile })) }
  async get (id) { return profiles.find(profile => profile.id === id) }

  /** 只在隔离内存中重排和改组，返回完整快照以复现真实 IPC 的刷新语义。 */
  async organize (change) {
    const selected = new Set(change.ids || [])
    let next = profiles.map(profile => {
      const updated = { ...profile }
      if (selected.has(profile.id)) {
        // null 恢复前缀分组，空字符串显式独立；不可把两者都当成删除属性。
        if (change.group === null) delete updated.group
        else updated.group = change.group
      }
      return updated
    })
    if (change.order) {
      const byId = new Map(next.map(profile => [profile.id, profile]))
      if (change.order.length !== profiles.length || new Set(change.order).size !== profiles.length || change.order.some(id => !byId.has(id))) {
        throw new Error('预览排序必须包含全部服务器且不可重复')
      }
      next = change.order.map((id, order) => ({ ...byId.get(id), order }))
    }
    profiles.splice(0, profiles.length, ...next)
    return this.list()
  }
}

/** 模拟终端生命周期；write 仅回显，绝不创建 PTY、调用 shell 或建立 SSH。 */
class SessionManager {
  constructor () { this.sessions = new Map(); this.attemptedProfiles = new Set() }
  async init () {}

  /** 首次断线/失败只消费当前配置的一次机会，重连后保持在线以验收恢复状态。 */
  start (ownerId, profile, emit) {
    const sessionId = randomUUID()
    const prompt = `[${profile.username}@preview ~]$ `
    const firstAttempt = !this.attemptedProfiles.has(profile.id)
    this.attemptedProfiles.add(profile.id)
    const timer = setTimeout(() => {
      const record = this.sessions.get(sessionId)
      if (!record) return
      if (failOnce && firstAttempt) {
        // 不发 connected 或提示符，复现握手失败；删除后延迟回显也不能继续写入。
        this.sessions.delete(sessionId)
        emit({ type: 'exit', sessionId, exitCode: 255 })
        console.log(`SERVERLINK_NATIVE_PREVIEW_SESSION_FAILED ${sessionId}`)
        return
      }
      emit({ type: 'progress', sessionId, phase: 'connected', logs: 'Static fixture: no network connection.' })
      emit({ type: 'data', sessionId, data: `\x1b[32m${profile.name} · 隔离演示，无远程连接\x1b[0m\r\n${prompt}` })
      if (disconnectOnce && firstAttempt) {
        // 提示符显示两秒后模拟远端断线；复用 timer 字段让主动关闭仍能撤销此事件。
        record.timer = setTimeout(() => {
          if (this.sessions.get(sessionId) !== record) return
          this.sessions.delete(sessionId)
          emit({ type: 'exit', sessionId, exitCode: 255 })
          console.log(`SERVERLINK_NATIVE_PREVIEW_SESSION_DISCONNECTED ${sessionId}`)
        }, 2000)
      }
    }, 700)
    this.sessions.set(sessionId, { ownerId, emit, timer, prompt })
    emit({ type: 'progress', sessionId, phase: 'connecting', logs: 'Preparing static fixture.' })
    return { sessionId, status: 'running' }
  }

  /** 回车只返回当前配置的空提示符，模拟提交边界而不执行输入的命令。 */
  write (ownerId, sessionId, data) {
    const record = this.sessions.get(sessionId)
    if (record?.ownerId !== ownerId) return
    const echo = data.replace(/\x7f/g, '\b \b').replace(/\r\n|\r|\n/g, '\r\n' + record.prompt)
    // --slow-echo 用于真实 Electron 窗口的原位预显交接验收，不访问任何远端服务器。
    setTimeout(() => {
      if (this.sessions.get(sessionId) === record) record.emit({ type: 'data', sessionId, data: echo })
    }, process.argv.includes('--slow-echo') ? 1200 : 0)
  }

  resize () {}

  /** 模拟 close IPC 的退出事件，并撤销未发出的连接动画。 */
  close (ownerId, sessionId) {
    const record = this.sessions.get(sessionId)
    if (record?.ownerId !== ownerId) return false
    this.sessions.delete(sessionId)
    clearTimeout(record.timer)
    record.emit({ type: 'exit', sessionId, exitCode: 0 })
    console.log(`SERVERLINK_NATIVE_PREVIEW_SESSION_CLOSED ${sessionId}`)
    return true
  }

  closeOwner (ownerId) {
    for (const [id, record] of this.sessions) if (record.ownerId === ownerId) this.close(ownerId, id)
  }

  async closeAllAndWait () {
    for (const [id, record] of this.sessions) this.close(record.ownerId, id)
    return true
  }
}

/** 文件页也仅返回静态元数据；不读取本机目录，不提供真实上传路径。 */
class LocalFiles {
  async list () { return { id: 'fixture-local', path: '/demo', parentId: null, entries: [] } }
  selectedPaths () { throw new Error('隔离验收不提供本机文件传输') }
  closeOwner () {}
}

/** SFTP 桩仅支持只读空目录连接，所有网络客户端均未被加载。 */
class SftpManager {
  constructor () { this.connections = new Map() }
  async connect (ownerId) {
    const connectionId = randomUUID()
    this.connections.set(connectionId, ownerId)
    return { connectionId, path: '/demo', entries: [] }
  }

  assertOwned (ownerId, id) {
    if (this.connections.get(id) !== ownerId) throw new Error('fixture connection unavailable')
  }

  async list (ownerId, id, remotePath) {
    this.assertOwned(ownerId, id)
    return { path: remotePath, entries: [] }
  }

  close (ownerId, id) {
    this.assertOwned(ownerId, id)
    return this.connections.delete(id)
  }

  cancelConnect () {}
  cancelUpload (ownerId, id) { this.assertOwned(ownerId, id); return false }
  async uploadBatch () { throw new Error('隔离快捷键验收不提供本机文件传输') }
  closeOwner (ownerId) {
    for (const [id, owner] of this.connections) if (owner === ownerId) this.connections.delete(id)
  }

  closeAll () { this.connections.clear() }
}

// 必须在加载真实 main 前替换四个边界模块，不能实例化任何真实持久化或网络服务。
for (const [name, exports] of [
  ['profile-store', { ProfileStore }],
  ['session-manager', { SessionManager }],
  ['local-files', { LocalFiles }],
  ['sftp-manager', { SftpManager, validateRemotePath: value => value }]
]) {
  const filename = require.resolve(`../lib/${name}.cjs`)
  require.cache[filename] = { id: filename, filename, loaded: true, exports }
}
require('../main.cjs')

// 在真实 main 注册之后观察事件，保留它原有的 preventDefault 和清理顺序。
app.on('before-quit', () => console.log('SERVERLINK_NATIVE_PREVIEW_BEFORE_QUIT'))
app.on('will-quit', event => console.log(`SERVERLINK_NATIVE_PREVIEW_WILL_QUIT prevented=${event.defaultPrevented}`))
