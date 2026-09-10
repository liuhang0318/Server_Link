'use strict'

const fs = require('node:fs/promises')
const { pipeline } = require('node:stream/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { Client, utils } = require('@electerm/ssh2')
const { setTimeout: delay } = require('node:timers/promises')
const { isTransientConnectionError } = require('./connection-retry.cjs')
const { checkKnownHost, trustKnownHost } = require('./known-hosts.cjs')
const { normalizeProfileInput } = require('./ssh-args.cjs')
const { scanUploadSources, openUploadSource } = require('./upload-sources.cjs')

const MAX_KEY_SIZE = 1024 * 1024
const MAX_SECRET_SIZE = 4096
const MAX_DIRECTORY_ENTRIES = 10000

function validateOwnerId (ownerId) {
  if (!Number.isInteger(ownerId) || ownerId < 1) throw new TypeError('owner id is invalid')
}

function validateConnectionId (connectionId) {
  if (typeof connectionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(connectionId)) {
    throw new TypeError('SFTP connection id is invalid')
  }
}

function containsControlCharacter (value) {
  return [...value].some(character => {
    const codePoint = character.codePointAt(0)
    return codePoint <= 31 || codePoint === 127
  })
}

/** Normalizes only absolute POSIX paths before they cross the SFTP boundary. */
function validateRemotePath (value) {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    Buffer.byteLength(value, 'utf8') > 4096 ||
    containsControlCharacter(value)
  ) {
    throw new TypeError('remote path must be an absolute POSIX path')
  }
  return path.posix.normalize(value)
}

function validateRemoteName (value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    Buffer.byteLength(value, 'utf8') > 255 ||
    containsControlCharacter(value)
  ) {
    throw new TypeError('remote name is invalid')
  }
  return value
}

function validateLocalPath (value) {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    Buffer.byteLength(value, 'utf8') > 4096 ||
    containsControlCharacter(value)
  ) {
    throw new TypeError('local path must be absolute')
  }
  return path.normalize(value)
}

function validateSecret (profile, secret) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') > MAX_SECRET_SIZE) {
    throw new TypeError('temporary credential is invalid')
  }
  if (profile.auth === 'password' && !secret) throw new TypeError('password is required')
  if (profile.auth === 'agent' && secret) throw new TypeError('agent mode does not accept a secret')
  return secret
}

/** 已关闭的通道不能再排清理请求，否则 ssh2 会等待永远不会到达的回执。 */
function callSftp (sftp, method, ...args) {
  return new Promise((resolve, reject) => {
    if (sftp.readable === false || (sftp.outgoing && sftp.outgoing.state !== 'open')) {
      return reject(new Error('SFTP connection closed'))
    }
    sftp[method](...args, (error, result) => error ? reject(error) : resolve(result))
  })
}

function remoteTimestamp (seconds) {
  if (!Number.isFinite(seconds)) return null
  const date = new Date(seconds * 1000)
  return Number.isNaN(date.valueOf()) ? null : date.toISOString()
}

function isMissingRemotePath (error) {
  return error?.code === 2 || error?.code === 'ENOENT'
}

/** 发布前始终拒绝已存在的目标；文件和目录使用相同的非覆盖约束。 */
async function requireMissingRemotePath (sftp, destinationPath) {
  try {
    await callSftp(sftp, 'lstat', destinationPath)
    throw new Error('目标已有同名项目，请先重命名后再传输')
  } catch (error) {
    if (!isMissingRemotePath(error)) throw error
  }
}

/** 流式写入独占临时文件，传完再发布；取消只销毁传输流，不关闭 SFTP 会话。 */
async function writeRemoteFile (sftp, destinationPath, createSource, onProgress = () => {}, signal) {
  signal?.throwIfAborted()
  await requireMissingRemotePath(sftp, destinationPath)
  signal?.throwIfAborted()
  const temporaryPath = path.posix.join(path.posix.dirname(destinationPath), `.serverlink-${randomUUID()}.part`)
  const destination = sftp.createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 })
  let created = false
  destination.once('open', () => { created = true })
  // ssh2 的 bytesWritten 只在远端 WRITE 回执成功后增长；定时采样避免把读取缓存算成已上传。
  const report = () => onProgress(destination.bytesWritten || 0, 'uploading')
  const timer = setInterval(report, 100)
  timer.unref?.()
  try {
    // pipeline 自动施加背压，大文件不会整体载入内存或留存在本地磁盘。
    await pipeline(createSource(), destination, ...(signal ? [{ signal }] : []))
    clearInterval(timer)
    onProgress(destination.bytesWritten || 0, 'finalizing')
    signal?.throwIfAborted()
    // 使用 SFTP 标准 rename（非覆盖扩展），保留传输期间新出现的同名文件。
    await callSftp(sftp, 'rename', temporaryPath, destinationPath)
  } catch (error) {
    if (created) await callSftp(sftp, 'unlink', temporaryPath).catch(() => {})
    throw error
  } finally {
    clearInterval(timer)
  }
}

