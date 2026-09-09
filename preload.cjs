'use strict'

const { contextBridge, ipcRenderer, webUtils } = require('electron')

/** @typedef {{name:string, host:string, port:number, username:string, auth:'agent'|'key'|'password', privateKeyPath:string|null}} ProfileInput */

function requireString (value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  return value
}

function requireInteger (value, label) {
  if (!Number.isInteger(value)) throw new TypeError(`${label} must be an integer`)
  return value
}

function requireSecret (value) {
  const secret = requireString(value, 'secret')
  if (secret.length > 4096) throw new TypeError('secret is too large')
  return secret
}

/**
 * Resolves only a genuine user-provided File through Electron's webUtils. A
 * synthetic File has no backing path, and no generic filesystem API crosses
 * the sandbox boundary.
 */
function getPathForDroppedPrivateKey (file) {
  if (
    !file ||
    typeof file !== 'object' ||
    typeof file.name !== 'string' ||
    !file.name ||
    file.name.length > 255 ||
    !Number.isFinite(file.size) ||
    file.size < 0
  ) {
    throw new TypeError('dropped item must be one local file')
  }

  // webUtils performs Electron's genuine-File check; constructed browser
  // Files return an empty path rather than granting arbitrary path access.
  const filePath = webUtils.getPathForFile(file)
  const containsControlCharacter = typeof filePath === 'string' && [...filePath].some(character => {
    const codePoint = character.codePointAt(0)
    return codePoint <= 31 || codePoint === 127
  })
  if (
    typeof filePath !== 'string' ||
    !filePath.startsWith('/') ||
    filePath.length > 4096 ||
    containsControlCharacter
  ) {
    throw new TypeError('dropped file has no valid absolute local path')
  }
  return filePath
}

const api = Object.freeze({
  app: Object.freeze({
    /** 单向接收明确的原生菜单动作，不泄漏 Electron 事件或开放通用 IPC。 */
    onAction: listener => {
      if (typeof listener !== 'function') throw new TypeError('listener must be a function')
      const wrapped = (_event, action) => {
        if (action === 'close-connection') listener(action)
      }
      ipcRenderer.on('app:action', wrapped)
      return () => ipcRenderer.removeListener('app:action', wrapped)
    }
  }),
  local: Object.freeze({
    list: (directoryId = null) => ipcRenderer.invoke('local:list', directoryId === null ? null : requireString(directoryId, 'directoryId')),
    upload: (fileIds, targets) => ipcRenderer.invoke('local:upload', fileIds, targets)
  }),
  profiles: Object.freeze({
    list: () => ipcRenderer.invoke('profiles:list'),
    /** @param {ProfileInput} profile */
    create: profile => ipcRenderer.invoke('profiles:create', profile),
    /** 批量共享用户名、端口及认证配置，文本列表由主进程逐行校验。 */
    createBatch: (common, hostsText) => ipcRenderer.invoke('profiles:create-batch', common, requireString(hostsText, 'hostsText')),
    /** @param {string} id @param {ProfileInput} profile */
    update: (id, profile) => ipcRenderer.invoke('profiles:update', requireString(id, 'id'), profile),
    remove: id => ipcRenderer.invoke('profiles:remove', requireString(id, 'id'))
  }),
  privateKeys: Object.freeze({
    getPathForFile: getPathForDroppedPrivateKey
  }),
  sessions: Object.freeze({
    start: profileId => ipcRenderer.invoke('sessions:start', requireString(profileId, 'profileId')),
    write: (sessionId, data) => ipcRenderer.invoke(
      'sessions:write',
      requireString(sessionId, 'sessionId'),
      requireString(data, 'data')
    ),
    resize: (sessionId, cols, rows) => ipcRenderer.invoke(
      'sessions:resize',
      requireString(sessionId, 'sessionId'),
      requireInteger(cols, 'cols'),
      requireInteger(rows, 'rows')
    ),
    close: sessionId => ipcRenderer.invoke('sessions:close', requireString(sessionId, 'sessionId')),
    onEvent: listener => {
      if (typeof listener !== 'function') throw new TypeError('listener must be a function')
      const wrapped = (_event, payload) => listener(payload)
      ipcRenderer.on('sessions:event', wrapped)
      return () => ipcRenderer.removeListener('sessions:event', wrapped)
    }
  }),
  sftp: Object.freeze({
    /** 仅暴露本窗口上传进度数据，隔离 Electron 事件对象并允许移除监听。 */
    onProgress: listener => {
      if (typeof listener !== 'function') throw new TypeError('listener must be a function')
      const wrapped = (_event, payload) => listener(payload)
      ipcRenderer.on('sftp:progress', wrapped)
      return () => ipcRenderer.removeListener('sftp:progress', wrapped)
    },
    cancelConnect: profileId => ipcRenderer.invoke('sftp:cancel-connect', requireString(profileId, 'profileId')),
    /** 仅允许终止本窗口所属连接的当前上传批次，不暴露文件删除或进程控制能力。 */
    cancelUpload: connectionId => ipcRenderer.invoke('sftp:cancel-upload', requireString(connectionId, 'connectionId')),
    /** 只从真实拖入的 File 解析路径，不向渲染层提供任意本地路径上传接口。 */
    uploadFiles: (connectionId, remoteDirectory, files) => {
      if (!Array.isArray(files) || files.length < 1 || files.length > 100) throw new TypeError('请一次拖入 1～100 个文件或文件夹')
      const paths = files.map(getPathForDroppedPrivateKey)
      return ipcRenderer.invoke('sftp:upload-files', requireString(connectionId, 'connectionId'), requireString(remoteDirectory, 'remoteDirectory'), paths)
    },
    copyBetween: (sourceId, sourcePath, destinationId, destinationDirectory) => ipcRenderer.invoke(
      'sftp:copy-between', requireString(sourceId, 'sourceId'), requireString(sourcePath, 'sourcePath'),
      requireString(destinationId, 'destinationId'), requireString(destinationDirectory, 'destinationDirectory')
    ),
    connect: (profileId, secret = '') => ipcRenderer.invoke(
      'sftp:connect',
      requireString(profileId, 'profileId'),
      requireSecret(secret)
    ),
    list: (connectionId, remotePath) => ipcRenderer.invoke(
      'sftp:list',
      requireString(connectionId, 'connectionId'),
      requireString(remotePath, 'remotePath')
    ),
    upload: (connectionId, remoteDirectory) => ipcRenderer.invoke(
      'sftp:upload',
      requireString(connectionId, 'connectionId'),
      requireString(remoteDirectory, 'remoteDirectory')
    ),
    download: (connectionId, remotePath) => ipcRenderer.invoke(
      'sftp:download',
      requireString(connectionId, 'connectionId'),
      requireString(remotePath, 'remotePath')
    ),
    mkdir: (connectionId, parentPath, name) => ipcRenderer.invoke(
      'sftp:mkdir',
      requireString(connectionId, 'connectionId'),
      requireString(parentPath, 'parentPath'),
      requireString(name, 'name')
    ),
    remove: (connectionId, remotePath) => ipcRenderer.invoke(
      'sftp:remove',
      requireString(connectionId, 'connectionId'),
      requireString(remotePath, 'remotePath')
    ),
    close: connectionId => ipcRenderer.invoke(
      'sftp:close',
      requireString(connectionId, 'connectionId')
    )
  })
})

// The renderer receives a fixed capability object, never raw ipcRenderer.
contextBridge.exposeInMainWorld('serverLink', api)
