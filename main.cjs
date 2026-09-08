'use strict'

const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { app, BrowserWindow, dialog, ipcMain, session } = require('electron')
const { ProfileStore } = require('./lib/profile-store.cjs')
const { SessionManager } = require('./lib/session-manager.cjs')
const { SftpManager, validateRemotePath } = require('./lib/sftp-manager.cjs')

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  // xterm 的 DOM 渲染器动态创建样式表来设置字符宽度、光标和 ANSI 颜色。
  // 仅允许动态样式；脚本仍限制为应用内文件，远端输出不作为 HTML 渲染。
  "style-src-elem 'self' 'unsafe-inline'",
  "style-src-attr 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

let profileStore
let sessionManager
let sftpManager
let quitPending = false
let shutdownComplete = false
let windowsReady = false
const bundledRendererUrl = pathToFileURL(path.join(__dirname, 'dist', 'index.html')).href

function assertMainFrame (event) {
  if (
    event.senderFrame !== event.sender.mainFrame ||
    event.senderFrame.url !== bundledRendererUrl ||
    event.sender.getURL() !== bundledRendererUrl
  ) {
    throw new Error('untrusted document cannot access ServerLink IPC')
  }
  return event.sender.id
}

/** Resolves an IPC sender only to its still-owned application window. */
function windowForSender (sender) {
  return BrowserWindow.getAllWindows().find(window => window.webContents === sender) ?? null
}

