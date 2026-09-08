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
    sessionStarts: 0
  }
  let nextWebContentsId = 1
  let resolveSessionCleanup
  const pendingProfileReads = []
  const sessionCleanup = new Promise(resolve => { resolveSessionCleanup = resolve })

  class FakeWebContents extends EventEmitter {
    constructor () {
      super()
      this.id = nextWebContentsId++
      this.mainFrame = { url: rendererUrl }
      this.destroyed = false
    }

    getURL () { return rendererUrl }
    isDestroyed () { return this.destroyed }
    setWindowOpenHandler () {}

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
    }

    static getAllWindows () { return windows.slice() }
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
    windows
  }
  const electron = {
    app: harness.app,
    BrowserWindow: FakeBrowserWindow,
    dialog: {},
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
    process: { platform: 'darwin' },
    require: moduleName => {
      if (moduleName === 'electron') return electron
      if (moduleName === './lib/profile-store.cjs') return { ProfileStore: FakeProfileStore }
      if (moduleName === './lib/session-manager.cjs') return { SessionManager: FakeSessionManager }
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

test('main closes renderers before PTY wait and rejects their pending session starts', async () => {
  const harness = await createMainHarness()
  assert.equal(harness.windows.length, 1)
  const sender = harness.windows[0].webContents
  const request = startSession(harness, sender)

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
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(harness.app.quitAccepted, true)
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
