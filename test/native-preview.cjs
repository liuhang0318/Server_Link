'use strict'

// 原生菜单验收专用：真实 Electron/main/preload/dist，所有主机和文件服务均为无网络桩。
const { app, session } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

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

const profiles = [1, 2].map(index => ({
  id: `00000000-0000-4000-8000-00000000000${index}`,
  name: `快捷键演示${index}`,
  host: `native-preview-${index}.example.com`,
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
}

/** 模拟终端生命周期；write 仅回显，绝不创建 PTY、调用 shell 或建立 SSH。 */
class SessionManager {
  constructor () { this.sessions = new Map() }
  async init () {}

  start (ownerId, profile, emit) {
    const sessionId = randomUUID()
    const timer = setTimeout(() => {
      if (!this.sessions.has(sessionId)) return
      emit({ type: 'progress', sessionId, phase: 'connected', logs: 'Static fixture: no network connection.' })
      emit({ type: 'data', sessionId, data: `\x1b[32m${profile.name} · 隔离演示，无远程连接\x1b[0m\r\n[${profile.username}@preview ~]$ ` })
    }, 700)
    this.sessions.set(sessionId, { ownerId, emit, timer })
    emit({ type: 'progress', sessionId, phase: 'connecting', logs: 'Preparing static fixture.' })
    return { sessionId, status: 'running' }
  }

  write (ownerId, sessionId, data) {
    const record = this.sessions.get(sessionId)
    if (record?.ownerId !== ownerId) return
    // --slow-echo 用于真实 Electron 窗口的输入预显验收，不访问任何远端服务器。
    setTimeout(() => {
      if (this.sessions.get(sessionId) === record) record.emit({ type: 'data', sessionId, data: data === '\x7f' ? '\b \b' : data })
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