/** Requires an explicit native confirmation before persisting first-use host trust. */
async function confirmNewHost (ownerId, details) {
  const window = BrowserWindow.getAllWindows().find(item => item.webContents.id === ownerId)
  if (!window || window.webContents.isDestroyed()) return false
  const target = details.port === 22 ? details.host : `[${details.host}]:${details.port}`
  const result = await dialog.showMessageBox(window, {
    type: 'warning',
    title: '确认 SSH 主机指纹',
    message: `首次连接 ${target}`,
    detail: `密钥类型：${details.keyType}\n指纹：${details.fingerprint}\n\n请先与服务器管理员核对指纹。信任后将保存到 ServerLink 专用 known_hosts。`,
    buttons: ['信任并继续', '取消'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  })
  return result.response === 0
}

/** Registers the narrow, typed IPC surface available to the sandboxed UI. */
function registerIpc () {
  ipcMain.handle('profiles:list', event => {
    assertMainFrame(event)
    return profileStore.list()
  })
  ipcMain.handle('profiles:create', (event, input) => {
    assertMainFrame(event)
    return profileStore.create(input)
  })
  ipcMain.handle('profiles:create-batch', (event, common, hostsText) => {
    // 与单台配置相同的文档归属校验，解析与原子写入均留在主进程。
    assertMainFrame(event)
    return profileStore.createBatch(common, hostsText)
  })
  ipcMain.handle('profiles:update', (event, id, input) => {
    assertMainFrame(event)
    return profileStore.update(id, input)
  })
  ipcMain.handle('profiles:remove', (event, id) => {
    assertMainFrame(event)
    return profileStore.remove(id)
  })

  ipcMain.handle('sessions:start', async (event, profileId) => {
    const ownerId = assertMainFrame(event)
    const sender = event.sender
    const profile = await profileStore.get(profileId)
    if (!profile) throw new Error('profile not found')
    // The window may close while the profile read is pending. Recheck after
    // that boundary so no ownerless SSH process can escape the cleanup snapshot.
    if (quitPending || sender.isDestroyed()) throw new Error('session unavailable')

    // Events are sent only to the WebContents that owns the native process.
    return sessionManager.start(ownerId, profile, payload => {
      if (!sender.isDestroyed()) sender.send('sessions:event', payload)
    })
  })
  ipcMain.handle('sessions:write', (event, sessionId, data) => {
    sessionManager.write(assertMainFrame(event), sessionId, data)
    return true
  })
  ipcMain.handle('sessions:resize', (event, sessionId, cols, rows) => {
    sessionManager.resize(assertMainFrame(event), sessionId, cols, rows)
    return true
  })
  ipcMain.handle('sessions:close', (event, sessionId) => (
    sessionManager.close(assertMainFrame(event), sessionId)
  ))

  ipcMain.handle('sftp:connect', async (event, profileId, secret) => {
    const ownerId = assertMainFrame(event)
    const sender = event.sender
    const profile = await profileStore.get(profileId)
    if (!profile) throw new Error('profile not found')
    if (quitPending || sender.isDestroyed()) throw new Error('SFTP connection unavailable')

    // The manager owns the network client and consumes the credential only for
    // this handshake; neither profile persistence nor renderer state receives it back.
    return sftpManager.connect(ownerId, profile, secret)
  })
  ipcMain.handle('sftp:list', (event, connectionId, remotePath) => (
    sftpManager.list(assertMainFrame(event), connectionId, remotePath)
  ))
  ipcMain.handle('sftp:upload-files', async (event, connectionId, remoteDirectory, paths) => {
    const ownerId = assertMainFrame(event)
    sftpManager.assertOwned(ownerId, connectionId)
    validateRemotePath(remoteDirectory)
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > 100 || paths.some(file => typeof file !== 'string')) {
      throw new TypeError('invalid dropped files')
    }
    const results = []
    // 单批串行传输，逐项报告成功和失败；关闭窗口后不再启动后续上传。
    for (const file of paths) {
      if (quitPending || event.sender.isDestroyed()) break
      try {
        const result = await sftpManager.upload(ownerId, connectionId, remoteDirectory, file)
        results.push({ name: result.name, success: true })
      } catch (error) {
        results.push({ name: path.basename(file), success: false, error: error.message })
      }
    }
    return results
  })
  ipcMain.handle('sftp:copy-between', (event, sourceId, sourcePath, destinationId, destinationDirectory) => {
    // manager 同时检查源和目标的窗口归属，不开放任意 SSH 命令或额外网络连接。
    return sftpManager.copyBetween(assertMainFrame(event), sourceId, sourcePath, destinationId, destinationDirectory)
  })
  ipcMain.handle('sftp:upload', async (event, connectionId, remoteDirectory) => {
    const ownerId = assertMainFrame(event)
    sftpManager.assertOwned(ownerId, connectionId)
    const sender = event.sender
    const window = windowForSender(sender)
    if (!window) throw new Error('SFTP window unavailable')
    // Selecting the local source in the trusted main process prevents the
    // sandboxed renderer from supplying an arbitrary readable filesystem path.
    const selection = await dialog.showOpenDialog(window, {
      title: '选择要上传的文件',
      properties: ['openFile']
    })
    if (selection.canceled || selection.filePaths.length !== 1) return { canceled: true }
    if (quitPending || sender.isDestroyed()) throw new Error('SFTP connection unavailable')
    return sftpManager.upload(ownerId, connectionId, remoteDirectory, selection.filePaths[0])
  })
  ipcMain.handle('sftp:download', async (event, connectionId, remotePath) => {
    const ownerId = assertMainFrame(event)
    sftpManager.assertOwned(ownerId, connectionId)
    const normalizedPath = validateRemotePath(remotePath)
    const sender = event.sender
    const window = windowForSender(sender)
    if (!window) throw new Error('SFTP window unavailable')
    // The renderer names the remote source only; the native save dialog remains
    // the sole authority that chooses a writable local destination.
    const selection = await dialog.showSaveDialog(window, {
      title: '保存远程文件',
      defaultPath: path.posix.basename(normalizedPath)
    })
    if (selection.canceled || !selection.filePath) return { canceled: true }
    if (quitPending || sender.isDestroyed()) throw new Error('SFTP connection unavailable')
    return sftpManager.download(ownerId, connectionId, normalizedPath, selection.filePath)
  })
  ipcMain.handle('sftp:mkdir', (event, connectionId, parentPath, name) => (
    sftpManager.mkdir(assertMainFrame(event), connectionId, parentPath, name)
  ))
  ipcMain.handle('sftp:remove', async (event, connectionId, remotePath) => {
    const ownerId = assertMainFrame(event)
    sftpManager.assertOwned(ownerId, connectionId)
    const normalizedPath = validateRemotePath(remotePath)
    const sender = event.sender
    const window = windowForSender(sender)
    if (!window) throw new Error('SFTP window unavailable')
    // Destructive remote operations require a trusted native confirmation;
    // a compromised renderer cannot silently approve its own delete request.
    const confirmation = await dialog.showMessageBox(window, {
      type: 'warning',
      title: '确认删除远程项目',
      message: `确定删除“${path.posix.basename(normalizedPath)}”吗？`,
      detail: '文件会被永久删除；目录只有在为空时才能删除。此操作无法撤销。',
      buttons: ['删除', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    })
    if (confirmation.response !== 0) return false
    if (quitPending || sender.isDestroyed()) throw new Error('SFTP connection unavailable')
    return sftpManager.remove(ownerId, connectionId, normalizedPath)
  })
  ipcMain.handle('sftp:close', (event, connectionId) => (
    sftpManager.close(assertMainFrame(event), connectionId)
  ))
}

/** Creates the only application window with remote content capabilities off. */
function createWindow () {
  const window = new BrowserWindow({
    width: 1240,
    height: 780,
    minWidth: 900,
    minHeight: 580,
    show: false,
    title: 'ServerLink',
    backgroundColor: '#090d14',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: false,
      spellcheck: false
    }
  })

  const ownerId = window.webContents.id
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.on('will-attach-webview', event => event.preventDefault())
  window.webContents.on('render-process-gone', () => {
    sessionManager.closeOwner(ownerId)
    sftpManager.closeOwner(ownerId)
  })
  window.webContents.on('destroyed', () => {
    sessionManager.closeOwner(ownerId)
    sftpManager.closeOwner(ownerId)
  })
  window.once('ready-to-show', () => window.show())

  // Only the bundled file is loaded; there is no development URL fallback.
  window.loadFile(path.join(__dirname, 'dist', 'index.html')).catch(error => {
    console.error('ServerLink renderer failed to load:', error)
    app.quit()
  })
  return window
}

