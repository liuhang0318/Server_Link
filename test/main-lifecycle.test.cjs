'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { pathToFileURL } = require('node:url')
const vm = require('node:vm')

function createCancelableEvent () {
  let defaultPrevented = false
  return {
    get defaultPrevented () { return defaultPrevented },
    preventDefault: () => { defaultPrevented = true }
  }
}

/** Executes the real main process source against the smallest Electron lifecycle fake. */
async function createMainHarness () {
  const projectDirectory = path.join(__dirname, '..')
  const rendererUrl = pathToFileURL(path.join(projectDirectory, 'dist', 'index.html')).href
  const ipcHandlers = new Map()
  const windows = []
  const calls = {
    beforeQuitPrevented: [],
    closeAllWindowCounts: [],
    createdWindows: 0,
    quitCalls: 0,
    willQuitEvents: 0,
    sessionStarts: 0,
    uploads: [],
    progress: [],
    menu: null
  }
  let focusedWindow = null
  let nextWebContentsId = 1
  let resolveSessionCleanup
  const pendingProfileReads = []
  const sessionCleanup = new Promise(resolve => { resolveSessionCleanup = resolve })

  class FakeWebContents extends EventEmitter {
    constructor () {
      super()
      this.id = nextWebContentsId++
      this.mainFrame = { url: rendererUrl }
      this.url = rendererUrl
      this.destroyed = false
    }

    getURL () { return this.url }
    isDestroyed () { return this.destroyed }
    setWindowOpenHandler () {}
    send (channel, payload) { calls.progress.push({ ownerId: this.id, channel, payload }) }

    destroy () {
      this.destroyed = true
      this.emit('destroyed')
    }
  }

  class FakeBrowserWindow extends EventEmitter {
    constructor () {
      super()
      calls.createdWindows++
      this.webContents = new FakeWebContents()
      windows.push(this)
      focusedWindow = this
    }

    static getAllWindows () { return windows.slice() }
    static getFocusedWindow () { return focusedWindow }
    isDestroyed () { return this.webContents.destroyed }
    loadFile () { return Promise.resolve() }

    close () {
      const event = createCancelableEvent()
      this.emit('close', event)
      if (event.defaultPrevented) return false
      this.destroy()
      return true
    }

    destroy () {
      const index = windows.indexOf(this)
      if (index !== -1) windows.splice(index, 1)
      if (focusedWindow === this) focusedWindow = null
      this.webContents.destroy()
    }
  }

  class FakeProfileStore {
    async init () {}
    get () {
      return new Promise(resolve => { pendingProfileReads.push(resolve) })
    }
  }

  class FakeSessionManager {
    async init () {}
    closeOwner () {}
    closeAllAndWait () {
      // Electron must have destroyed every renderer before native shutdown can wait.
      calls.closeAllWindowCounts.push(FakeBrowserWindow.getAllWindows().length)
      return sessionCleanup
    }

    start () {
      calls.sessionStarts++
      return { sessionId: 'unused', status: 'running' }
    }
  }

  class FakeSftpManager {
    closeOwner () {}
    closeAll () {}
    assertOwned () {}
    async uploadBatch (ownerId, connectionId, remotePath, files, onProgress) {
      return files.map((file, index) => {
        calls.uploads.push({ ownerId, connectionId, remotePath, file })
        onProgress({ connectionId, name: path.basename(file), transferred: 0, total: 10, phase: 'uploading', fileIndex: index + 1, fileCount: files.length })
        return { name: path.basename(file), success: connectionId !== 'failure', error: connectionId === 'failure' ? 'server unavailable' : undefined }
      })
    }

    cancelUpload (ownerId, connectionId) {
      calls.canceledUpload = { ownerId, connectionId }
      return true
    }
  }

  class FakeApp extends EventEmitter {
    constructor () {
      super()
      this.quitAccepted = false
    }

    getPath () { return '/tmp/serverlink-main-lifecycle-test' }
    requestSingleInstanceLock () { return true }
    setName () {}
    whenReady () { return Promise.resolve() }

    quit () {
      calls.quitCalls++
      this.quitAccepted = false
      const beforeQuit = createCancelableEvent()
      this.emit('before-quit', beforeQuit)
      calls.beforeQuitPrevented.push(beforeQuit.defaultPrevented)
      if (beforeQuit.defaultPrevented) return

      // Match Electron's documented order: close renderers before will-quit.
      for (const window of FakeBrowserWindow.getAllWindows()) {
        if (!window.close()) return
      }
      const willQuit = createCancelableEvent()
      calls.willQuitEvents++
      this.emit('will-quit', willQuit)
      this.quitAccepted = !willQuit.defaultPrevented
    }
  }

  const harness = {
    app: new FakeApp(),
    calls,
    ipcHandlers,
    resolveProfile: profile => pendingProfileReads.shift()(profile),
    resolveSessionCleanup,
    createWindow: () => new FakeBrowserWindow(),
    focusWindow: window => { focusedWindow = window },
    windows
  }
  const electron = {
    app: harness.app,
    BrowserWindow: FakeBrowserWindow,
    dialog: {},
    Menu: {
      buildFromTemplate: template => {
        template.popup = options => { calls.popup = { template, options } }
        return template
      },
      setApplicationMenu: menu => { calls.menu = menu }
    },
    ipcMain: {
      handle: (channel, handler) => ipcHandlers.set(channel, handler)
    },
    session: {
      defaultSession: {
        setPermissionCheckHandler: () => {},
        setPermissionRequestHandler: () => {},
        webRequest: { onHeadersReceived: () => {} }
      }
    }
  }
  const mainSource = readFileSync(path.join(projectDirectory, 'main.cjs'), 'utf8')
  vm.runInNewContext(mainSource, {
    __dirname: projectDirectory,
    console,
    setImmediate,
    process: { platform: 'darwin' },
    require: moduleName => {
      if (moduleName === 'electron') return electron
      if (moduleName === './lib/profile-store.cjs') return { ProfileStore: FakeProfileStore }
      if (moduleName === './lib/session-manager.cjs') return { SessionManager: FakeSessionManager }
      if (moduleName === './lib/local-files.cjs') {
        return {
          LocalFiles: class {
            closeOwner () {}
            selectedPaths (_ownerId, ids) { return ids.map(id => `/tmp/${id}.txt`) }
          }
        }
      }
      if (moduleName === './lib/sftp-manager.cjs') {
        return { SftpManager: FakeSftpManager, validateRemotePath: value => value }
      }
      return require(moduleName)
    }
  })

  // Let whenReady initialization register IPC and create the first window.
  await new Promise(resolve => setImmediate(resolve))
  return harness
}

