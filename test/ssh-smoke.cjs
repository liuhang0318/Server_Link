'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const callbackFs = require('node:fs')
const { once } = require('node:events')
const { Server, utils } = require('@electerm/ssh2')
// An extracted app.asar can be supplied to verify the delivered code and native
// dependencies instead of accidentally exercising only the source checkout.
const sourceRoot = process.env.SERVERLINK_SMOKE_SOURCE || path.resolve(__dirname, '..')
const { ProfileStore } = require(path.join(sourceRoot, 'lib/profile-store.cjs'))
const { SessionManager } = require(path.join(sourceRoot, 'lib/session-manager.cjs'))
const { SftpManager } = require(path.join(sourceRoot, 'lib/sftp-manager.cjs'))
const { trustKnownHost } = require(path.join(sourceRoot, 'lib/known-hosts.cjs'))

/** Serves a tiny SFTP filesystem confined to the disposable smoke directory. */
function attachSftp (sftp, rootDirectory, controls = {}) {
  const { STATUS_CODE } = utils.sftp
  const openFiles = new Map()
  const openDirectories = new Map()
  let handleCount = 0

  const localPath = remotePath => {
    const normalized = path.posix.normalize(`/${remotePath || '/'}`)
    return path.join(rootDirectory, normalized)
  }
  const attributes = stat => ({
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
    size: stat.size,
    atime: Math.floor(stat.atimeMs / 1000),
    mtime: Math.floor(stat.mtimeMs / 1000)
  })
  const fail = (requestId, error) => {
    const status = error?.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE
    sftp.status(requestId, status)
  }

  sftp.on('REALPATH', (requestId, remotePath) => {
    const normalized = path.posix.normalize(`/${remotePath || '/'}`)
    sftp.name(requestId, [{ filename: normalized, longname: normalized, attrs: {} }])
  })
  for (const eventName of ['STAT', 'LSTAT']) {
    sftp.on(eventName, (requestId, remotePath) => {
      const operation = eventName === 'STAT' ? callbackFs.stat : callbackFs.lstat
      operation(localPath(remotePath), (error, stat) => {
        if (error) return fail(requestId, error)
        sftp.attrs(requestId, attributes(stat))
      })
    })
  }
  sftp.on('OPENDIR', (requestId, remotePath) => {
    callbackFs.readdir(localPath(remotePath), { withFileTypes: true }, (error, entries) => {
      if (error) return fail(requestId, error)
      const handle = Buffer.from(`directory-${++handleCount}`)
      openDirectories.set(handle.toString(), {
        localPath: localPath(remotePath),
        entries,
        sent: false
      })
      sftp.handle(requestId, handle)
    })
  })
  sftp.on('READDIR', (requestId, handle) => {
    const directory = openDirectories.get(handle.toString())
    if (!directory) return sftp.status(requestId, STATUS_CODE.FAILURE)
    if (directory.sent) return sftp.status(requestId, STATUS_CODE.EOF)
    directory.sent = true
    Promise.all(directory.entries.map(entry => new Promise(resolve => {
      callbackFs.lstat(path.join(directory.localPath, entry.name), (error, stat) => {
        resolve({
          filename: entry.name,
          longname: entry.name,
          attrs: error ? {} : attributes(stat)
        })
      })
    }))).then(entries => sftp.name(requestId, entries))
  })
  sftp.on('OPEN', (requestId, remotePath, flags) => {
    // 延迟 OPEN 回执专门覆盖取消发生在远端临时文件尚未打开的窗口。
    controls.beforeOpen?.()
    setTimeout(() => {
      callbackFs.open(localPath(remotePath), utils.sftp.flagsToString(flags), (error, descriptor) => {
        if (error) return fail(requestId, error)
        const handle = Buffer.from(`file-${++handleCount}`)
        openFiles.set(handle.toString(), descriptor)
        sftp.handle(requestId, handle)
      })
    }, controls.openDelay || 0)
  })
  sftp.on('READ', (requestId, handle, offset, length) => {
    const descriptor = openFiles.get(handle.toString())
    if (descriptor === undefined) return sftp.status(requestId, STATUS_CODE.FAILURE)
    const buffer = Buffer.alloc(length)
    callbackFs.read(descriptor, buffer, 0, length, offset, (error, bytesRead) => {
      if (error) return fail(requestId, error)
      if (bytesRead === 0) return sftp.status(requestId, STATUS_CODE.EOF)
      sftp.data(requestId, buffer.subarray(0, bytesRead))
    })
  })
  sftp.on('WRITE', (requestId, handle, offset, data) => {
    const descriptor = openFiles.get(handle.toString())
    if (descriptor === undefined) return sftp.status(requestId, STATUS_CODE.FAILURE)
    callbackFs.write(descriptor, data, 0, data.length, offset, error => {
      if (error) return fail(requestId, error)
      setTimeout(() => sftp.status(requestId, STATUS_CODE.OK), controls.writeDelay || 0)
    })
  })
  sftp.on('FSETSTAT', (requestId, handle, attrs) => {
    callbackFs.fchmod(openFiles.get(handle.toString()), attrs.mode, error => error ? fail(requestId, error) : sftp.status(requestId, STATUS_CODE.OK))
  })
  sftp.on('RENAME', (requestId, from, to) => {
    // 文件用 link 模拟独占发布；目录仅在隔离 fixture 中检查目标缺失后 rename。
    fs.lstat(localPath(from)).then(async stat => {
      if (stat.isDirectory()) {
        await assert.rejects(fs.lstat(localPath(to)), { code: 'ENOENT' })
        await fs.rename(localPath(from), localPath(to))
      } else {
        await fs.link(localPath(from), localPath(to))
        await fs.unlink(localPath(from))
      }
      sftp.status(requestId, STATUS_CODE.OK)
    }).catch(error => fail(requestId, error))
  })
  sftp.on('CLOSE', (requestId, handle) => {
    const key = handle.toString()
    const descriptor = openFiles.get(key)
    openFiles.delete(key)
    openDirectories.delete(key)
    if (descriptor === undefined) return sftp.status(requestId, STATUS_CODE.OK)
    callbackFs.close(descriptor, error => error ? fail(requestId, error) : sftp.status(requestId, STATUS_CODE.OK))
  })
  const pathOperation = (eventName, operation) => {
    sftp.on(eventName, (requestId, remotePath) => {
      operation(localPath(remotePath), error => error ? fail(requestId, error) : sftp.status(requestId, STATUS_CODE.OK))
    })
  }
  pathOperation('REMOVE', callbackFs.unlink)
  pathOperation('MKDIR', callbackFs.mkdir)
  pathOperation('RMDIR', callbackFs.rmdir)
}