/** 目录先写入本次独占暂存区，再整体发布；清理仅涉及已确认创建的路径。 */
async function writeRemoteDirectory (sftp, destinationPath, source, uploadFile, signal) {
  signal.throwIfAborted()
  await requireMissingRemotePath(sftp, destinationPath)
  signal.throwIfAborted()
  const temporaryPath = path.posix.join(path.posix.dirname(destinationPath), `.serverlink-${randomUUID()}.part`)
  const created = []
  try {
    await callSftp(sftp, 'mkdir', temporaryPath, { mode: 0o700 })
    created.push({ path: temporaryPath, type: 'directory' })
    for (const entry of source.entries.slice(1)) {
      signal.throwIfAborted()
      const remotePath = validateRemotePath(path.posix.join(temporaryPath, entry.relativePath))
      if (entry.type === 'directory') await callSftp(sftp, 'mkdir', remotePath, { mode: 0o700 })
      else await uploadFile(entry, remotePath)
      created.push({ path: remotePath, type: entry.type })
    }
    signal.throwIfAborted()
    // 标准 rename 不替换目标；传输中出现的同名目录也不会被合并或删除。
    await callSftp(sftp, 'rename', temporaryPath, destinationPath)
  } catch (error) {
    // 不递归扫描或删除远端目录；即使清理失败，也绝不扩大到用户已有项目。
    for (const entry of created.reverse()) {
      await callSftp(sftp, entry.type === 'directory' ? 'rmdir' : 'unlink', entry.path).catch(() => {})
    }
    throw error
  }
}

/**
 * Owns SSH2/SFTP clients and limits every operation to the renderer that
 * created the connection. Local paths originate from native dialogs or genuine dropped Files.
 */
class SftpManager {
  constructor ({ knownHostsPath, confirmHost, environment = process.env, createClient = () => new Client() }) {
    if (typeof knownHostsPath !== 'string' || !path.isAbsolute(knownHostsPath)) {
      throw new TypeError('known hosts path must be absolute')
    }
    if (typeof confirmHost !== 'function') throw new TypeError('confirmHost must be a function')
    this.knownHostsPath = path.normalize(knownHostsPath)
    this.confirmHost = confirmHost
    this.environment = environment
    this.createClient = createClient
    this.connections = new Map()
    this.pendingConnections = new Set()
    this.shuttingDown = false
  }