function startSession (harness, sender) {
  return harness.ipcHandlers.get('sessions:start')(
    { sender, senderFrame: sender.mainFrame },
    'profile-id'
  )
}

test('native tab menu uses a fixed action list, stays in its owner window and dismisses without action', async () => {
  const h = await createMainHarness()
  const window = h.windows[0]
  const sender = window.webContents
  const show = h.ipcHandlers.get('app:tab-menu')
  const event = { sender, senderFrame: sender.mainFrame }
  const result = show(event, { kind: 'ssh', reconnect: true, busy: false })
  assert.equal(h.calls.popup.options.window, window)
  assert.deepEqual(Array.from(h.calls.popup.template.filter(item => item.label), item => item.label), ['重新连接', '复制连接', '在新窗口中打开副本', '重命名标签…', '关闭'])
  h.calls.popup.template.find(item => item.label === '复制连接').click()
  h.calls.popup.options.callback()
  assert.equal(await result, 'duplicate')
  const dismissed = show(event, { kind: 'sftp', reconnect: false, busy: true })
  assert.equal(h.calls.popup.template.find(item => item.label === '刷新文件列表').enabled, false)
  assert.equal(h.calls.popup.template.find(item => item.label === '关闭').enabled, true)
  h.calls.popup.options.callback()
  assert.equal(await dismissed, null)
  assert.throws(() => show({ sender, senderFrame: {} }, { kind: 'ssh', reconnect: true, busy: false }), /untrusted/u)
  assert.throws(() => show(event, { kind: 'arbitrary-role', reconnect: true, busy: false }), /invalid/u)
  const pending = show(event, { kind: 'local', reconnect: false, busy: false })
  window.destroy()
  assert.equal(await pending, null)
})