app.setName('ServerLink')

// Only the lock owner may initialize profile persistence or native SSH sessions.
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (quitPending) return
    const existingWindow = BrowserWindow.getAllWindows()[0]
    if (!existingWindow) {
      // Initialization must finish before a replacement window can issue profile or SSH IPC.
      if (windowsReady) createWindow()
      return
    }

    // Bring the existing profile owner forward instead of starting a concurrent writer.
    if (existingWindow.isMinimized()) existingWindow.restore()
    existingWindow.show()
    existingWindow.focus()
  })

  app.whenReady().then(async () => {
    const privateDataDirectory = path.join(app.getPath('userData'), 'secure-data')
    profileStore = new ProfileStore(privateDataDirectory)
    sessionManager = new SessionManager({
      knownHostsPath: path.join(privateDataDirectory, 'known_hosts')
    })
    sftpManager = new SftpManager({
      knownHostsPath: path.join(privateDataDirectory, 'known_hosts'),
      confirmHost: confirmNewHost
    })

    // Prepare owner-only files before accepting renderer requests or spawning ssh.
    await profileStore.init()
    await sessionManager.init()
    registerIpc()

    // Permission APIs and response headers remain locked even if future UI code regresses.
    session.defaultSession.setPermissionCheckHandler(() => false)
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
      // Electron's permission callback takes a boolean, not Node's error-first shape.
      // eslint-disable-next-line n/no-callback-literal
      callback(false)
    })
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      // Electron's webRequest callback likewise expects an override object.
      // eslint-disable-next-line n/no-callback-literal
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [CONTENT_SECURITY_POLICY]
        }
      })
    })

    windowsReady = true
    createWindow()
    app.on('activate', () => {
      // will-quit may be awaiting PTY cleanup after every renderer is gone;
      // never recreate an interactive window during that shutdown phase.
      if (!quitPending && BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  }).catch(error => {
    console.error('ServerLink failed to initialize:', error)
    app.quit()
  })
}

app.on('will-quit', event => {
  if (shutdownComplete || !sessionManager) return
  event.preventDefault()
  if (quitPending) return
  quitPending = true

  // SFTP has no interactive renderer once quitting begins; close its network
  // clients before waiting on the longer-lived native PTY shutdown sequence.
  sftpManager?.closeAll()

  // will-quit runs after renderer windows close, so users cannot start another
  // SSH session while native children finish the bounded shutdown sequence.
  sessionManager.closeAllAndWait().catch(error => {
    console.error('ServerLink sessions failed to close cleanly:', error)
  }).finally(() => {
    shutdownComplete = true
    app.quit()
  })
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