  /** 临时网络失败最多重试两次；凭据只保留在本次调用中，窗口关闭会取消退避和连接。 */
  async connect (ownerId, storedProfile, secret = '') {
    validateOwnerId(ownerId)
    if (this.shuttingDown) throw new Error('SFTP manager is shutting down')
    const operation = { ownerId, profileId: storedProfile.id, controller: new AbortController() }
    this.pendingConnections.add(operation)
    const { signal } = operation.controller
    try {
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted()
        try {
          return await this.connectOnce(ownerId, storedProfile, secret, signal)
        } catch (error) {
          if (signal.aborted || attempt >= 2 || !isTransientConnectionError(error)) throw error
          // 失败连接已释放，退避 1/2 秒后才建立下一条，避免拥塞时立即打满服务器。
          await delay(1000 * (attempt + 1), undefined, { signal })
        }
      }
    } finally {
      secret = ''
      this.pendingConnections.delete(operation)
    }
  }

  /** 单次握手严格验证主机；仅检测到加密私钥时返回口令需求，不把密钥传给界面。 */
  async connectOnce (ownerId, storedProfile, secret, signal) {
    const profile = normalizeProfileInput({
      name: storedProfile.name,
      host: storedProfile.host,
      port: storedProfile.port,
      username: storedProfile.username,
      auth: storedProfile.auth,
      privateKeyPath: storedProfile.privateKeyPath
    })
    validateSecret(profile, secret)

    const connectionId = randomUUID()
    const client = this.createClient()
    const record = { id: connectionId, ownerId, client, sftp: null, closing: false, verifierError: null }
    const abort = () => this.closeRecord(record)
    signal.addEventListener('abort', abort, { once: true })
    let keyboardHandler = null
    this.connections.set(connectionId, record)

    const options = {
      host: profile.host,
      port: profile.port,
      username: profile.username,
      readyTimeout: 15000,
      keepaliveInterval: 30000,
      keepaliveCountMax: 3,
      agentForward: false,
      hostVerifier: (hostKey, verify) => {
        // Host verification stays asynchronous so the native confirmation can
        // finish without ever accepting an unknown or changed key by default.
        this.verifyHost(ownerId, profile, hostKey).then(verify, error => {
          record.verifierError = error
          verify(false)
        })
      }
    }
    const clearCredentialReferences = () => {
      options.password = undefined
      options.passphrase = undefined
      if (client.config) client.config.password = undefined
      if (keyboardHandler) client.removeListener('keyboard-interactive', keyboardHandler)
      secret = ''
    }

    try {
      if (profile.auth === 'password') {
        options.password = secret
        options.tryKeyboard = true
        keyboardHandler = (_name, _instructions, _language, prompts, finish) => {
          // Some sshd configurations expose password login through
          // keyboard-interactive only; answer every password prompt ephemerally.
          finish(prompts.map(() => secret))
        }
        client.on('keyboard-interactive', keyboardHandler)
      } else if (profile.auth === 'key') {
        const keyPath = validateLocalPath(profile.privateKeyPath)
        const stat = await fs.lstat(keyPath)
        if (!stat.isFile() || stat.size > MAX_KEY_SIZE) throw new Error('private key file is invalid or too large')
        // Read the configured key only inside the privileged process; its bytes
        // never cross IPC or enter persistence, logs, argv, or environment state.
        options.privateKey = await fs.readFile(keyPath)
        const parsedKey = utils.parseKey(options.privateKey, secret || undefined)
        if (parsedKey instanceof Error) {
          if (!secret && /encrypted.*no passphrase given/iu.test(parsedKey.message)) {
            this.closeRecord(record)
            return { needsSecret: true }
          }
          throw parsedKey
        }
        if (secret) options.passphrase = secret
      } else {
        const socketPath = this.environment.SSH_AUTH_SOCK
        if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath) || containsControlCharacter(socketPath)) {
          throw new Error('SSH agent is unavailable; choose a private key instead')
        }
        options.agent = socketPath
      }
      signal.throwIfAborted()
      if (!this.connections.has(connectionId)) throw new Error('SFTP connection was closed by user')

      await new Promise((resolve, reject) => {
        let settled = false
        const settle = (callback, value) => {
          if (settled) return
          settled = true
          callback(value)
        }
        record.cancelConnect = () => settle(reject, new Error('SFTP connection was closed by user'))
        client.once('ready', () => {
          record.authenticated = true
          // Authentication has finished; drop the password references before
          // opening the long-lived file channel so they do not remain for the session.
          clearCredentialReferences()
          if (!this.connections.has(connectionId)) return settle(reject, new Error('SFTP connection was closed'))
          client.sftp((error, sftp) => {
            if (error) return settle(reject, error)
            // 用户取消后仍可能收到已完成的通道回调；释放迟到资源，不能恢复已关闭的会话。
            if (record.closing || !this.connections.has(connectionId)) {
              try { sftp.end() } catch {}
              return settle(reject, new Error('SFTP connection was closed by user'))
            }
            record.sftp = sftp
            settle(resolve)
          })
        })
        client.once('error', error => settle(reject, record.verifierError ?? error))
        client.once('close', () => {
          // 意外断线也要撤销扫描、排队项和跨服流，不能在失去归属后继续传输。
          record.upload?.controller.abort()
          for (const controller of record.copies || []) controller.abort()
          this.connections.delete(connectionId)
          settle(reject, record.verifierError ?? new Error('SFTP connection closed'))
        })
        // The client consumes the secret only for this handshake; ServerLink
        // does not retain the options object on the connection record.
        client.connect(options)
      })

      const homePath = validateRemotePath(await callSftp(record.sftp, 'realpath', '.'))
      return { connectionId, ...(await this.list(ownerId, connectionId, homePath)) }
    } catch (error) {
      clearCredentialReferences()
      this.closeRecord(record)
      // 认证后打开通道或读目录失败交给用户处理，不再自动重建已认证连接。
      if (record.authenticated || record.verifierError) error.retryable = false
      throw record.verifierError ?? error
    } finally {
      clearCredentialReferences()
      signal.removeEventListener('abort', abort)
      record.cancelConnect = null
    }
  }

  /** Enforces TOFU for unknown keys while changed or revoked keys fail closed. */
  async verifyHost (ownerId, profile, hostKey) {
    const result = await checkKnownHost({
      knownHostsPath: this.knownHostsPath,
      host: profile.host,
      port: profile.port,
      hostKey
    })
    if (result.status === 'match') return true
    if (result.status === 'mismatch' || result.status === 'revoked') {
      throw new Error(`SSH host key verification failed: ${result.fingerprint} does not match the saved key`)
    }

    const accepted = await this.confirmHost(ownerId, {
      host: profile.host,
      port: profile.port,
      keyType: result.keyType,
      fingerprint: result.fingerprint
    })
    if (!accepted) throw new Error('SSH host key was not trusted')
    // Persist trust before authentication continues so every later connection
    // must verify against the same app-owned record.
    await trustKnownHost({
      knownHostsPath: this.knownHostsPath,
      host: profile.host,
      port: profile.port,
      hostKey
    })
    return true
  }

  /** Lists one owned absolute remote directory with a bounded result size. */
  async list (ownerId, connectionId, remotePath) {
    const record = this.requireOwned(ownerId, connectionId)
    const normalizedPath = validateRemotePath(remotePath)
    const entries = await callSftp(record.sftp, 'readdir', normalizedPath)
    if (!Array.isArray(entries) || entries.length > MAX_DIRECTORY_ENTRIES) {
      throw new Error('remote directory is too large')
    }
    const normalizedEntries = entries
      .filter(entry => entry && entry.filename !== '.' && entry.filename !== '..')
      .map(entry => ({
        // Reject server-supplied separators or traversal names before the UI
        // can compose them into a different absolute operation target.
        name: validateRemoteName(String(entry.filename)),
        type: entry.attrs?.isDirectory?.()
          ? 'directory'
          : entry.attrs?.isSymbolicLink?.() ? 'symlink' : 'file',
        size: Number.isSafeInteger(entry.attrs?.size) && entry.attrs.size >= 0 ? entry.attrs.size : null,
        modifiedAt: remoteTimestamp(entry.attrs?.mtime)
      }))
      .sort((left, right) => (
        Number(right.type === 'directory') - Number(left.type === 'directory') ||
        left.name.localeCompare(right.name)
      ))
    return { path: normalizedPath, entries: normalizedEntries }
  }

  /** 保留单项上传的返回/抛错契约；目录、取消和进度与多选使用同一实现。 */
  async upload (ownerId, connectionId, remoteDirectory, localPath, onProgress = () => {}) {
    const [result] = await this.uploadBatch(ownerId, connectionId, remoteDirectory, [localPath], onProgress)
    if (!result.success) throw Object.assign(new Error(result.error), { code: result.canceled ? 'ABORT_ERR' : undefined })
    return { name: result.name, path: result.path }
  }

  /** 每连接只允许一个批次；扫描、当前文件及尚未启动的项目共用可取消生命周期。 */
  async uploadBatch (ownerId, connectionId, remoteDirectory, localPaths, onProgress = () => {}) {
    const record = this.requireOwned(ownerId, connectionId)
    const destination = validateRemotePath(remoteDirectory)
    if (!Array.isArray(localPaths) || !localPaths.length || localPaths.length > 100) throw new Error('请选择 1～100 个文件或文件夹')
    const paths = localPaths.map(validateLocalPath)
    if (record.upload) throw new Error('当前服务器已有上传任务，请等待或先停止上传')
    const operation = { controller: new AbortController() }
    // 首个 await 前登记，防止并发 IPC 重入或准备期间的取消请求漏掉任务。
    record.upload = operation
    const { signal } = operation.controller
    const transferId = randomUUID()
    const startedAt = Date.now()
    const results = []
    let total = 0
    let transferred = 0
    let fileIndex = 0
    let fileCount = 0
    let name = path.basename(paths[0])
    const report = phase => {
      onProgress({ connectionId, transferId, name, total, transferred, phase, fileIndex, fileCount, bytesPerSecond: transferred * 1000 / Math.max(1, Date.now() - startedAt) })
    }
    try {
      // 在任何目录读取前通知 UI，文件夹扫描也可立即终止。
      report('preparing')
      const sources = await scanUploadSources(paths, signal)
      total = sources.reduce((sum, source) => sum + source.size, 0)
      if (!Number.isSafeInteger(total)) throw new Error('文件总大小超出支持范围')
      fileCount = sources.reduce((sum, source) => sum + source.entries.filter(entry => entry.type === 'file').length, 0)
      for (const source of sources) {
        signal.throwIfAborted()
        name = source.name
        try {
          if (source.error) throw source.error
          const remotePath = validateRemotePath(path.posix.join(destination, validateRemoteName(source.name)))
          const uploadFile = async (entry, targetPath) => {
            fileIndex++
            name = path.posix.join(source.name, entry.relativePath)
            const completedBytes = transferred
            const handle = await openUploadSource(entry, signal)
            try {
              report('uploading')
              // 基于已验证的句柄读取，不能再次按路径打开而重新引入链接替换窗口。
              await writeRemoteFile(record.sftp, targetPath, () => handle.createReadStream({ autoClose: false }), (bytes, phase) => {
                transferred = Math.max(transferred, completedBytes + Math.min(entry.stat.size, bytes))
                report(phase)
              }, signal)
              transferred = completedBytes + entry.stat.size
            } finally {
              await handle.close()
            }
          }
          if (source.type === 'directory') await writeRemoteDirectory(record.sftp, remotePath, source, uploadFile, signal)
          else await uploadFile(source.entries[0], remotePath)
          results.push({ name: source.name, path: remotePath, success: true })
        } catch (error) {
          if (signal.aborted) throw error
          results.push({ name: source.name, success: false, error: error.message })
        }
      }
      report(results.every(result => result.success) ? 'completed' : 'failed')
    } catch (error) {
      for (const sourcePath of paths.slice(results.length)) {
        results.push({ name: path.basename(sourcePath), success: false, error: signal.aborted ? '上传已取消' : error.message, ...(signal.aborted ? { canceled: true } : {}) })
      }
      report(signal.aborted ? 'canceled' : 'failed')
    } finally {
      if (record.upload === operation) record.upload = null
    }
    return results
  }

  /** 仅终止该窗口此连接的上传，不断开文件浏览会话或影响其他服务器。 */
  cancelUpload (ownerId, connectionId) {
    const record = this.requireOwned(ownerId, connectionId)
    if (!record.upload || record.upload.controller.signal.aborted) return false
    record.upload.controller.abort()
    return true
  }

  /** 校验两端归属后流式复制普通文件；任一端关闭都中止本次复制，但不关闭另一端。 */
  async copyBetween (ownerId, sourceId, sourcePath, destinationId, destinationDirectory) {
    const source = this.requireOwned(ownerId, sourceId)
    const destination = this.requireOwned(ownerId, destinationId)
    const remoteSource = validateRemotePath(sourcePath)
    const remoteDestination = path.posix.join(validateRemotePath(destinationDirectory), validateRemoteName(path.posix.basename(remoteSource)))
    const controller = new AbortController()
    // 两端共同拥有本次流；任一标签关闭都先销毁读写流，另一端会话仍可继续浏览。
    for (const record of [source, destination]) (record.copies ||= new Set()).add(controller)
    try {
      const attrs = await callSftp(source.sftp, 'lstat', remoteSource)
      if (!attrs.isFile()) throw new Error('跨服务器复制目前支持普通文件，请将目录打包后传输')
      await writeRemoteFile(destination.sftp, remoteDestination, () => source.sftp.createReadStream(remoteSource), undefined, controller.signal)
      return { name: path.posix.basename(remoteSource), path: remoteDestination }
    } finally {
      for (const record of [source, destination]) record.copies.delete(controller)
    }
  }

  /** Downloads one validated remote file to the path selected by the main process. */
  async download (ownerId, connectionId, remotePath, localPath) {
    const record = this.requireOwned(ownerId, connectionId)
    const sourcePath = validateRemotePath(remotePath)
    const destinationPath = validateLocalPath(localPath)
    const temporaryPath = `${destinationPath}.serverlink-${randomUUID()}.part`
    try {
      await callSftp(record.sftp, 'fastGet', sourcePath, temporaryPath)
      // Replace the chosen destination only after a complete transfer, so a
      // network failure cannot truncate a file the user elected to overwrite.
      await fs.rename(temporaryPath, destinationPath)
    } catch (error) {
      await fs.unlink(temporaryPath).catch(() => {})
      throw error
    }
    return { path: sourcePath }
  }

  /** Creates one direct child directory without accepting path separators in its name. */
  async mkdir (ownerId, connectionId, parentPath, name) {
    const record = this.requireOwned(ownerId, connectionId)
    const remotePath = path.posix.join(validateRemotePath(parentPath), validateRemoteName(name))
    await callSftp(record.sftp, 'mkdir', remotePath)
    return { path: remotePath }
  }

  /** Removes a file/symlink or an empty directory after main-process confirmation. */
  async remove (ownerId, connectionId, remotePath) {
    const record = this.requireOwned(ownerId, connectionId)
    const normalizedPath = validateRemotePath(remotePath)
    if (normalizedPath === '/') throw new Error('remote root cannot be removed')
    const attrs = await callSftp(record.sftp, 'lstat', normalizedPath)
    await callSftp(record.sftp, attrs.isDirectory() ? 'rmdir' : 'unlink', normalizedPath)
    return true
  }

  /** Confirms ownership before a main-process file or confirmation dialog is shown. */
  assertOwned (ownerId, connectionId) {
    this.requireOwned(ownerId, connectionId)
    return true
  }

  /** Closes one SFTP client owned by the requesting renderer. */
  close (ownerId, connectionId) {
    const record = this.requireOwned(ownerId, connectionId)
    this.closeRecord(record)
    return true
  }

  /** 只取消当前窗口指定配置的未完成握手；不会关闭该配置已成功建立的会话。 */
  cancelConnect (ownerId, profileId) {
    validateOwnerId(ownerId)
    if (typeof profileId !== 'string') throw new TypeError('profile id is invalid')
    for (const operation of this.pendingConnections) {
      if (operation.ownerId === ownerId && operation.profileId === profileId) operation.controller.abort()
    }
  }

  /** Closes every SFTP client whose renderer has gone away. */
  closeOwner (ownerId) {
    validateOwnerId(ownerId)
    for (const operation of this.pendingConnections) {
      if (operation.ownerId === ownerId) operation.controller.abort()
    }
    for (const record of this.connections.values()) {
      if (record.ownerId === ownerId) this.closeRecord(record)
    }
  }

  /** Rejects future connections and closes all clients during application shutdown. */
  closeAll () {
    this.shuttingDown = true
    for (const operation of this.pendingConnections) operation.controller.abort()
    for (const record of [...this.connections.values()]) this.closeRecord(record)
  }

  /** Returns an initialized record only when the invoking renderer owns it. */
  requireOwned (ownerId, connectionId) {
    validateOwnerId(ownerId)
    validateConnectionId(connectionId)
    const record = this.connections.get(connectionId)
    if (!record || record.ownerId !== ownerId || !record.sftp) throw new Error('SFTP connection not found')
    return record
  }

  /** 撤销上传和归属后立即切断 socket；强关不等待传完或远端暂存清理回执。 */
  closeRecord (record) {
    if (record.closing) return
    record.closing = true
    record.upload?.controller.abort()
    for (const controller of record.copies || []) controller.abort()
    record.cancelConnect?.()
    this.connections.delete(record.id)
    try { record.sftp?.end?.() } catch {}
    // end() 会等待 socket 写缓冲排空；关闭标签要求立即断开，兼容桩才回退到 end()。
    try {
      if (typeof record.client.destroy === 'function') record.client.destroy()
      else record.client.end()
    } catch {}
  }
}

module.exports = {
  MAX_DIRECTORY_ENTRIES,
  SftpManager,
  validateRemoteName,
  validateRemotePath
}