test('new connection windows consume only their own validated launch request once', async () => {
  const h = await createMainHarness()
  const source = h.windows[0].webContents
  const event = { sender: source, senderFrame: source.mainFrame }
  const open = h.ipcHandlers.get('app:open-connection-window')
  const take = h.ipcHandlers.get('app:take-initial-connection')
  const opening = open(event, { kind: 'ssh', profileId: 'profile-id', title: '部署终端', command: 'must-not-copy', secret: 'must-not-copy' })
  h.resolveProfile({ id: 'profile-id' })
  assert.equal(await opening, true)
  assert.equal(h.windows.length, 2)
  assert.equal(take(event), null)
  const child = h.windows[1].webContents
  const childEvent = { sender: child, senderFrame: child.mainFrame }
  assert.deepEqual(JSON.parse(JSON.stringify(take(childEvent))), { kind: 'ssh', profileId: 'profile-id', title: '部署终端' })
  assert.equal(take(childEvent), null)
  await assert.rejects(open(event, { kind: 'shell', profileId: 'profile-id', title: 'unsafe' }), /invalid/u)
  await assert.rejects(open(event, { kind: 'ssh', profileId: 'profile-id', title: 'unsafe\nname' }), /invalid/u)
  const missing = open(event, { kind: 'sftp', profileId: 'missing', title: 'missing' })
  h.resolveProfile(null)
  await assert.rejects(missing, /配置已删除/u)
  const late = open(event, { kind: 'ssh', profileId: 'profile-id', title: 'late' })
  h.windows[0].destroy()
  h.resolveProfile({ id: 'profile-id' })
  assert.equal(await late, false)
  assert.equal(h.windows.length, 1)
})

test('main closes renderers before PTY wait and rejects their pending session starts', async () => {
  const harness = await createMainHarness()
  assert.equal(harness.windows.length, 1)
  const sender = harness.windows[0].webContents
  const request = startSession(harness, sender)

  const quitItem = harness.calls.menu.flatMap(menu => menu.submenu).find(item => item.role === 'quit')
  assert.equal(quitItem.accelerator, 'CmdOrCtrl+Q')
  assert.equal(quitItem.click, undefined)
  // Electron 的 quit role 调用 app.quit；继续验证它没有绕过既有退出清理链。
  harness.app.quit()

  assert.deepEqual(harness.calls.closeAllWindowCounts, [0])
  assert.equal(harness.windows.length, 0)
  assert.equal(harness.app.quitAccepted, false)

  // A Dock activation during the bounded PTY wait must not revive interactive UI.
  harness.app.emit('activate')
  assert.equal(harness.calls.createdWindows, 1)

  harness.resolveProfile({ id: 'profile-id' })
  await assert.rejects(request, /session unavailable/u)
  assert.equal(harness.calls.sessionStarts, 0)

  // Finish the intercepted quit so the harness leaves no pending lifecycle work.
  harness.resolveSessionCleanup(true)
  // 清理已完成也不能在 Promise 微任务里重入原生退出事件，必须等下一轮主循环。
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(harness.calls.quitCalls, 1)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(harness.app.quitAccepted, true)
})

test('native close shortcut targets only the focused trusted window and never closes its window', async () => {
  const harness = await createMainHarness()
  const original = harness.windows[0]
  const other = harness.createWindow()
  const entries = harness.calls.menu.flatMap(menu => menu.submenu)
  const closeItem = entries.find(item => item.id === 'close-connection')
  assert.equal(closeItem.accelerator, 'CmdOrCtrl+W')
  assert.equal(entries.some(item => item.role === 'close'), false)
  for (const role of ['cut', 'copy', 'paste', 'selectAll']) assert.ok(entries.some(item => item.role === role))

  harness.focusWindow(original)
  closeItem.click()
  assert.deepEqual(harness.calls.progress, [{ ownerId: original.webContents.id, channel: 'app:action', payload: 'close-connection' }])
  assert.equal(harness.windows.length, 2)
  assert.equal(harness.calls.quitCalls, 0)

  // 无焦点、外来窗口、页面变化、已销毁窗口均不能兜底到仍存活的另一窗口。
  harness.focusWindow(null)
  closeItem.click()
  harness.focusWindow({ isDestroyed: () => false, webContents: original.webContents })
  closeItem.click()
  harness.focusWindow(other)
  other.webContents.url = 'https://example.com'
  closeItem.click()
  other.webContents.url = original.webContents.url
  other.webContents.mainFrame.url = 'https://example.com'
  closeItem.click()
  other.destroy()
  harness.focusWindow(other)
  closeItem.click()
  assert.equal(harness.calls.progress.length, 1)
  assert.equal(harness.windows.length, 1)
})

