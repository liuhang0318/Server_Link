'use strict'

const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { app, BrowserWindow, dialog, ipcMain, Menu, session } = require('electron')
const { ProfileStore } = require('./lib/profile-store.cjs')
const { SessionManager } = require('./lib/session-manager.cjs')
const { LocalFiles } = require('./lib/local-files.cjs')
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
let localFiles
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

/** 关闭快捷键只通知当前可信窗口，由界面按当前连接和传输状态决定是否关闭。 */
function closeFocusedConnection () {
  const window = BrowserWindow.getFocusedWindow()
  if (quitPending || !window || window.isDestroyed() || !BrowserWindow.getAllWindows().includes(window)) return
  const sender = window.webContents
  if (sender.isDestroyed() || sender.getURL() !== bundledRendererUrl || sender.mainFrame.url !== bundledRendererUrl) return

  // 不使用最近窗口兜底，也不直接销毁窗口，避免操作对话框时误关另一台服务器。
  sender.send('app:action', 'close-connection')
}

/** 使用系统菜单接管应用快捷键，同时保留输入框和终端的原生编辑操作。 */
function registerApplicationMenu () {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'ServerLink',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        // 原生 quit 继续经过既有窗口销毁和 PTY/SFTP 清理，不向 renderer 开放退出权限。
        { role: 'quit', label: '退出 ServerLink', accelerator: 'CmdOrCtrl+Q' }
      ]
    },
    {
      label: '连接',
      submenu: [{ id: 'close-connection', label: '关闭当前连接', accelerator: 'CmdOrCtrl+W', click: closeFocusedConnection }]
    },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] }
  ]))
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

/** 为本次上传绑定窗口及批次序号，所有上传入口复用同一进度通道。 */
function uploadProgress (sender) {
  // 只向发起上传的窗口推送元数据，不广播文件路径，也不让已销毁窗口的通知打断传输清理。
  return progress => {
    if (!quitPending && !sender.isDestroyed()) sender.send('sftp:progress', progress)
  }
}

/** Registers the narrow, typed IPC surface available to the sandboxed UI. */
function registerIpc () {
  ipcMain.handle('local:list', (event, directoryId) => localFiles.list(assertMainFrame(event), directoryId))
  ipcMain.handle('local:upload', async (event, fileIds, targets) => {
    const ownerId = assertMainFrame(event)
    const paths = localFiles.selectedPaths(ownerId, fileIds)
    if (!Array.isArray(targets) || targets.length < 1 || targets.length > 20) throw new Error('请选择 1～20 台目标服务器')
    if (targets.some(target => !target || typeof target !== 'object') || new Set(targets.map(target => target.connectionId)).size !== targets.length) throw new Error('上传目标无效或重复')
    const normalized = targets.map(target => {
      sftpManager.assertOwned(ownerId, target.connectionId)
      return { connectionId: target.connectionId, path: validateRemotePath(target.path) }
    })
    // 每台目标从一开始就拥有可取消的批次，停止一台不影响其他目标；目标数已限制为 20。
    return (await Promise.all(normalized.map(async target => {
      if (quitPending || event.sender.isDestroyed()) return []
      try {
        const results = await sftpManager.uploadBatch(ownerId, target.connectionId, target.path, paths, uploadProgress(event.sender))
        return results.map(result => ({ ...result, connectionId: target.connectionId }))
      } catch (error) {
        return paths.map(file => ({ connectionId: target.connectionId, name: path.basename(file), success: false, error: error.message }))
      }
    }))).flat()
  })
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
  ipcMain.handle('profiles:organize', (event, change) => {
    // 拖动和批量分组仍属于持久化写操作，只允许应用主文档通过专用元数据白名单修改。
    assertMainFrame(event)
    return profileStore.organize(change)
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
  ipcMain.handle('sftp:cancel-connect', (event, profileId) => sftpManager.cancelConnect(assertMainFrame(event), profileId))
  ipcMain.handle('sftp:cancel-upload', (event, connectionId) => sftpManager.cancelUpload(assertMainFrame(event), connectionId))
  ipcMain.handle('sftp:upload-files', async (event, connectionId, remoteDirectory, paths) => {
    const ownerId = assertMainFrame(event)
    sftpManager.assertOwned(ownerId, connectionId)
    validateRemotePath(remoteDirectory)
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > 100 || paths.some(file => typeof file !== 'string')) {
      throw new TypeError('invalid dropped files')
    }
    if (quitPending || event.sender.isDestroyed()) throw new Error('SFTP connection unavailable')
    // 文件和文件夹共用扫描、进度、取消与同名保护，主进程不再逐文件拆成不可整体取消的调用。
    return sftpManager.uploadBatch(ownerId, connectionId, remoteDirectory, paths, uploadProgress(event.sender))
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
      title: '选择要上传的文件或文件夹',
      properties: ['openFile', 'openDirectory', 'multiSelections']
    })
    if (selection.canceled || !selection.filePaths.length) return { canceled: true }
    if (quitPending || sender.isDestroyed()) throw new Error('SFTP connection unavailable')
    return { canceled: false, results: await sftpManager.uploadBatch(ownerId, connectionId, remoteDirectory, selection.filePaths, uploadProgress(sender)) }
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
  window.webContents.on('before-input-event', (event, input) => {
    const command = process.platform === 'darwin' ? input.meta : input.control
    // 长按 ⌘W 只关闭第一次选中的连接，后续重复键不得顺着相邻选择连续关闭。
    if (input.type === 'keyDown' && input.isAutoRepeat && command && !input.alt && !input.shift && input.key.toLowerCase() === 'w') event.preventDefault()
  })
  window.webContents.on('render-process-gone', () => {
    localFiles.closeOwner(ownerId)
    sessionManager.closeOwner(ownerId)
    sftpManager.closeOwner(ownerId)
  })
  window.webContents.on('destroyed', () => {
    localFiles.closeOwner(ownerId)
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
    if (process.platform === 'darwin' && app.isPackaged) {
      // 仅刷新本应用 Dock 图标，不重启 Dock 或改动系统全局投影设置。
      app.dock?.setIcon(path.join(process.resourcesPath, 'dock-icon.png'))
    }
    const privateDataDirectory = path.join(app.getPath('userData'), 'secure-data')
    profileStore = new ProfileStore(privateDataDirectory)
    localFiles = new LocalFiles(app.getPath('home'))
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
    registerApplicationMenu()

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
    // 先让 Electron 的 will-quit 原生回调退栈；已完成清理的微任务直接重入 quit 可能被忽略。
    setImmediate(() => app.quit())
  })
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
