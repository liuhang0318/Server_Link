import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { version } from '../package.json'
import '@xterm/xterm/css/xterm.css'
import './style.css'
import { moveTab } from './tab-order.mjs'
import { groupProfiles } from './profile-groups.mjs'

const api = window.serverLink
document.querySelector('#app-version').textContent = `SSH & SFTP · v${version}`
const elements = {
  profileList: document.querySelector('#profile-list'),
  addProfile: document.querySelector('#add-profile'),
  emptyAddProfile: document.querySelector('#empty-add-profile'),
  dialog: document.querySelector('#profile-dialog'),
  form: document.querySelector('#profile-form'),
  dialogTitle: document.querySelector('#profile-dialog-title'),
  profileId: document.querySelector('#profile-id'),
  profileName: document.querySelector('#profile-name'),
  profileHost: document.querySelector('#profile-host'),
  profilePort: document.querySelector('#profile-port'),
  profileUsername: document.querySelector('#profile-username'),
  privateKeyRow: document.querySelector('#private-key-row'),
  privateKeyDrop: document.querySelector('#private-key-drop'),
  privateKey: document.querySelector('#profile-private-key'),
  privateKeyFeedback: document.querySelector('#private-key-feedback'),
  formError: document.querySelector('#form-error'),
  cancelProfile: document.querySelector('#cancel-profile'),
  cancelProfileX: document.querySelector('#cancel-profile-x'),
  tabs: document.querySelector('#session-tabs'),
  sessionStatus: document.querySelector('#session-status'),
  reconnect: document.querySelector('#reconnect-session'),
  close: document.querySelector('#close-session'),
  emptyState: document.querySelector('#empty-state'),
  terminalStack: document.querySelector('#terminal-stack'),
  sftpPanel: document.querySelector('#sftp-panel'),
  sftpParent: document.querySelector('#sftp-parent'),
  sftpRefresh: document.querySelector('#sftp-refresh'),
  sftpPath: document.querySelector('#sftp-path'),
  sftpMkdir: document.querySelector('#sftp-mkdir'),
  sftpUpload: document.querySelector('#sftp-upload'),
  sftpFileList: document.querySelector('#sftp-file-list'),
  sftpMessage: document.querySelector('#sftp-message'),
  secretDialog: document.querySelector('#sftp-secret-dialog'),
  secretForm: document.querySelector('#sftp-secret-form'),
  secretTitle: document.querySelector('#sftp-secret-title'),
  secretLabel: document.querySelector('#sftp-secret-label'),
  secretInput: document.querySelector('#sftp-secret'),
  secretNote: document.querySelector('#sftp-secret-note'),
  cancelSecret: document.querySelector('#cancel-sftp-secret'),
  cancelSecretX: document.querySelector('#cancel-sftp-secret-x')
}

const state = {
  profiles: [],
  sessions: new Map(),
  pendingEvents: new Map(),
  retiredSessionIds: new Set(),
  activeSessionId: null,
  sftp: null,
  sftpConnections: new Map(),
  sftpActive: false,
  filesOpen: false,
  sftpBusy: false,
  secretResolve: null,
  sftpConnecting: false,
  draggedRemote: null,
  copySource: null,
  connectingProfiles: new Set()
}

// 标签顺序独立于 SSH/SFTP 连接 Map，混排不会重连、关闭或更换选中会话。
let tabOrder = []
let tabPointer = null
let tabDragFrame = null
let suppressTabClickUntil = 0
const expandedProfileGroups = new Set()
const connectingGroups = new Set()
const uploadTargets = new Set()
let localDirectory = null
let localLoading = false
let localUploading = false
let selectingServers = false
let draggedLocalIds = null
const localSelection = new Set()

const profileSearch = document.querySelector('#profile-search')
const folderDialog = document.querySelector('#folder-dialog')
const folderForm = document.querySelector('#folder-form')
const folderName = document.querySelector('#folder-name')
const folderError = document.querySelector('#folder-error')
const notification = document.querySelector('#notification')
const batchHosts = document.querySelector('#profile-batch-hosts')
const saveProfileButton = document.querySelector('#save-profile')
let batchMode = false
let batchVisited = false
let profileSaving = false
let notificationTimer

/** 非阻塞反馈保留终端输入焦点；错误需用户关闭，成功提示自动消失。 */
function notify (message, isError = false) {
  clearTimeout(notificationTimer)
  document.querySelector('#notification-text').textContent = message
  notification.classList.remove('hidden')
  notification.classList.toggle('error', isError)
  if (!isError) notificationTimer = setTimeout(() => notification.classList.add('hidden'), 4500)
}

function errorMessage (error) {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': /u, '') : String(error)
}

function setFormError (message = '') {
  elements.formError.textContent = message
}

function setPrivateKeyFeedback (message, status = '') {
  elements.privateKeyFeedback.textContent = message
  elements.privateKeyDrop.classList.toggle('success', status === 'success')
  elements.privateKeyDrop.classList.toggle('error', status === 'error')
}

function profileById (id) {
  return state.profiles.find(profile => profile.id === id)
}

function createButton (text, className, action, label) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = className
  button.textContent = text
  if (label) button.setAttribute('aria-label', label)
  button.addEventListener('click', action)
  return button
}

/** 本地过滤配置，保持 SSH / SFTP 主操作常驻并显示当前工作连接。 */
function renderProfiles () {
  elements.profileList.replaceChildren()
  const query = profileSearch.value.trim().toLocaleLowerCase()
  const profiles = state.profiles.filter(profile => `${profile.name} ${profile.host} ${profile.username}`.toLocaleLowerCase().includes(query))
  document.querySelector('#profile-count').textContent = String(state.profiles.length)
  if (profiles.length === 0) {
    const message = document.createElement('p')
    message.className = 'profile-empty'
    message.textContent = query ? '没有找到匹配的服务器' : '还没有服务器，点击上方 ＋ 添加'
    elements.profileList.append(message)
    return
  }

  const visibleIds = new Set(profiles.map(profile => profile.id))
  for (const group of groupProfiles(state.profiles)) {
    const members = group.profiles.filter(profile => visibleIds.has(profile.id))
    if (!members.length) continue
    let parent = elements.profileList
    if (group.grouped) {
      const details = document.createElement('details')
      details.className = 'profile-group'
      details.open = Boolean(query) || expandedProfileGroups.has(group.key)
      const summary = document.createElement('summary')
      const title = document.createElement('span')
      title.textContent = group.name
      const count = document.createElement('span')
      count.className = 'group-count'
      count.textContent = String(members.length)
      const connectAll = createButton(connectingGroups.has(group.key) ? '连接中…' : '全部连接', 'group-connect', event => {
        event.preventDefault()
        event.stopPropagation()
        connectProfileGroup(group)
      }, `连接 ${group.name} 组内全部服务器`)
      connectAll.disabled = connectingGroups.has(group.key)
      summary.append(title, count, connectAll)
      details.append(summary)
      // 搜索期间临时展开，不覆盖用户平时的分组展开状态。
      details.addEventListener('toggle', () => {
        if (query) return
        if (details.open) expandedProfileGroups.add(group.key)
        else expandedProfileGroups.delete(group.key)
      })
      elements.profileList.append(details)
      parent = details
    }
    for (const profile of members) {
      const item = document.createElement('article')
      item.className = 'profile-item'
      item.dataset.profileId = profile.id

      const avatar = document.createElement('div')
      avatar.className = 'profile-avatar'
      avatar.textContent = profile.name.slice(0, 1).toUpperCase()

      const details = document.createElement('button')
      details.type = 'button'
      details.className = 'profile-details'
      details.title = `${profile.name} · ${profile.username}@${profile.host}:${profile.port}`
      details.addEventListener('click', () => connectProfile(profile.id))
      const name = document.createElement('strong')
      name.textContent = profile.name
      const target = document.createElement('span')
      target.textContent = `${profile.username}@${profile.host}:${profile.port}`
      details.append(name, target)

      const actions = document.createElement('div')
      actions.className = 'profile-actions'
      actions.append(
        createButton('编辑', 'text-button', () => openProfileDialog(profile), `编辑 ${profile.name}`),
        createButton('删除', 'text-button delete', () => deleteProfile(profile), `删除 ${profile.name}`),
        createButton('SFTP', 'text-button sftp', () => connectSftp(profile.id), `通过 SFTP 浏览 ${profile.name}`),
        createButton('SSH', 'connect-button', () => connectProfile(profile.id), `通过 SSH 连接 ${profile.name}`)
      )
      for (const button of actions.querySelectorAll('button')) button.title = button.getAttribute('aria-label')
      const sshButton = actions.querySelector('.connect-button')
      sshButton.disabled = state.connectingProfiles.has(profile.id)
      if (sshButton.disabled) sshButton.textContent = '连接中…'
      actions.querySelector('.sftp').disabled = state.sftpConnecting
      item.append(avatar, details, actions)
      parent.append(item)
    }
  }
  highlightProfile()
}