test('native close shortcut ignores repeat keys without blocking ordinary edit shortcuts', async () => {
  const harness = await createMainHarness()
  const sender = harness.windows[0].webContents
  const inputs = [
    [{ type: 'keyDown', key: 'w', meta: true, isAutoRepeat: true }, true],
    [{ type: 'keyDown', key: 'W', meta: true, isAutoRepeat: true }, true],
    [{ type: 'keyDown', key: 'w', meta: true, isAutoRepeat: false }, false],
    [{ type: 'keyUp', key: 'w', meta: true, isAutoRepeat: true }, false],
    [{ type: 'keyDown', key: 'w', control: true, isAutoRepeat: true }, false],
    [{ type: 'keyDown', key: 'w', meta: true, shift: true, isAutoRepeat: true }, false],
    [{ type: 'keyDown', key: 'c', meta: true, isAutoRepeat: true }, false]
  ]
  for (const [input, prevented] of inputs) {
    const event = createCancelableEvent()
    sender.emit('before-input-event', event, input)
    assert.equal(event.defaultPrevented, prevented)
  }
})

test('canceling a window close never enters will-quit and leaves connections available', async () => {
  const harness = await createMainHarness()
  const window = harness.windows[0]
  window.once('close', event => event.preventDefault())

  harness.app.quit()

  assert.deepEqual(harness.calls.beforeQuitPrevented, [false])
  assert.equal(harness.calls.willQuitEvents, 0)
  assert.deepEqual(harness.calls.closeAllWindowCounts, [])
  assert.equal(harness.windows.length, 1)

  const request = startSession(harness, window.webContents)
  harness.resolveProfile({ id: 'profile-id' })
  assert.deepEqual(await request, { sessionId: 'unused', status: 'running' })
  assert.equal(harness.calls.sessionStarts, 1)
})

test('red-close rejects a profile read that outlives its renderer without quitting the app', async () => {
  const harness = await createMainHarness()
  const window = harness.windows[0]
  const sender = window.webContents
  const request = startSession(harness, sender)

  assert.equal(window.close(), true)
  harness.app.emit('window-all-closed')
  harness.resolveProfile({ id: 'profile-id' })

  await assert.rejects(request, /session unavailable/u)
  assert.equal(sender.isDestroyed(), true)
  assert.equal(harness.calls.quitCalls, 0)
  assert.equal(harness.calls.sessionStarts, 0)
})

test('Dock activation after red-close creates a fresh connectable window', async () => {
  const harness = await createMainHarness()
  const originalWindow = harness.windows[0]

  assert.equal(originalWindow.close(), true)
  harness.app.emit('window-all-closed')
  harness.app.emit('activate')

  assert.equal(harness.windows.length, 1)
  assert.equal(harness.calls.createdWindows, 2)
  assert.notEqual(harness.windows[0].webContents.id, originalWindow.webContents.id)

  const request = startSession(harness, harness.windows[0].webContents)
  harness.resolveProfile({ id: 'profile-id' })
  assert.deepEqual(await request, { sessionId: 'unused', status: 'running' })
  assert.equal(harness.calls.sessionStarts, 1)
})

test('local upload fans out to selected servers and reports each file independently', async () => {
  const harness = await createMainHarness()
  const sender = harness.windows[0].webContents
  const invoke = harness.ipcHandlers.get('local:upload')
  const targets = [{ connectionId: 'failure', path: '/first' }, { connectionId: 'healthy', path: '/second' }]
  const result = await invoke({ sender, senderFrame: sender.mainFrame }, ['one', 'two'], targets)
  assert.deepEqual(Array.from(result, item => item.success), [false, false, true, true])
  assert.equal(harness.calls.uploads.length, 4)
  assert.equal(harness.calls.uploads[2].ownerId, sender.id)
  assert.equal(harness.calls.uploads[2].remotePath, '/second')
  assert.ok(harness.calls.progress.every(item => item.ownerId === sender.id && item.channel === 'sftp:progress'))
  assert.deepEqual(harness.calls.progress.map(item => item.payload.fileIndex), [1, 2, 1, 2])
  assert.ok(harness.calls.progress.every(item => item.payload.fileCount === 2))
  await assert.rejects(invoke({ sender, senderFrame: {} }, ['one'], targets), /untrusted/u)
  assert.equal(harness.calls.uploads.length, 4)
})

test('upload cancellation requires the trusted frame and stays scoped to its owner', async () => {
  const harness = await createMainHarness()
  const sender = harness.windows[0].webContents
  const cancel = harness.ipcHandlers.get('sftp:cancel-upload')
  assert.throws(() => cancel({ sender, senderFrame: {} }, 'fixture-upload'), /untrusted/u)
  assert.equal(harness.calls.canceledUpload, undefined)
  assert.equal(cancel({ sender, senderFrame: sender.mainFrame }, 'fixture-upload'), true)
  assert.deepEqual(harness.calls.canceledUpload, { ownerId: sender.id, connectionId: 'fixture-upload' })
})