// This integration check uses the project's own SSH2 dependency as a test
// server. Only loopback and disposable credentials are used; this test is not bundled.
async function main () {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'serverlink-ssh-smoke-'))
  const hostKey = utils.generateKeyPairSync('ed25519')
  const clientKey = utils.generateKeyPairSync('ed25519')
  const parsedClientKey = utils.parseKey(clientKey.public)
  const clients = new Set()
  const password = 'local-smoke-password'
  const sftpRoot = path.join(directory, 'remote')
  const secondRoot = path.join(directory, 'remote-second')
  const secondHostKey = utils.generateKeyPairSync('ed25519')
  const secondServer = new Server({ hostKeys: [secondHostKey.private] }, client => {
    clients.add(client)
    client.on('close', () => clients.delete(client))
    client.on('error', () => {})
    client.on('authentication', context => {
      if (context.method === 'password' && context.username === 'smoketest' && context.password === password) context.accept()
      else context.reject(['password'])
    })
    client.on('ready', () => client.on('session', accept => {
      accept().on('sftp', accept => attachSftp(accept(), secondRoot))
    }))
  })
  let resizeReceived = false
  let shellEchoDelay = 0
  const transferControls = {}
  const server = new Server({ hostKeys: [hostKey.private] }, client => {
    clients.add(client)
    client.on('close', () => clients.delete(client))
    client.on('error', () => {})
    client.on('authentication', context => {
      if (context.username !== 'smoketest') return context.reject()
      if (context.method === 'password' && context.password === password) return context.accept()
      if (context.method === 'publickey' && parsedClientKey.getPublicSSH().equals(context.key.data)) {
        if (!context.signature || parsedClientKey.verify(context.blob, context.signature, context.hashAlgo) === true) {
          return context.accept()
        }
      }
      context.reject(['publickey', 'password'])
    })
    client.on('ready', () => {
      client.on('session', accept => {
        const session = accept()
        session.on('pty', accept => accept())
        session.on('window-change', (accept, _reject, info) => {
          resizeReceived = info.cols === 91 && info.rows === 31
          if (accept) accept()
        })
        session.on('shell', accept => {
          const shell = accept()
          let input = ''
          shell.write('SERVERLINK_READY 中文\r\n')
          shell.on('data', data => {
            input += data.toString()
            // 测试 shell 不执行任何命令；按行回显探针，允许 SSH 任意拆分输入包。
            let end
            while ((end = input.search(/[\r\n]/u)) !== -1) {
              const line = input.slice(0, end)
              input = input.slice(end + 1)
              if (line === 'ping') shell.write('SERVERLINK_PONG\r\n')
              if (/^SERVERLINK_ECHO_\d+$/u.test(line)) {
                setTimeout(() => shell.write(`${line}\r\n`), shellEchoDelay)
              }
            }
          })
        })
        session.on('sftp', accept => attachSftp(accept(), sftpRoot, transferControls))
      })
    })
  })
  const manager = new SessionManager({ knownHostsPath: path.join(directory, 'known hosts') })
  const sftpManager = new SftpManager({
    knownHostsPath: path.join(directory, 'known hosts'),
    confirmHost: async () => {
      throw new Error('OpenSSH-established host trust should have been reused')
    }
  })
  try {
    // A real TCP SSH handshake plus native PTY covers the boundaries the unit
    // stubs cannot: host trust prompt, key/password auth, data, resize and exit.
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    await manager.init()
    await fs.mkdir(sftpRoot)
    await fs.mkdir(secondRoot)
    await fs.writeFile(path.join(secondRoot, 'welcome.txt'), 'SECOND_SERVER\n')
    secondServer.listen(0, '127.0.0.1')
    await once(secondServer, 'listening')
    // 第二台回环服务器使用独立指纹，只写入本测试的临时 known_hosts。
    await trustKnownHost({ knownHostsPath: sftpManager.knownHostsPath, host: '127.0.0.1', port: secondServer.address().port, hostKey: utils.parseKey(secondHostKey.public).getPublicSSH() })
    await fs.writeFile(path.join(sftpRoot, 'welcome.txt'), 'SFTP_READY 中文\n')
    const keyPath = path.join(directory, 'private key')
    await fs.writeFile(keyPath, clientKey.private, { mode: 0o600 })
    const store = new ProfileStore(path.join(directory, 'profiles'))
    const base = { name: 'Loopback smoke', host: '127.0.0.1', port: server.address().port, username: 'smoketest' }

    async function connect (auth, expectTrust, measureLatency = false) {
      const created = await store.create({ ...base, auth, privateKeyPath: auth === 'key' ? keyPath : null })
      const profile = await new ProfileStore(store.directoryPath).get(created.id)
      let output = ''
      let trustPrompts = 0
      let passwordSent = false
      let connected = false
      let pingSent = false
      let echoProbe = null
      let probeSequence = 0
      let resolveData
      let resolveExit
      const dataReady = new Promise(resolve => { resolveData = resolve })
      const exited = new Promise(resolve => { resolveExit = resolve })
      const session = manager.start(1, profile, event => {
        if (event.type === 'exit') return resolveExit(event)
        if (event.type === 'progress') {
          assert.equal(event.logs.includes(password), false)
          if (event.phase === 'connected') connected = true
          if (connected && output.includes('SERVERLINK_PONG')) resolveData()
          return
        }
        if (event.type !== 'data') return
        output += event.data
        if (echoProbe && output.includes(echoProbe.token)) {
          const probe = echoProbe
          echoProbe = null
          clearTimeout(probe.timeout)
          probe.resolve(performance.now() - probe.started)
        }
        if (!trustPrompts && output.includes('Are you sure you want to continue connecting')) {
          trustPrompts++
          manager.write(1, session.sessionId, 'yes\r')
        }
        if (!passwordSent && output.includes('password:')) {
          passwordSent = true
          manager.write(1, session.sessionId, `${password}\r`)
        }
        if (!pingSent && output.includes('SERVERLINK_READY')) {
          pingSent = true
          manager.resize(1, session.sessionId, 91, 31)
          manager.write(1, session.sessionId, 'ping\r')
        }
        if (connected && output.includes('SERVERLINK_PONG')) resolveData()
      })
      const timeout = setTimeout(() => resolveData(new Error(`SSH ${auth} smoke timed out: ${output}`)), 10000)
      try {
        const result = await Promise.race([
          dataReady,
          exited.then(event => new Error(`SSH exited before shell output: ${event.exitCode}; ${output}`))
        ])
        if (result instanceof Error) throw result
        assert.equal(trustPrompts, expectTrust ? 1 : 0)
        assert.equal(output.includes(password), false)
        assert.match(output, /中文/u)
        assert.equal(connected, true)
        await assert.rejects(fs.access(manager.sessions.get(session.sessionId).logDirectory), { code: 'ENOENT' })
        if (measureLatency) {
          // 此计时只覆盖 manager → 原生 PTY/OpenSSH → 回环 SSH 服务 → manager，
          // 不包含 Electron IPC 或 xterm 绘制，不能据此声称真实网络/界面同样快。
          const measureEcho = () => new Promise((resolve, reject) => {
            const token = `SERVERLINK_ECHO_${++probeSequence}`
            const probe = { token, started: performance.now(), resolve }
            probe.timeout = setTimeout(() => reject(new Error('SSH echo probe timed out')), 3000)
            echoProbe = probe
            manager.write(1, session.sessionId, `${token}\r`)
          })
          const samples = []
          for (let index = 0; index < 7; index++) samples.push(await measureEcho())
          samples.sort((left, right) => left - right)
          shellEchoDelay = 180
          const delayedEcho = measureEcho()
          await new Promise(resolve => setTimeout(resolve, 80))
          assert.notEqual(echoProbe, null, 'terminal output must wait for remote echo; never blindly echo input')
          const delayed = await delayedEcho
          shellEchoDelay = 0
          assert.ok(delayed >= 170, `injected 180 ms echo delay was not observed: ${delayed}`)
          console.log(`ssh-input-latency (native loopback, excluding renderer/IPC): p50=${samples[3].toFixed(1)} ms, max=${samples.at(-1).toFixed(1)} ms; injected remote echo 180 ms=${delayed.toFixed(1)} ms`)
        }
        manager.close(1, session.sessionId)
        await exited
        assert.equal(manager.sessions.size, 0)
        console.log(`${auth}: host trust, authentication, terminal input/output, close passed`)
      } finally {
        clearTimeout(timeout)
        if (echoProbe) clearTimeout(echoProbe.timeout)
        shellEchoDelay = 0
      }
    }

    await connect('key', true)
    await connect('password', false)
    await connect('key', false, true)
    assert.equal(resizeReceived, true)

    async function connectSftp (auth, port = server.address().port) {
      const created = await store.create({ ...base, port, auth, privateKeyPath: auth === 'key' ? keyPath : null })
      const profile = await new ProfileStore(store.directoryPath).get(created.id)
      const result = await sftpManager.connect(2, profile, auth === 'password' ? password : '')
      assert.equal(result.path, '/')
      assert.ok(result.entries.some(entry => entry.name === 'welcome.txt'))
      return result.connectionId
    }

    // 两台真实本机服务并发握手，覆盖多连接下认证和归属隔离。
    const [sftpConnectionId, destinationId] = await Promise.all([
      connectSftp('password'),
      connectSftp('password', secondServer.address().port)
    ])
    const uploadSource = path.join(directory, 'upload-source.txt')
    const downloadTarget = path.join(directory, 'download-target.txt')
    // 多块数据覆盖流式背压和非 ASCII 字节完整性，避免只验证一个小数据包。
    const transferBody = 'UPLOAD_DOWNLOAD_OK 中文\n'.repeat(32768)
    await fs.writeFile(uploadSource, transferBody)
    const uploadProgress = []
    await sftpManager.upload(2, sftpConnectionId, '/', uploadSource, event => uploadProgress.push(event))
    assert.equal(uploadProgress.at(-1).phase, 'completed')
    assert.equal(uploadProgress.at(-1).transferred, Buffer.byteLength(transferBody))
    assert.equal(uploadProgress.find(event => event.phase === 'finalizing').transferred, Buffer.byteLength(transferBody))
    await sftpManager.download(2, sftpConnectionId, '/upload-source.txt', downloadTarget)
    assert.equal(await fs.readFile(downloadTarget, 'utf8'), transferBody)
    assert.equal(sftpManager.connections.size, 2)
    await sftpManager.copyBetween(2, sftpConnectionId, '/upload-source.txt', destinationId, '/')
    assert.equal(await fs.readFile(path.join(secondRoot, 'upload-source.txt'), 'utf8'), transferBody)
    await assert.rejects(sftpManager.copyBetween(2, sftpConnectionId, '/upload-source.txt', destinationId, '/'), /同名/u)
    await assert.rejects(sftpManager.upload(2, sftpConnectionId, '/', uploadSource), /同名/u)
    const folderSource = path.join(directory, 'folder-source')
    await fs.mkdir(path.join(folderSource, 'nested', 'empty'), { recursive: true })
    await fs.writeFile(path.join(folderSource, 'nested', 'content.txt'), 'FOLDER_OK 中文')
    const [folderResult] = await sftpManager.uploadBatch(2, sftpConnectionId, '/', [folderSource])
    assert.equal(folderResult.success, true)
    assert.equal(await fs.readFile(path.join(sftpRoot, 'folder-source', 'nested', 'content.txt'), 'utf8'), 'FOLDER_OK 中文')
    assert.equal((await fs.stat(path.join(sftpRoot, 'folder-source', 'nested', 'empty'))).isDirectory(), true)

    const canceledSource = path.join(directory, 'canceled.bin')
    const queuedSource = path.join(directory, 'queued.txt')
    await fs.writeFile(canceledSource, Buffer.alloc(4 * 1024 * 1024))
    await fs.writeFile(queuedSource, 'must not start')
    const canceledEvents = []
    transferControls.writeDelay = 8
    const canceledResults = await sftpManager.uploadBatch(2, sftpConnectionId, '/', [canceledSource, queuedSource], event => {
      canceledEvents.push(event)
      if (event.phase === 'uploading' && event.transferred > 0) sftpManager.cancelUpload(2, sftpConnectionId)
    })
    transferControls.writeDelay = 0
    assert.ok(canceledResults.every(result => result.canceled))
    assert.equal(canceledEvents.at(-1).phase, 'canceled')
    assert.ok(canceledEvents.some(event => event.transferred > 0))
    await assert.rejects(fs.lstat(path.join(sftpRoot, 'canceled.bin')), { code: 'ENOENT' })
    await assert.rejects(fs.lstat(path.join(sftpRoot, 'queued.txt')), { code: 'ENOENT' })

    // 中止发生在 OPEN 回执之前；退出必须等句柄关闭和暂存清理，不能漏 .part。
    const canceledFolder = path.join(directory, 'canceled-folder')
    await fs.mkdir(path.join(canceledFolder, 'nested', 'empty'), { recursive: true })
    await fs.writeFile(path.join(canceledFolder, 'nested', 'file.txt'), 'never published')
    transferControls.openDelay = 100
    transferControls.beforeOpen = () => {
      transferControls.beforeOpen = null
      sftpManager.cancelUpload(2, sftpConnectionId)
    }
    const [openCanceled] = await sftpManager.uploadBatch(2, sftpConnectionId, '/', [canceledFolder])
    transferControls.openDelay = 0
    assert.equal(openCanceled.canceled, true)
    await assert.rejects(fs.lstat(path.join(sftpRoot, 'canceled-folder')), { code: 'ENOENT' })
    assert.ok((await fs.readdir(sftpRoot)).every(name => !name.endsWith('.part')))
    assert.ok((await sftpManager.list(2, sftpConnectionId, '/')).entries.some(entry => entry.name === 'welcome.txt'))
    console.log('folder-upload: structure/empty folders, stream/queued/pre-OPEN cancellation, cleanup and connection reuse passed')
    await assert.rejects(sftpManager.copyBetween(3, sftpConnectionId, '/upload-source.txt', destinationId, '/'), /not found/u)
    assert.ok((await fs.readdir(secondRoot)).every(name => !name.endsWith('.part')))
    sftpManager.close(2, destinationId)
    assert.equal(sftpManager.connections.size, 1)
    console.log('multi-server: simultaneous connections, streamed copy, no overwrite and owner checks passed')
    await sftpManager.mkdir(2, sftpConnectionId, '/', 'empty-folder')
    let listing = await sftpManager.list(2, sftpConnectionId, '/')
    assert.ok(listing.entries.some(entry => entry.name === 'empty-folder' && entry.type === 'directory'))
    await sftpManager.remove(2, sftpConnectionId, '/upload-source.txt')
    await sftpManager.remove(2, sftpConnectionId, '/empty-folder')
    listing = await sftpManager.list(2, sftpConnectionId, '/')
    assert.equal(listing.entries.some(entry => entry.name === 'upload-source.txt'), false)
    assert.equal(listing.entries.some(entry => entry.name === 'empty-folder'), false)
    sftpManager.close(2, sftpConnectionId)

    const keySftpConnectionId = await connectSftp('key')
    sftpManager.close(2, keySftpConnectionId)
    console.log('sftp: shared host trust, password/key auth, list/upload/download/mkdir/delete passed')
    assert.equal(await manager.closeAllAndWait(), true)
    console.log('reconnect and shutdown passed; no production host accessed')
  } finally {
    sftpManager.closeAll()
    await manager.closeAllAndWait(100)
    // Incoming ServerClient exposes end(), which sends SSH disconnect and lets
    // the wrapped net.Server drain every loopback connection before closing.
    for (const client of clients) client.end()
    // ssh2 wraps net.Server and does not expose its .listening property.
    // Always close the wrapper so a passed test cannot leave a loopback listener.
    if (server.address()) {
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
      })
    }
    assert.equal(server.address(), null)
    if (secondServer.address()) await new Promise(resolve => secondServer.close(resolve))
    // Only this generated temp directory holds the disposable keys and profiles.
    await fs.rm(directory, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