/** 高亮只更新现有节点，不因终端输出而重建正在操作的配置卡片。 */
function highlightProfile () {
  const profileId = state.sftpActive ? state.sftp?.profileId : state.sessions.get(state.activeSessionId)?.profileId
  for (const item of elements.profileList.querySelectorAll('.profile-item')) item.classList.toggle('selected', item.dataset.profileId === profileId)
  for (const group of elements.profileList.querySelectorAll('.profile-group')) group.classList.toggle('has-active', Boolean(group.querySelector('.profile-item.selected')))
}

/** 一组只启动一次批次；复用已打开的终端，逐台启动避免界面反复抢焦点。 */
async function connectProfileGroup (group) {
  if (connectingGroups.has(group.key)) return
  connectingGroups.add(group.key)
  expandedProfileGroups.add(group.key)
  renderProfiles()
  let opened = 0
  let skipped = 0
  let failed = 0
  let lastId = null
  try {
    for (const profile of group.profiles) {
      const existing = [...state.sessions.values()].find(item => item.profileId === profile.id && item.status === 'running')
      if (existing || state.connectingProfiles.has(profile.id)) {
        skipped++
        lastId = existing?.id ?? lastId
        continue
      }
      const id = await connectProfile(profile.id, { activate: false, quiet: true })
      if (id) { opened++; lastId = id } else failed++
    }
    if (lastId) activateSession(lastId)
    notify(`${group.name}：已打开 ${opened} 个终端，复用 ${skipped} 个${failed ? `，失败 ${failed} 个` : ''}`, failed > 0)
  } finally {
    connectingGroups.delete(group.key)
    renderProfiles()
  }
}

async function deleteProfile (profile) {
  if (!window.confirm(`确定删除“${profile.name}”吗？已连接的会话不会中断。`)) return
  try {
    await api.profiles.remove(profile.id)
    state.profiles = await api.profiles.list()
    renderProfiles()
  } catch (error) {
    notify(errorMessage(error), true)
  }
}

/** 编辑始终为单台；每次新建重置批量模式，但切换模式保留已填写的公共字段。 */
function openProfileDialog (profile = null) {
  if (profileSaving) return
  elements.form.reset()
  elements.profileId.value = profile?.id ?? ''
  elements.profileName.value = profile?.name ?? ''
  elements.profileHost.value = profile?.host ?? ''
  elements.profilePort.value = String(profile?.port ?? 22)
  elements.profileUsername.value = profile?.username ?? ''
  elements.privateKey.value = profile?.privateKeyPath ?? ''
  const auth = profile?.auth ?? 'agent'
  elements.form.querySelector(`input[name="auth"][value="${auth}"]`).checked = true
  elements.dialogTitle.textContent = profile ? '编辑连接' : '新建连接'
  batchVisited = false
  document.querySelector('#profile-mode').classList.toggle('hidden', Boolean(profile))
  setProfileMode(false)
  setFormError()
  setPrivateKeyFeedback(
    profile?.privateKeyPath ? '已保存私钥路径，可拖入文件替换' : '仅接受一个本机文件，也可手动输入路径',
    profile?.privateKeyPath ? 'success' : ''
  )
  syncAuthFields()
  elements.dialog.showModal()
  elements.profileName.focus()
}

/** 首次进入批量模式预填 root / 私钥，之后切换保留用户自己的认证选择。 */
function setProfileMode (batch) {
  if (profileSaving || (batch && elements.profileId.value)) return
  batchMode = batch
  if (batch && !batchVisited) {
    if (!elements.profileUsername.value) elements.profileUsername.value = 'root'
    elements.form.querySelector('input[name="auth"][value="key"]').checked = true
    batchVisited = true
  }
  document.querySelector('#profile-name-row').classList.toggle('hidden', batch)
  document.querySelector('#profile-host-row').classList.toggle('hidden', batch)
  document.querySelector('#profile-batch-row').classList.toggle('hidden', !batch)
  elements.profileName.required = !batch
  elements.profileHost.required = !batch
  elements.profileName.disabled = batch
  elements.profileHost.disabled = batch
  batchHosts.required = batch
  batchHosts.disabled = !batch
  document.querySelector('#profile-mode-single').setAttribute('aria-pressed', String(!batch))
  document.querySelector('#profile-mode-batch').setAttribute('aria-pressed', String(batch))
  updateBatchCount()
  syncAuthFields()
}

function updateBatchCount () {
  const count = batchHosts.value.split(/\r?\n/u).filter(line => line.trim()).length
  document.querySelector('#profile-batch-count').textContent = `${count} 台`
  saveProfileButton.textContent = batchMode ? `批量保存${count ? ` ${count} 台` : ''}` : '保存连接'
}

function closeProfileDialog () {
  if (profileSaving) return
  elements.dialog.close()
  setFormError()
}

function syncAuthFields () {
  const auth = elements.form.elements.auth.value
  const usesKey = auth === 'key'
  elements.privateKeyRow.classList.toggle('hidden', !usesKey)
  elements.privateKey.required = usesKey
  if (!usesKey) elements.privateKeyDrop.classList.remove('dragging')
}

function isFileDrag (event) {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files')
}

function preventFileDropNavigation (event) {
  if (isFileDrag(event)) event.preventDefault()
}

function selectDroppedPrivateKey (event) {
  if (!isFileDrag(event)) return
  event.preventDefault()
  elements.privateKeyDrop.classList.remove('dragging')
  const files = event.dataTransfer.files
  if (files.length !== 1) {
    setPrivateKeyFeedback('请一次只拖入一个私钥文件', 'error')
    return
  }
  const droppedEntry = event.dataTransfer.items?.[0]?.webkitGetAsEntry?.()
  if (droppedEntry && !droppedEntry.isFile) {
    setPrivateKeyFeedback('请选择私钥文件，不要拖入文件夹', 'error')
    return
  }

  try {
    // This narrow preload call resolves only the dropped File; it does not
    // expose filesystem reads, directory traversal, or an arbitrary path API.
    elements.privateKey.value = api.privateKeys.getPathForFile(files[0])
    setPrivateKeyFeedback(`已选择：${files[0].name}`, 'success')
  } catch (error) {
    setPrivateKeyFeedback('无法读取该文件的本机绝对路径', 'error')
  }
}

/** 批量提交一次 IPC，由存储层保证全有或全无，防止连续点击重复导入。 */
async function saveProfile (event) {
  event.preventDefault()
  if (profileSaving || !elements.form.reportValidity()) return

  const profile = {
    name: elements.profileName.value,
    host: elements.profileHost.value,
    port: Number(elements.profilePort.value),
    username: elements.profileUsername.value,
    auth: elements.form.elements.auth.value,
    privateKeyPath: elements.form.elements.auth.value === 'key' ? elements.privateKey.value : null
  }

  profileSaving = true
  saveProfileButton.disabled = true
  let createdCount = 1
  try {
    const id = elements.profileId.value
    if (id) await api.profiles.update(id, profile)
    else if (batchMode) {
      const { port, username, auth, privateKeyPath } = profile
      // 共用凭据路径不复制私钥内容；整批原子写入，错误可按行修正后重试。
      const created = await api.profiles.createBatch({ port, username, auth, privateKeyPath }, batchHosts.value)
      createdCount = created.length
    } else await api.profiles.create(profile)
    state.profiles = await api.profiles.list()
    profileSearch.value = ''
    renderProfiles()
    profileSaving = false
    closeProfileDialog()
    notify(id ? '连接已更新' : `已添加 ${createdCount} 台服务器`)
  } catch (error) {
    setFormError(errorMessage(error))
  } finally {
    profileSaving = false
    saveProfileButton.disabled = false
  }
}

function createTerminalSession (sessionId, profile) {
  const container = document.createElement('div')
  container.className = 'terminal-view'
  container.dataset.sessionId = sessionId
  const terminal = new Terminal({
    cursorBlink: true,
    cursorStyle: 'bar',
    allowTransparency: true,
    convertEol: true,
    fontFamily: '"SFMono-Regular", "Cascadia Code", Menlo, monospace',
    fontSize: 14,
    lineHeight: 1.35,
    scrollback: 5000,
    // xterm has a built-in OSC 8 provider; override activation so remote
    // output can never prompt for or initiate browser navigation.
    linkHandler: {
      activate: () => {},
      allowNonHttpProtocols: false
    },
    theme: {
      background: '#11161e',
      foreground: '#dbe5f5',
      cursor: '#68e0ba',
      cursorAccent: '#090d14',
      selectionBackground: '#2b4d60aa',
      black: '#111722',
      red: '#ff6b7a',
      green: '#68e0ba',
      yellow: '#e8c66a',
      blue: '#70a7ff',
      magenta: '#bd8cff',
      cyan: '#56d8e8',
      white: '#dbe5f5'
    }
  })
  const fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  // Consume remote clipboard writes even though no clipboard API is exposed.
  terminal.parser.registerOscHandler(52, () => true)
  terminal.open(container)

  const session = {
    id: sessionId,
    profileId: profile.id,
    title: profile.name,
    status: 'running',
    terminal,
    fitAddon,
    container,
    inputDisposable: null
  }
  session.inputDisposable = terminal.onData(data => {
    api.sessions.write(sessionId, data).catch(error => {
      terminal.writeln(`\r\n\x1b[31m${errorMessage(error)}\x1b[0m`)
    })
  })
  state.sessions.set(sessionId, session)
  elements.terminalStack.append(container)

  const pending = state.pendingEvents.get(sessionId) ?? []
  state.pendingEvents.delete(sessionId)
  for (const payload of pending) handleSessionEvent(payload)
  return session
}

/** 合并连续点击，构建终端失败时释放已启动的原生会话。 */
async function connectProfile (profileId, { activate = true, quiet = false } = {}) {
  const profile = profileById(profileId)
  if (!profile || state.connectingProfiles.has(profileId)) return
  state.connectingProfiles.add(profileId)
  renderProfiles()
  let sessionId

  try {
    const result = await api.sessions.start(profileId)
    sessionId = result.sessionId
    createTerminalSession(result.sessionId, profile)
    if (activate) activateSession(result.sessionId)
    return result.sessionId
  } catch (error) {
    if (sessionId) await api.sessions.close(sessionId).catch(() => {})
    if (!quiet) notify(errorMessage(error), true)
    return null
  } finally {
    state.connectingProfiles.delete(profileId)
    renderProfiles()
  }
}

// Collect credentials only for the pending connection and clear the field as
// soon as the modal resolves; no secret is added to profile or SFTP state.
function requestSftpSecret (profile) {
  if (profile.auth === 'agent') return Promise.resolve({ accepted: true, secret: '' })
  if (state.secretResolve) return Promise.resolve({ accepted: false, secret: '' })

  elements.secretForm.reset()
  const usesPassword = profile.auth === 'password'
  elements.secretTitle.textContent = `连接 ${profile.name}`
  elements.secretLabel.textContent = usesPassword ? '登录密码' : '私钥口令（没有可留空）'
  elements.secretNote.textContent = usesPassword
    ? '密码只用于本次 SFTP 连接，不会保存。'
    : '口令只用于本次解密私钥，不会保存。未加密私钥可直接连接。'
  elements.secretInput.required = usesPassword
  elements.secretDialog.showModal()
  elements.secretInput.focus()
  return new Promise(resolve => { state.secretResolve = resolve })
}

function finishSftpSecret (accepted) {
  const resolve = state.secretResolve
  if (!resolve) return
  const secret = accepted ? elements.secretInput.value : ''
  state.secretResolve = null
  elements.secretInput.value = ''
  elements.secretDialog.close()
  resolve({ accepted, secret })
}

function remoteChildPath (parentPath, name) {
  return `${parentPath === '/' ? '' : parentPath}/${name}`
}

function formatFileSize (size) {
  if (!Number.isFinite(size)) return '—'
  if (size < 1024) return `${size} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = size
  let unit = -1
  do {
    value /= 1024
    unit++
  } while (value >= 1024 && unit < units.length - 1)
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

/** 每台服务器独立记录操作状态，切换标签不丢失传输反馈。 */
function setSftpBusy (busy, message = '', connection = state.sftp) {
  if (connection) {
    connection.busy = busy
    connection.operation = message
  }
  if (connection !== state.sftp) return
  state.sftpBusy = busy
  for (const button of [elements.sftpParent, elements.sftpRefresh, elements.sftpMkdir, elements.sftpUpload]) {
    button.disabled = busy
  }
  elements.sftpPanel.setAttribute('aria-busy', String(busy))
  document.querySelector('#remote-connected .sftp-footer').classList.toggle('busy', busy)
  document.querySelector('#sftp-operation').textContent = busy ? message : '拖入本地文件上传 · 拖动远程文件到另一台 SFTP 标签复制'
  for (const button of elements.sftpFileList.querySelectorAll('button')) button.disabled = busy
  elements.sftpPath.disabled = busy
}

function renderSftpFiles () {
  const connection = state.sftp
  elements.sftpFileList.replaceChildren()
  if (!connection) return
  elements.sftpPath.value = connection.path
  elements.sftpPath.title = connection.path
  const profile = profileById(connection.profileId)
  document.querySelector('#sftp-target').textContent = profile ? `${profile.username}@${profile.host}` : connection.title
  document.querySelector('#sftp-count').textContent = `${connection.entries.length} 个项目`
  elements.sftpParent.disabled = state.sftpBusy || connection.path === '/'

  if (connection.entries.length === 0) {
    elements.sftpMessage.textContent = '这个目录是空的'
    elements.sftpMessage.classList.remove('hidden')
    return
  }
  elements.sftpMessage.classList.add('hidden')

  for (const entry of connection.entries) {
    const remotePath = remoteChildPath(connection.path, entry.name)
    const row = document.createElement('tr')
    if (entry.type === 'file') {
      row.draggable = true
      row.addEventListener('dragstart', event => {
        if (connection.busy) return event.preventDefault()
        // 拖拽内容只引用当前窗口已列出的文件，真实远端路径仍由主进程校验。
        state.draggedRemote = { connection, path: remotePath, name: entry.name }
        event.dataTransfer.setData('application/x-serverlink-file', entry.name)
        event.dataTransfer.effectAllowed = 'copy'
      })
      row.addEventListener('dragend', () => {
        state.draggedRemote = null
        document.querySelectorAll('.drop-target').forEach(item => item.classList.remove('drop-target'))
      })
    }
    const nameCell = document.createElement('td')
    nameCell.append(createButton(
      `${entry.type === 'directory' ? '▸' : entry.type === 'symlink' ? '↗' : '·'}  ${entry.name}`,
      `sftp-name ${entry.type}`,
      () => entry.type === 'directory' ? refreshSftp(remotePath) : downloadSftpFile(remotePath),
      entry.type === 'directory' ? `打开文件夹 ${entry.name}` : `下载 ${entry.name}`
    ))
    nameCell.firstChild.title = entry.name

    const sizeCell = document.createElement('td')
    sizeCell.className = 'sftp-meta'
    sizeCell.textContent = entry.type === 'directory' ? '—' : formatFileSize(entry.size)
    const modifiedCell = document.createElement('td')
    modifiedCell.className = 'sftp-meta'
    modifiedCell.textContent = entry.modifiedAt
      ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(entry.modifiedAt))
      : '—'
    const actionCell = document.createElement('td')
    actionCell.className = 'sftp-row-actions'
    if (entry.type !== 'directory') {
      actionCell.append(createButton('下载', 'text-button', () => downloadSftpFile(remotePath), `下载 ${entry.name}`))
    }
    if (entry.type === 'file') {
      actionCell.append(createButton('复制到…', 'text-button', () => openCopyDialog({ connection, path: remotePath, name: entry.name }), `复制 ${entry.name} 到其他服务器`))
    }
    actionCell.append(createButton('删除', 'text-button delete', () => removeSftpEntry(remotePath), `删除 ${entry.name}`))
    row.append(nameCell, sizeCell, modifiedCell, actionCell)
    elements.sftpFileList.append(row)
  }
}

/** 串行建立文件连接，防止连续点击产生未展示的后台会话。 */
async function connectSftp (profileId) {
  const profile = profileById(profileId)
  if (!profile || state.sftpConnecting) return
  const existing = [...state.sftpConnections.values()].find(connection => connection.profileId === profileId)
  if (existing) {
    activateSftp(existing.connectionId)
    return
  }

  state.sftpConnecting = true
  renderProfiles()
  let credential
  try {
    credential = await requestSftpSecret(profile)
    if (!credential.accepted) return
    notify(`正在连接 ${profile.name} 的文件服务…`)
    const result = await api.sftp.connect(profileId, credential.secret)
    const connection = {
      profileId,
      title: `${profile.name} · SFTP`,
      connectionId: result.connectionId,
      path: result.path,
      entries: result.entries,
      busy: false,
      operation: ''
    }
    state.sftpConnections.set(result.connectionId, connection)
    uploadTargets.add(result.connectionId)
    activateSftp(result.connectionId)
    renderSftpFiles()
    notify('文件服务已连接')
  } catch (error) {
    notify(errorMessage(error), true)
  } finally {
    if (credential) credential.secret = ''
    state.sftpConnecting = false
    renderProfiles()
  }
}

async function refreshSftpAfterOperation (connection) {
  const result = await api.sftp.list(connection.connectionId, connection.path)
  if (!state.sftpConnections.has(connection.connectionId)) return
  connection.path = result.path
  connection.entries = result.entries
}

async function refreshSftp (remotePath = state.sftp?.path) {
  const connection = state.sftp
  if (!connection || state.sftpBusy || !remotePath) return
  setSftpBusy(true, '正在读取目录…')
  try {
    const result = await api.sftp.list(connection.connectionId, remotePath)
    if (!state.sftpConnections.has(connection.connectionId)) return
    connection.path = result.path
    connection.entries = result.entries
  } catch (error) {
    notify(errorMessage(error), true)
  } finally {
    setSftpBusy(false, '', connection)
    if (state.sftp === connection) renderSftpFiles()
  }
}

async function uploadSftpFile () {
  const connection = state.sftp
  if (!connection || state.sftpBusy) return
  setSftpBusy(true, '正在上传文件…')
  try {
    const result = await api.sftp.upload(connection.connectionId, connection.path)
    if (!result.canceled) await refreshSftpAfterOperation(connection)
    if (!result.canceled) notify('上传完成')
  } catch (error) {
    notify(errorMessage(error), true)
  } finally {
    setSftpBusy(false, '', connection)
    if (state.sftp === connection) renderSftpFiles()
  }
}

async function downloadSftpFile (remotePath) {
  const connection = state.sftp
  if (!connection || state.sftpBusy) return
  setSftpBusy(true, '正在下载文件…')
  try {
    const result = await api.sftp.download(connection.connectionId, remotePath)
    if (!result.canceled) notify('文件已保存到所选位置')
  } catch (error) {
    notify(errorMessage(error), true)
  } finally {
    setSftpBusy(false, '', connection)
    if (state.sftp === connection) renderSftpFiles()
  }
}

/** 使用应用内表单收集名称，Electron 不支持 window.prompt。 */
function createSftpDirectory () {
  if (!state.sftp || state.sftpBusy) return
  folderForm.reset()
  folderError.textContent = ''
  folderDialog.showModal()
  folderName.focus()
}

/** 创建成功才关闭弹窗；失败保留名称，便于修正后重试。 */
async function submitSftpDirectory (event) {
  event.preventDefault()
  const connection = state.sftp
  if (!connection || state.sftpBusy) return
  const name = folderName.value.trim()
  if (!name || name === '.' || name === '..' || name.includes('/')) {
    folderError.textContent = '请输入有效名称，不能包含 / 或仅为 .、..'
    return
  }
  const submit = folderForm.querySelector('[type="submit"]')
  submit.disabled = true
  folderError.textContent = ''
  setSftpBusy(true, '正在新建文件夹…')
  try {
    await api.sftp.mkdir(connection.connectionId, connection.path, name)
    folderDialog.close()
    notify('文件夹已创建')
    await refreshSftpAfterOperation(connection)
  } catch (error) {
    folderError.textContent = errorMessage(error)
    if (!folderDialog.open) notify(errorMessage(error), true)
  } finally {
    submit.disabled = false
    setSftpBusy(false, '', connection)
    if (state.sftp === connection) renderSftpFiles()
  }
}

async function removeSftpEntry (remotePath) {
  const connection = state.sftp
  if (!connection || state.sftpBusy) return
  setSftpBusy(true, '等待删除确认…')
  try {
    // Main process performs its own native confirmation so renderer code can
    // never silently approve a destructive remote operation.
    const removed = await api.sftp.remove(connection.connectionId, remotePath)
    if (removed) await refreshSftpAfterOperation(connection)
    if (removed) notify('远程项目已删除')
  } catch (error) {
    notify(errorMessage(error), true)
  } finally {
    setSftpBusy(false, '', connection)
    if (state.sftp === connection) renderSftpFiles()
  }
}

/** 文件工作空间可在未连接远端时打开，先展示本机目录。 */
function openFileWorkspace () {
  state.filesOpen = true
  state.sftpActive = true
  state.sftp = null
  state.activeSessionId = null
  renderTabs()
  syncWorkspaceState()
  renderRemoteChoices()
  if (!localDirectory) loadLocalDirectory(null)
}

/** 仅使用主进程提供的目录令牌导航，刷新后清空旧选择避免引用过期文件。 */
async function loadLocalDirectory (id = localDirectory?.id ?? null) {
  if (localLoading || localUploading) return
  localLoading = true
  document.querySelector('#local-message').textContent = '正在读取本机目录…'
  syncLocalActions()
  try {
    localDirectory = await api.local.list(id)
    localSelection.clear()
    renderLocalFiles()
  } catch (error) {
    document.querySelector('#local-message').textContent = errorMessage(error)
    notify(errorMessage(error), true)
  } finally {
    localLoading = false
    syncLocalActions()
  }
}

function visibleLocalFiles () {
  return (localDirectory?.entries ?? []).filter(entry => document.querySelector('#local-show-hidden').checked || !entry.name.startsWith('.'))
}

/** 渲染本地元数据，选择与拖放只携带文件令牌，不传递路径给上传接口。 */
function renderLocalFiles () {
  const list = document.querySelector('#local-file-list')
  list.replaceChildren()
  if (!localDirectory) return
  document.querySelector('#local-path').textContent = localDirectory.path
  document.querySelector('#local-path').title = localDirectory.path
  const entries = visibleLocalFiles()
  for (const entry of entries) {
    const row = document.createElement('tr')
    const choice = document.createElement('td')
    if (entry.type === 'file') {
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.checked = localSelection.has(entry.id)
      checkbox.setAttribute('aria-label', `选择本地文件 ${entry.name}`)
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) localSelection.add(entry.id)
        else localSelection.delete(entry.id)
        syncLocalActions()
      })
      choice.append(checkbox)
      row.draggable = true
      row.addEventListener('dragstart', event => {
        if (localUploading) return event.preventDefault()
        draggedLocalIds = localSelection.has(entry.id) ? [...localSelection] : [entry.id]
        event.dataTransfer.setData('application/x-serverlink-local-files', entry.name)
        event.dataTransfer.effectAllowed = 'copy'
      })
      row.addEventListener('dragend', () => { draggedLocalIds = null })
    }
    const name = document.createElement('td')
    const button = createButton(`${entry.type === 'directory' ? '▸' : '·'} ${entry.name}`, 'sftp-name', () => {}, entry.name)
    button.title = `${entry.name} · ${entry.modifiedAt}`
    button.disabled = entry.type !== 'directory'
    if (entry.type === 'directory') {
      button.classList.add('directory')
      button.addEventListener('dblclick', () => loadLocalDirectory(entry.id))
      button.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); loadLocalDirectory(entry.id) }
      })
    }
    name.append(button)
    const size = document.createElement('td')
    size.textContent = entry.type === 'file' ? formatFileSize(entry.size) : '—'
    const kind = document.createElement('td')
    kind.textContent = entry.type === 'directory' ? '文件夹' : entry.type === 'file' ? '文件' : '链接/其他'
    row.append(choice, name, size, kind)
    list.append(row)
  }
  document.querySelector('#local-message').textContent = entries.length ? '' : '此目录为空'
  syncLocalActions()
}

function syncLocalActions () {
  const busy = localLoading || localUploading
  document.querySelector('#local-parent').disabled = busy || !localDirectory?.parentId
  document.querySelector('#local-home').disabled = busy
  document.querySelector('#local-refresh').disabled = busy
  document.querySelector('#local-show-hidden').disabled = busy
  for (const checkbox of document.querySelectorAll('#local-file-list input')) checkbox.disabled = busy
  const selectAll = document.querySelector('#local-select-all')
  const files = visibleLocalFiles().filter(entry => entry.type === 'file')
  selectAll.disabled = busy || !files.length
  selectAll.checked = files.length > 0 && files.every(entry => localSelection.has(entry.id))
  selectAll.indeterminate = localSelection.size > 0 && !selectAll.checked
  const button = document.querySelector('#local-upload')
  button.disabled = busy || !localSelection.size || !uploadTargets.size
  button.textContent = localUploading ? '正在上传…' : `上传所选${localSelection.size ? ` ${localSelection.size}` : ''}`
  document.querySelector('#local-count').textContent = `已选 ${localSelection.size} 个文件 · ${uploadTargets.size} 台目标`
}

/** 在右侧分别提供浏览切换和上传目标勾选，切换目录不改变其他服务器选择。 */
function renderRemoteChoices () {
  const choices = document.querySelector('#remote-choices')
  choices.replaceChildren()
  for (const connection of state.sftpConnections.values()) {
    const item = document.createElement('div')
    item.className = `remote-choice${state.sftp === connection ? ' active' : ''}`
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.checked = uploadTargets.has(connection.connectionId)
    checkbox.disabled = localUploading
    checkbox.setAttribute('aria-label', `上传目标 ${connection.title}`)
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) uploadTargets.add(connection.connectionId)
      else uploadTargets.delete(connection.connectionId)
      syncLocalActions()
    })
    item.append(checkbox, createButton(connection.title.replace(/ · SFTP$/u, ''), 'text-button', () => activateSftp(connection.connectionId)))
    choices.append(item)
  }
  syncLocalActions()
}

function showServerPicker () {
  if (state.sftpConnecting || selectingServers || localUploading) return notify('正在连接或传输，请稍候')
  const list = document.querySelector('#server-options')
  list.replaceChildren()
  for (const profile of state.profiles) {
    const label = document.createElement('label')
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.value = profile.id
    const existing = [...state.sftpConnections.values()].find(connection => connection.profileId === profile.id)
    checkbox.checked = Boolean(existing && uploadTargets.has(existing.connectionId))
    label.append(checkbox, document.createTextNode(`${profile.name}${existing ? ' · 已连接' : ''}`))
    list.append(label)
  }
  if (!state.profiles.length) list.textContent = '请先在左侧添加服务器配置'
  document.querySelector('#servers-dialog').showModal()
}

/** 多台依次验证凭据；取消单台或认证失败继续处理其他选择，不保存任何密码。 */
async function connectSelectedServers (event) {
  event.preventDefault()
  const ids = [...document.querySelectorAll('#server-options input:checked')].map(input => input.value)
  if (!ids.length || ids.length > 20) return notify('请选择 1～20 台服务器', true)
  document.querySelector('#servers-dialog').close()
  selectingServers = true
  const selected = new Set()
  try {
    for (const id of ids) {
      await connectSftp(id)
      const connection = [...state.sftpConnections.values()].find(item => item.profileId === id)
      if (connection) selected.add(connection.connectionId)
    }
    uploadTargets.clear()
    for (const id of selected) uploadTargets.add(id)
    renderRemoteChoices()
    notify(`已选择 ${selected.size} 台上传目标${ids.length > selected.size ? `，${ids.length - selected.size} 台未连接` : ''}`)
  } finally {
    selectingServers = false
  }
}

/** 一次上传到勾选的多个目录，主进程逐项返回结果，失败不回滚已成功的文件。 */
async function uploadLocalSelection (targets = [...state.sftpConnections.values()].filter(item => uploadTargets.has(item.connectionId)), fileIds = [...localSelection]) {
  if (localUploading || !targets.length || !fileIds.length) return
  if (targets.some(item => item.busy)) return notify('有目标服务器正在操作，请稍后上传', true)
  localUploading = true
  syncLocalActions()
  renderRemoteChoices()
  const resultBox = document.querySelector('#transfer-results')
  resultBox.classList.remove('hidden')
  resultBox.textContent = `正在将 ${fileIds.length} 个文件上传到 ${targets.length} 台服务器…`
  for (const target of targets) setSftpBusy(true, `接收本地 ${fileIds.length} 个文件…`, target)
  try {
    const results = await api.local.upload(fileIds, targets.map(target => ({ connectionId: target.connectionId, path: target.path })))
    resultBox.replaceChildren()
    for (const result of results) {
      const line = document.createElement('div')
      const target = targets.find(item => item.connectionId === result.connectionId)
      line.textContent = `${result.success ? '✓' : '✕'} ${target?.title ?? '服务器'} / ${result.name}${result.success ? '：完成' : `：${result.error}`}`
      line.className = result.success ? 'transfer-ok' : 'transfer-error'
      resultBox.append(line)
    }
    for (const target of targets) await refreshSftpAfterOperation(target).catch(() => {})
  } catch (error) {
    resultBox.textContent = errorMessage(error)
  } finally {
    for (const target of targets) setSftpBusy(false, '', target)
    localUploading = false
    syncLocalActions()
    renderRemoteChoices()
    if (state.sftp) renderSftpFiles()
  }
}

/** 恢复每个 SFTP 标签自己的目录及传输状态。 */
function activateSftp (connectionId = state.sftp?.connectionId) {
  const connection = state.sftpConnections.get(connectionId)
  if (!connection) return
  state.sftp = connection
  state.filesOpen = true
  state.sftpActive = true
  state.activeSessionId = null
  renderTabs()
  syncWorkspaceState()
  renderSftpFiles()
  setSftpBusy(connection.busy, connection.operation, connection)
  renderRemoteChoices()
  if (!localDirectory) loadLocalDirectory(null)
}

async function closeSftp () {
  const connection = state.sftp
  if (!connection) return
  if (connection.busy) return notify('请等待当前文件操作完成后再关闭')
  state.sftpConnections.delete(connection.connectionId)
  uploadTargets.delete(connection.connectionId)
  state.sftp = null
  state.sftpActive = true
  setSftpBusy(false)
  await api.sftp.close(connection.connectionId).catch(() => {})
  const remainingSftp = [...state.sftpConnections.keys()].at(-1)
  if (remainingSftp) return activateSftp(remainingSftp)
  if (state.filesOpen) return openFileWorkspace()
  const remainingSessionId = [...state.sessions.keys()].at(-1)
  if (remainingSessionId) activateSession(remainingSessionId)
  else {
    renderTabs()
    syncWorkspaceState()
  }
}

/** 本地多文件拖放逐项反馈结果；标签切换后仍刷新原来的目标目录。 */
async function uploadDroppedFiles (connection, files) {
  if (!connection || connection.busy) return notify('目标服务器正在执行文件操作，请稍后再试')
  if (!files.length || files.length > 100) return notify('请一次拖入 1～100 个普通文件', true)
  setSftpBusy(true, `正在上传 ${files.length} 个文件…`, connection)
  notify(`开始上传 ${files.length} 个文件 → ${connection.title} ${connection.path}`)
  try {
    // File 由预加载层解析真实路径，渲染层不拼装任何本地文件路径。
    const results = await api.sftp.uploadFiles(connection.connectionId, connection.path, files)
    const failed = results.filter(result => !result.success)
    if (failed.length) notify(`成功 ${results.length - failed.length}，失败 ${failed.length}：${failed.map(item => `${item.name}（${item.error}）`).join('；')}`, true)
    else notify(`${results.length} 个文件上传完成 → ${connection.title}`)
    await refreshSftpAfterOperation(connection)
  } catch (error) {
    notify(errorMessage(error), true)
  } finally {
    setSftpBusy(false, '', connection)
    if (state.sftp === connection) renderSftpFiles()
  }
}

/** 文件面板和服务器标签共用拖放语义，内部拖拽只读当前窗口记录。 */
function bindSftpDropTarget (target, getConnection) {
  target.addEventListener('dragover', event => {
    if (!isFileDrag(event) && !state.draggedRemote && !draggedLocalIds) return
    event.preventDefault()
    const connection = getConnection()
    const allowed = connection && !connection.busy && (!state.draggedRemote || state.draggedRemote.connection !== connection)
    event.dataTransfer.dropEffect = allowed ? 'copy' : 'none'
    target.classList.toggle('drop-target', Boolean(allowed))
  })
  target.addEventListener('dragleave', event => {
    if (!target.contains(event.relatedTarget)) target.classList.remove('drop-target')
  })
  target.addEventListener('drop', event => {
    event.preventDefault()
    target.classList.remove('drop-target')
    const connection = getConnection()
    if (!connection) return
    if (draggedLocalIds) {
      uploadLocalSelection([connection], draggedLocalIds)
    } else if (state.draggedRemote) {
      openCopyDialog(state.draggedRemote, connection)
    } else if (isFileDrag(event)) {
      const items = Array.from(event.dataTransfer.items ?? [])
      if (items.some(item => item.webkitGetAsEntry?.()?.isDirectory)) return notify('请拖入普通文件；文件夹可先压缩再上传', true)
      uploadDroppedFiles(connection, Array.from(event.dataTransfer.files))
    }
  })
}

/** 提交前显示具体来源与目标路径，同时提供不依赖拖拽的键盘操作入口。 */
function openCopyDialog (source, preferredTarget) {
  if (source.connection.busy) return notify('源服务器正在执行文件操作')
  const destinations = [...state.sftpConnections.values()].filter(item => item !== source.connection && !item.busy)
  if (!destinations.length) return notify('请先打开另一台服务器的 SFTP 标签，并等待它完成当前操作', true)
  const select = document.querySelector('#copy-target')
  select.replaceChildren(...destinations.map(connection => {
    const option = document.createElement('option')
    option.value = connection.connectionId
    option.textContent = connection.title
    return option
  }))
  if (preferredTarget) {
    if (!destinations.includes(preferredTarget)) return notify('目标服务器不可用或正在传输', true)
    select.value = preferredTarget.connectionId
  }
  state.copySource = source
  document.querySelector('#copy-source').textContent = `来源：${source.connection.title} · ${source.path}`
  showCopyDestination()
  document.querySelector('#copy-dialog').showModal()
}

function showCopyDestination () {
  const destination = state.sftpConnections.get(document.querySelector('#copy-target').value)
  document.querySelector('#copy-destination').textContent = `目标目录：${destination?.path ?? '连接已关闭'}`
}

/** 同时占用源和目标，复制完成后仅刷新目标，其他连接仍可使用。 */
async function submitRemoteCopy (event) {
  event.preventDefault()
  const source = state.copySource
  const destination = state.sftpConnections.get(document.querySelector('#copy-target').value)
  if (!source || !destination || !state.sftpConnections.has(source.connection.connectionId)) return notify('连接已关闭，请重新选择文件', true)
  if (source.connection.busy || destination.busy) return notify('连接正在传输，请稍后再试', true)
  const label = `${source.name}：${source.connection.title} → ${destination.title}`
  document.querySelector('#copy-dialog').close()
  setSftpBusy(true, `正在复制 ${label}`, source.connection)
  setSftpBusy(true, `正在接收 ${source.name}`, destination)
  notify(`开始复制 ${label}`)
  try {
    // 主进程使用两个已认证的 SFTP 通道流式转发，不需服务器之间另配 SSH 密钥。
    await api.sftp.copyBetween(source.connection.connectionId, source.path, destination.connectionId, destination.path)
    notify(`复制完成：${label}`)
    await refreshSftpAfterOperation(destination)
  } catch (error) {
    notify(errorMessage(error), true)
  } finally {
    setSftpBusy(false, '', source.connection)
    setSftpBusy(false, '', destination)
    if (state.sftp) renderSftpFiles()
  }
}

/** 渲染期间保留统一顺序；拖动时延后状态重绘，避免销毁指针捕获节点。 */
function renderTabs () {
  if (tabPointer) return
  const scrollLeft = elements.tabs.scrollLeft
  elements.tabs.replaceChildren()
  if (state.filesOpen) {
    const tab = createButton('本机文件 · SFTP', 'session-tab', openFileWorkspace)
    tab.dataset.tabKey = 'files:local'
    tab.setAttribute('role', 'tab')
    tab.setAttribute('aria-selected', String(state.sftpActive && !state.sftp))
    tab.classList.toggle('active', state.sftpActive && !state.sftp)
    elements.tabs.append(tab)
  }
  for (const session of state.sessions.values()) {
    const tab = createButton(session.title, 'session-tab', () => activateSession(session.id))
    tab.title = `${session.title} · SSH`
    tab.dataset.tabKey = `ssh:${session.id}`
    const label = document.createElement('span')
    label.className = 'tab-label'
    label.textContent = session.title
    tab.replaceChildren(label)
    tab.setAttribute('role', 'tab')
    tab.setAttribute('aria-selected', String(session.id === state.activeSessionId))
    tab.classList.toggle('active', session.id === state.activeSessionId)
    const dot = document.createElement('span')
    dot.className = `tab-dot ${session.status}`
    tab.prepend(dot)
    elements.tabs.append(tab)
  }
  for (const connection of state.sftpConnections.values()) {
    const tab = createButton(connection.title, 'session-tab sftp-tab', () => activateSftp(connection.connectionId))
    tab.title = `${connection.title} · ${connection.path} · 可拖入文件`
    tab.dataset.tabKey = `sftp:${connection.connectionId}`
    const label = document.createElement('span')
    label.className = 'tab-label'
    label.textContent = connection.title
    tab.replaceChildren(label)
    tab.setAttribute('role', 'tab')
    const active = state.sftpActive && state.sftp === connection
    tab.setAttribute('aria-selected', String(active))
    tab.classList.toggle('active', active)
    bindSftpDropTarget(tab, () => connection)
    const dot = document.createElement('span')
    dot.className = 'tab-dot running'
    tab.prepend(dot)
    elements.tabs.append(tab)
  }
  const nodes = new Map([...elements.tabs.children].map(tab => [tab.dataset.tabKey, tab]))
  tabOrder = tabOrder.filter(key => nodes.has(key))
  for (const key of nodes.keys()) if (!tabOrder.includes(key)) tabOrder.push(key)
  for (const key of tabOrder) elements.tabs.append(nodes.get(key))
  elements.tabs.scrollLeft = scrollLeft
}

/** 根据指针位置预览插入顺序，靠近标签栏两端时滚动以到达隐藏标签。 */
function updateTabDrag () {
  const drag = tabPointer
  if (!drag?.moved) return
  const bounds = elements.tabs.getBoundingClientRect()
  const direction = drag.x < bounds.left + 28 ? -1 : drag.x > bounds.right - 28 ? 1 : 0
  if (direction) elements.tabs.scrollLeft += direction * 10
  const tabs = [...elements.tabs.children]
  const others = tabs.filter(tab => tab.dataset.tabKey !== drag.key)
  if (drag.ghost) drag.ghost.style.transform = `translate3d(${drag.x - drag.startX}px, -3px, 0)`
  const target = others.find(tab => {
    // 使用布局坐标而非动画中的视觉坐标，防止让位动画反复触发交换。
    return drag.x < bounds.left + tab.offsetLeft - elements.tabs.scrollLeft + tab.offsetWidth / 2
  })
  const anchor = target ?? others.at(-1)
  if (anchor) {
    const nextOrder = moveTab(tabOrder, drag.key, anchor.dataset.tabKey, !target)
    if (nextOrder.some((key, index) => key !== tabOrder[index])) {
      const before = new Map(others.map(tab => [tab, tab.getBoundingClientRect().left]))
      for (const tab of others) for (const animation of tab.getAnimations()) animation.cancel()
      tabOrder = nextOrder
      const source = tabs.find(tab => tab.dataset.tabKey === drag.key)
      if (source) elements.tabs.insertBefore(source, target ?? null)
      // FLIP 仅对让位标签做位移动画；被拖标签由独立浮层实时跟随指针。
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        for (const tab of others) {
          const delta = before.get(tab) - tab.getBoundingClientRect().left
          if (delta) tab.animate([{ transform: `translateX(${delta}px)` }, { transform: 'translateX(0)' }], { duration: 180, easing: 'cubic-bezier(.22,1,.36,1)' })
        }
      }
    }
  }
  tabDragFrame = window.requestAnimationFrame(updateTabDrag)
}

/** 放下保留顺序，Escape/失焦取消；排序不触发标签点击或文件传输。 */
function finishTabDrag (cancel = false) {
  const drag = tabPointer
  if (!drag) return
  tabPointer = null
  if (tabDragFrame !== null) window.cancelAnimationFrame(tabDragFrame)
  tabDragFrame = null
  if (cancel) tabOrder = drag.originalOrder
  if (drag.moved) suppressTabClickUntil = performance.now() + 300
  elements.tabs.classList.remove('sorting')
  if (elements.tabs.hasPointerCapture(drag.pointerId)) elements.tabs.releasePointerCapture(drag.pointerId)
  // 即使期间连接状态发生变化，也只在手势结束后统一重绘最新状态。
  renderTabs()
  if (drag.ghost) {
    const target = elements.tabs.querySelector(`[data-tab-key="${drag.key}"]`)
    if (target && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const delta = target.getBoundingClientRect().left - drag.ghostLeft
      const animation = drag.ghost.animate([{ transform: drag.ghost.style.transform }, { transform: `translate3d(${delta}px, 0, 0)`, opacity: 0 }], { duration: 150, easing: 'ease-out', fill: 'forwards' })
      animation.finished.finally(() => drag.ghost.remove())
    } else drag.ghost.remove()
  }
}

function activateSession (sessionId) {
  if (!state.sessions.has(sessionId)) return
  state.sftpActive = false
  state.activeSessionId = sessionId
  for (const session of state.sessions.values()) {
    session.container.classList.toggle('active', session.id === sessionId)
  }
  renderTabs()
  syncWorkspaceState()
  const session = state.sessions.get(sessionId)
  window.requestAnimationFrame(() => {
    // SFTP 切换或关闭标签后，旧帧不能重新聚焦隐藏终端或发送错误尺寸。
    if (state.sftpActive || state.activeSessionId !== sessionId || !state.sessions.has(sessionId)) return
    session.fitAddon.fit()
    api.sessions.resize(session.id, session.terminal.cols, session.terminal.rows).catch(() => {})
    session.terminal.focus()
  })
}

function syncWorkspaceState () {
  highlightProfile()
  const session = !state.sftpActive && state.activeSessionId
    ? state.sessions.get(state.activeSessionId)
    : null
  const hasView = Boolean(session || state.sftpActive)
  elements.emptyState.classList.toggle('hidden', hasView)
  elements.terminalStack.classList.toggle('active', Boolean(session))
  elements.sftpPanel.classList.toggle('hidden', !state.sftpActive)
  document.querySelector('#remote-empty').classList.toggle('hidden', Boolean(state.sftp))
  document.querySelector('#remote-connected').classList.toggle('hidden', !state.sftp)
  elements.reconnect.disabled = !session
  elements.close.disabled = !hasView
  elements.close.classList.toggle('hidden', !hasView)
  elements.reconnect.classList.toggle('hidden', !session)

  if (state.sftpActive && state.sftp) {
    elements.sessionStatus.textContent = 'SFTP 已连接'
    elements.sessionStatus.className = 'status-pill running'
    return
  }
  if (!session) {
    elements.sessionStatus.textContent = state.sftpActive ? '本机文件' : '未连接'
    elements.sessionStatus.className = 'status-pill'
    return
  }
  const labels = { running: '运行中', exited: '已断开', closing: '关闭中' }
  elements.sessionStatus.textContent = labels[session.status] ?? session.status
  elements.sessionStatus.className = `status-pill ${session.status}`
}

function handleSessionEvent (payload) {
  if (!payload || typeof payload !== 'object' || typeof payload.sessionId !== 'string') return
  const session = state.sessions.get(payload.sessionId)
  if (!session) {
    if (state.retiredSessionIds.has(payload.sessionId)) return
    const pending = state.pendingEvents.get(payload.sessionId) ?? []
    if (pending.length < 100) pending.push(payload)
    state.pendingEvents.set(payload.sessionId, pending)
    return
  }

  if (payload.type === 'data' && typeof payload.data === 'string') {
    session.terminal.write(payload.data)
    // 终端输出不改变标签状态，避免高频输出重建标签、打断点击及排序。
    return
  } else if (payload.type === 'status' && payload.status === 'running') {
    session.status = 'running'
  } else if (payload.type === 'exit') {
    session.status = 'exited'
    session.terminal.writeln(`\r\n\x1b[90m[连接已结束，退出码 ${payload.exitCode ?? '未知'}]\x1b[0m`)
  }
  renderTabs()
  syncWorkspaceState()
}

async function reconnectActiveSession () {
  const session = state.sessions.get(state.activeSessionId)
  if (!session) return
  const profileId = session.profileId
  await removeSession(session, true)
  await connectProfile(profileId)
}

async function removeSession (session, requestClose) {
  if (requestClose && session.status !== 'exited') {
    session.status = 'closing'
    syncWorkspaceState()
    await api.sessions.close(session.id).catch(() => {})
  }
  session.inputDisposable?.dispose()
  session.terminal.dispose()
  session.container.remove()
  state.sessions.delete(session.id)
  state.pendingEvents.delete(session.id)
  state.retiredSessionIds.add(session.id)
  // Native cleanup has a 1.5 second force-close fallback; retain a bounded
  // tombstone briefly so its final event cannot become an orphaned buffer.
  setTimeout(() => state.retiredSessionIds.delete(session.id), 10000)

  if (state.activeSessionId === session.id) {
    const remaining = [...state.sessions.keys()]
    state.activeSessionId = remaining.at(-1) ?? null
  }
  if (state.activeSessionId) activateSession(state.activeSessionId)
  else if (state.sftp) activateSftp()
  else {
    renderTabs()
    syncWorkspaceState()
  }
}

async function closeActiveSession () {
  if (state.sftpActive) {
    if (!state.sftp) {
      state.filesOpen = false
      state.sftpActive = false
      const lastId = [...state.sessions.keys()].at(-1)
      if (lastId) activateSession(lastId)
      else { renderTabs(); syncWorkspaceState() }
      return
    }
    if (state.sftpBusy) return notify('请等待当前文件操作完成后再关闭')
    await closeSftp()
    return
  }
  const session = state.sessions.get(state.activeSessionId)
  if (session) await removeSession(session, true)
}

const resizeObserver = new window.ResizeObserver(() => {
  const session = state.sessions.get(state.activeSessionId)
  if (!session) return
  session.fitAddon.fit()
  api.sessions.resize(session.id, session.terminal.cols, session.terminal.rows).catch(() => {})
})
resizeObserver.observe(elements.terminalStack)

elements.addProfile.addEventListener('click', () => openProfileDialog())
elements.emptyAddProfile.addEventListener('click', () => openProfileDialog())
elements.cancelProfile.addEventListener('click', closeProfileDialog)
elements.cancelProfileX.addEventListener('click', closeProfileDialog)
elements.form.addEventListener('submit', event => saveProfile(event))
document.querySelector('#profile-mode-single').addEventListener('click', () => setProfileMode(false))
document.querySelector('#profile-mode-batch').addEventListener('click', () => setProfileMode(true))
batchHosts.addEventListener('input', updateBatchCount)
elements.dialog.addEventListener('cancel', event => {
  if (profileSaving) event.preventDefault()
})
elements.form.addEventListener('change', event => {
  if (event.target.name === 'auth') syncAuthFields()
})
elements.privateKey.addEventListener('input', () => {
  const message = elements.privateKey.value.trim()
    ? '已手动输入路径，保存时会再次校验'
    : '仅接受一个本机文件，也可手动输入路径'
  setPrivateKeyFeedback(message)
})
elements.privateKeyDrop.addEventListener('dragenter', event => {
  if (isFileDrag(event)) elements.privateKeyDrop.classList.add('dragging')
})
elements.privateKeyDrop.addEventListener('dragover', event => {
  if (!isFileDrag(event)) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'copy'
  elements.privateKeyDrop.classList.add('dragging')
})
elements.privateKeyDrop.addEventListener('dragleave', event => {
  if (!elements.privateKeyDrop.contains(event.relatedTarget)) {
    elements.privateKeyDrop.classList.remove('dragging')
  }
})
elements.privateKeyDrop.addEventListener('drop', selectDroppedPrivateKey)
// Chromium navigates to a dropped file by default; block that behavior across
// the whole window, including when the user misses the visible drop zone.
window.addEventListener('dragover', preventFileDropNavigation, { capture: true })
window.addEventListener('drop', preventFileDropNavigation, { capture: true })
elements.reconnect.addEventListener('click', () => reconnectActiveSession())
elements.tabs.addEventListener('pointerdown', event => {
  const tab = event.target.closest('.session-tab')
  if (!tab || event.button !== 0 || !event.isPrimary || tabPointer) return
  tabPointer = { key: tab.dataset.tabKey, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, moved: false, originalOrder: tabOrder.slice() }
})
window.addEventListener('pointermove', event => {
  const drag = tabPointer
  if (!drag || event.pointerId !== drag.pointerId) return
  drag.x = event.clientX
  if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 6) {
    drag.moved = true
    // 捕获到标签容器，移动越过按钮或窗口边缘仍能结束手势。
    elements.tabs.setPointerCapture(event.pointerId)
    elements.tabs.classList.add('sorting')
    const source = elements.tabs.querySelector(`[data-tab-key="${drag.key}"]`)
    if (source) {
      const rect = source.getBoundingClientRect()
      drag.ghost = source.cloneNode(true)
      drag.ghost.classList.add('tab-ghost')
      drag.ghost.setAttribute('aria-hidden', 'true')
      drag.ghost.tabIndex = -1
      drag.ghost.style.left = `${rect.left}px`
      drag.ghost.style.top = `${rect.top}px`
      drag.ghost.style.width = `${rect.width}px`
      drag.ghostLeft = rect.left
      // 起点以按下位置为准，即使首次 pointermove 跨过多个像素也保持抓取点一致。
      document.body.append(drag.ghost)
      source.classList.add('tab-dragging')
    }
    updateTabDrag()
  }
  if (drag.moved) event.preventDefault()
})
window.addEventListener('pointerup', event => {
  if (event.pointerId === tabPointer?.pointerId) {
    if (tabPointer.moved) finishTabDrag()
    else {
      // 单击在原按钮上完成激活；延迟重绘避免 pointerup 时替换 click 目标。
      tabPointer = null
      setTimeout(renderTabs, 0)
    }
  }
})
window.addEventListener('pointercancel', () => finishTabDrag(true))
window.addEventListener('blur', () => finishTabDrag(true))
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && tabPointer) {
    event.preventDefault()
    finishTabDrag(true)
  }
})
elements.tabs.addEventListener('click', event => {
  if (performance.now() < suppressTabClickUntil) {
    event.preventDefault()
    event.stopImmediatePropagation()
  }
}, true)
elements.close.addEventListener('click', () => closeActiveSession())
elements.sftpParent.addEventListener('click', () => {
  const remotePath = state.sftp?.path
  if (!remotePath || remotePath === '/') return
  const parentPath = remotePath.slice(0, remotePath.lastIndexOf('/')) || '/'
  refreshSftp(parentPath)
})
elements.sftpRefresh.addEventListener('click', () => refreshSftp())
elements.sftpUpload.addEventListener('click', uploadSftpFile)
elements.sftpMkdir.addEventListener('click', createSftpDirectory)
folderForm.addEventListener('submit', submitSftpDirectory)
document.querySelector('#folder-cancel').addEventListener('click', () => folderDialog.close())
document.querySelector('#folder-cancel-x').addEventListener('click', () => folderDialog.close())
document.querySelector('#sftp-path-form').addEventListener('submit', event => {
  event.preventDefault()
  const remotePath = elements.sftpPath.value.trim()
  if (!remotePath.startsWith('/')) return notify('请输入以 / 开头的完整目录路径', true)
  refreshSftp(remotePath)
})
profileSearch.addEventListener('input', renderProfiles)
profileSearch.addEventListener('search', renderProfiles)
bindSftpDropTarget(document.querySelector('.remote-pane'), () => state.sftp)
document.querySelector('#open-files').addEventListener('click', openFileWorkspace)
document.querySelector('#select-servers').addEventListener('click', showServerPicker)
document.querySelector('#empty-select-servers').addEventListener('click', showServerPicker)
document.querySelector('#servers-form').addEventListener('submit', connectSelectedServers)
document.querySelector('#servers-cancel').addEventListener('click', () => document.querySelector('#servers-dialog').close())
document.querySelector('#servers-cancel-x').addEventListener('click', () => document.querySelector('#servers-dialog').close())
document.querySelector('#local-home').addEventListener('click', () => loadLocalDirectory(null))
document.querySelector('#local-parent').addEventListener('click', () => loadLocalDirectory(localDirectory?.parentId))
document.querySelector('#local-refresh').addEventListener('click', () => loadLocalDirectory())
document.querySelector('#local-show-hidden').addEventListener('change', () => { localSelection.clear(); renderLocalFiles() })
document.querySelector('#local-select-all').addEventListener('change', event => {
  const files = visibleLocalFiles().filter(item => item.type === 'file')
  if (event.target.checked && files.length > 100) {
    event.target.checked = false
    return notify('一次最多选择 100 个文件，请手动选择', true)
  }
  localSelection.clear()
  if (event.target.checked) for (const entry of files) localSelection.add(entry.id)
  renderLocalFiles()
})
document.querySelector('#local-upload').addEventListener('click', () => uploadLocalSelection())
document.querySelector('#copy-target').addEventListener('change', showCopyDestination)
document.querySelector('#copy-form').addEventListener('submit', submitRemoteCopy)
document.querySelector('#copy-cancel').addEventListener('click', () => document.querySelector('#copy-dialog').close())
document.querySelector('#copy-cancel-x').addEventListener('click', () => document.querySelector('#copy-dialog').close())
document.querySelector('#notification-close').addEventListener('click', () => notification.classList.add('hidden'))
// 快捷键只在没有模态框时接管，避免打断口令或配置填写。
window.addEventListener('keydown', event => {
  if (!(event.metaKey || event.ctrlKey) || document.querySelector('dialog[open]')) return
  if (event.key.toLowerCase() === 'k') {
    event.preventDefault()
    profileSearch.focus()
    profileSearch.select()
  } else if (event.key.toLowerCase() === 'n') {
    event.preventDefault()
    openProfileDialog()
  }
})
elements.secretForm.addEventListener('submit', event => {
  event.preventDefault()
  if (elements.secretForm.reportValidity()) finishSftpSecret(true)
})
elements.cancelSecret.addEventListener('click', () => finishSftpSecret(false))
elements.cancelSecretX.addEventListener('click', () => finishSftpSecret(false))
elements.secretDialog.addEventListener('cancel', event => {
  event.preventDefault()
  finishSftpSecret(false)
})
api.sessions.onEvent(handleSessionEvent)

try {
  state.profiles = await api.profiles.list()
  renderProfiles()
  syncWorkspaceState()
} catch (error) {
  elements.profileList.textContent = `无法读取连接配置：${errorMessage(error)}`
}
