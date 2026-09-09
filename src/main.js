import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { version } from '../package.json'
import '@xterm/xterm/css/xterm.css'
import './style.css'
import { moveTab } from './tab-order.mjs'
import { groupProfiles } from './profile-groups.mjs'
import { connectBatch } from './connection-batch.mjs'
import { filterFiles, refreshedSelection, selectFileRange } from './file-browser.mjs'

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
  sftpConnecting: new Set(),
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
let localSelectionAnchor = null
// 大目录筛选会重复渲染，复用日期格式器避免每个文件都重新构造 Intl 实例。
const fileDateFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })

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
let folderConnection = null
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
      actions.querySelector('.sftp').disabled = state.sftpConnecting.has(profile.id)
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

/** 一组只启动一次批次；并发启动并复用已有终端，全部启动后只切换一次焦点。 */
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
    const ids = await connectBatch(group.profiles, async profile => {
      const existing = [...state.sessions.values()].find(item => item.profileId === profile.id && item.status === 'running')
      if (existing || state.connectingProfiles.has(profile.id)) {
        skipped++
        return existing?.id
      }
      const id = await connectProfile(profile.id, { activate: false, quiet: true })
      if (id) opened++
      else failed++
      return id
    })
    lastId = ids.filter(Boolean).at(-1)
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
  const terminalMount = document.createElement('div')
  terminalMount.className = 'ssh-terminal-mount hidden'
  const card = document.createElement('div')
  card.className = 'connection-card'
  const identity = document.createElement('div')
  identity.className = 'connection-identity'
  const icon = document.createElement('span')
  icon.className = 'connection-icon'
  icon.textContent = '▤'
  const details = document.createElement('div')
  const title = document.createElement('h2')
  title.textContent = profile.name
  const address = document.createElement('p')
  address.textContent = `SSH ${profile.username}@${profile.host}:${profile.port}`
  details.append(title, address)
  identity.append(icon, details)
  const progressRail = document.createElement('div')
  progressRail.className = 'connection-rail'
  const progressLabel = document.createElement('p')
  progressLabel.className = 'connection-phase'
  progressLabel.setAttribute('role', 'status')
  const actions = document.createElement('div')
  const logView = document.createElement('pre')
  logView.className = 'connection-diagnostics hidden'
  const logsButton = createButton('显示日志', 'ghost-button', () => {
    session.showLogs = !session.showLogs
    syncTerminalPresentation(session)
  })
  actions.append(logsButton, createButton('关闭连接', 'ghost-button danger', () => removeSession(session, true)))
  card.append(identity, progressRail, progressLabel, actions, logView)
  container.append(card, terminalMount)

  const session = {
    id: sessionId,
    profileId: profile.id,
    title: profile.name,
    status: 'running',
    terminal,
    fitAddon,
    container,
    terminalMount,
    card,
    progressRail,
    progressLabel,
    logView,
    logsButton,
    phase: 'connecting',
    connected: false,
    showLogs: false,
    opened: false,
    logs: '',
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

/** 进度来自本机 SSH 诊断；PTY 出现提示时显示交互区，确保口令/指纹确认不被遮挡。 */
function syncTerminalPresentation (session) {
  const labels = { connecting: '正在连接服务器…', retrying: `网络暂时异常，准备第 ${session.retryAttempt || 1}/2 次重试…`, verifying: '正在验证服务器身份…', authenticating: '正在验证登录身份…', connected: '连接成功', failed: '连接失败，请查看日志或重新连接' }
  session.progressLabel.textContent = session.status === 'exited' ? '连接已结束，请查看日志' : labels[session.phase]
  session.progressRail.classList.toggle('failed', session.phase === 'failed' || session.status === 'exited')
  session.card.classList.toggle('hidden', session.connected)
  session.logView.classList.toggle('hidden', !session.showLogs)
  session.logView.textContent = session.logs || '正在启动系统 SSH，等待诊断信息…'
  session.logsButton.textContent = session.showLogs ? '收起日志' : '显示日志'
  const visible = session.connected || session.showLogs
  const wasHidden = session.terminalMount.classList.contains('hidden')
  session.container.classList.toggle('connection-logs-open', !session.connected && session.showLogs)
  session.terminalMount.classList.toggle('hidden', !visible)
  if (visible && state.activeSessionId === session.id && !state.sftpActive) {
    if (!session.opened) {
      // 终端只在已挂载且可见时初始化，避免批量后台连接生成错误的字符尺寸。
      session.terminal.open(session.terminalMount)
      session.opened = true
    }
    if (wasHidden) session.terminal.focus()
    window.requestAnimationFrame(() => {
      if (state.activeSessionId !== session.id || state.sftpActive || session.terminalMount.classList.contains('hidden')) return
      session.fitAddon.fit()
      api.sessions.resize(session.id, session.terminal.cols, session.terminal.rows).catch(() => {})
    })
  }
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

let secretQueue = Promise.resolve()

/** 并发连接仅把必须的凭据对话框排队，避免互相覆盖或把其他主机的口令串用。 */
function requestSftpSecret (profile) {
  const result = secretQueue.then(() => showSftpSecret(profile))
  secretQueue = result.then(() => {}, () => {})
  return result
}

/** 仅在密码登录或主进程明确检测到加密私钥时收集凭据，关闭即清空输入框。 */
function showSftpSecret (profile) {
  elements.secretForm.reset()
  const usesPassword = profile.auth === 'password'
  elements.secretTitle.textContent = `连接 ${profile.name}`
  elements.secretLabel.textContent = usesPassword ? '登录密码' : '加密私钥口令'
  elements.secretNote.textContent = usesPassword
    ? '密码只用于本次 SFTP 连接，不会保存。'
    : '该私钥已加密，需要口令解锁。口令只用于本次连接，不会保存。'
  elements.secretInput.required = true
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

/** 每个文件栏独立调整宽度；只改布局，不触发目录读取或传输。 */
function addPaneResize (pane) {
  const handle = document.createElement('div')
  handle.className = 'pane-resize'
  handle.tabIndex = 0
  handle.setAttribute('role', 'separator')
  handle.setAttribute('aria-orientation', 'vertical')
  handle.setAttribute('aria-label', '调整文件栏宽度')
  handle.setAttribute('aria-valuemin', '360')
  handle.setAttribute('aria-valuemax', '1100')
  handle.setAttribute('aria-valuenow', '560')
  let start = null
  const setWidth = width => {
    const bounded = Math.max(360, Math.min(1100, width))
    pane.style.width = `${bounded}px`
    handle.setAttribute('aria-valuenow', String(Math.round(bounded)))
  }
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0) return
    event.preventDefault()
    start = { x: event.clientX, width: pane.getBoundingClientRect().width, pointerId: event.pointerId }
    handle.setPointerCapture(event.pointerId)
    pane.classList.add('resizing')
  })
  handle.addEventListener('pointermove', event => {
    if (start?.pointerId === event.pointerId) setWidth(start.width + event.clientX - start.x)
  })
  const finish = event => {
    if (start?.pointerId !== event.pointerId) return
    start = null
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId)
    pane.classList.remove('resizing')
  }
  handle.addEventListener('pointerup', finish)
  handle.addEventListener('pointercancel', finish)
  handle.addEventListener('dblclick', () => setWidth(560))
  handle.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
    event.preventDefault()
    setWidth(pane.getBoundingClientRect().width + (event.key === 'ArrowRight' ? 30 : -30))
  })
  pane.append(handle)
}

/** 每个连接创建自己的 DOM 与事件闭包，所有按钮始终操作所属服务器。 */
function createRemotePane (connection) {
  const pane = document.querySelector('#remote-pane-template').content.firstElementChild.cloneNode(true)
  const ui = { pane }
  for (const node of pane.querySelectorAll('[data-role]')) ui[node.dataset.role] = node
  connection.ui = ui
  const name = connection.title.replace(/ · SFTP$/u, '')
  pane.setAttribute('aria-label', `${name} 文件栏`)
  ui.title.textContent = name
  ui.title.title = name
  ui.selected.setAttribute('aria-label', `上传目标 ${name}`)
  ui.path.setAttribute('aria-label', `${name} 远程目录路径`)
  ui.filter.setAttribute('aria-label', `筛选 ${name} 文件`)
  // 过滤只重绘本栏的元数据，不触发 SFTP 请求或改变其他栏的输入。
  ui.filter.addEventListener('input', () => renderSftpFiles(connection))
  ui.filter.addEventListener('search', () => renderSftpFiles(connection))
  ui.showHidden.addEventListener('change', () => renderSftpFiles(connection))
  ui.parent.addEventListener('click', () => refreshSftp(connection.path.slice(0, connection.path.lastIndexOf('/')) || '/', connection))
  ui.refresh.addEventListener('click', () => refreshSftp(connection.path, connection))
  ui.upload.addEventListener('click', () => uploadSftpFile(connection))
  ui.mkdir.addEventListener('click', () => createSftpDirectory(connection))
  ui.close.addEventListener('click', () => closeSftp(connection))
  ui.retry.addEventListener('click', () => connectSftp(connection.profileId, { activate: false, connection }))
  ui.pathForm.addEventListener('submit', event => {
    event.preventDefault()
    const remotePath = ui.path.value.trim()
    if (!remotePath.startsWith('/')) return notify('请输入以 / 开头的完整目录路径', true)
    refreshSftp(remotePath, connection)
  })
  ui.selected.addEventListener('change', () => {
    if (ui.selected.checked) uploadTargets.add(connection.connectionId)
    else uploadTargets.delete(connection.connectionId)
    syncLocalActions()
  })
  pane.addEventListener('pointerdown', event => {
    // 关闭其他文件栏不应先把它激活；否则关闭动作会间接改变当前标签。
    if (event.target.closest('[data-role="close"]')) return
    state.sftp = connection
    state.activeSessionId = null
    state.sftpActive = true
    renderRemoteChoices()
    renderTabs()
    syncWorkspaceState()
  })
  bindSftpDropTarget(pane, () => connection)
  addPaneResize(pane)
  document.querySelector('.file-columns').insertBefore(pane, document.querySelector('#add-server-pane'))
}

/** 每台服务器独立记录操作状态，切换标签不丢失传输反馈。 */
function setSftpBusy (busy, message = '', connection = state.sftp, resetTransfer = false) {
  if (!connection) return
  connection.busy = busy
  connection.operation = message
  // 浏览目录不抹掉刚完成的上传结果；只有用户开始新上传才重置进度。
  if (resetTransfer) {
    connection.transfer = null
    connection.ui?.transfer.classList.add('hidden')
  }
  if (connection === state.sftp) state.sftpBusy = busy
  const ui = connection.ui
  if (!ui) return
  ui.pane.setAttribute('aria-busy', String(busy))
  ui.footer.classList.toggle('busy', busy)
  ui.operation.textContent = busy ? message : '拖入文件上传 · 横向滚动查看信息'
  const unavailable = connection.status !== 'ready'
  for (const button of [ui.parent, ui.refresh, ui.mkdir, ui.upload, ui.pathForm.querySelector('button')]) button.disabled = busy || unavailable
  ui.close.disabled = busy && !unavailable
  for (const button of ui.list.querySelectorAll('button')) button.disabled = busy
  ui.path.disabled = busy || unavailable
}

/** 进度事件只更新对应文件栏，绝不重建标签或滚动当前视图。 */
function handleUploadProgress (progress) {
  const connection = state.sftpConnections.get(progress?.connectionId)
  if (!connection?.ui || !connection.busy || !Number.isFinite(progress.total) || !Number.isFinite(progress.transferred)) return
  connection.transfer = progress
  const { ui } = connection
  const percent = progress.phase === 'completed' ? 100 : Math.min(99, Math.floor(progress.transferred * 100 / Math.max(1, progress.total)))
  const label = progress.phase === 'completed' ? '已完成' : progress.phase === 'failed' ? '上传失败' : progress.phase === 'finalizing' ? '正在确认文件…' : `${percent}%`
  ui.transfer.classList.remove('hidden')
  ui.transfer.classList.toggle('failed', progress.phase === 'failed')
  ui.progress.value = percent
  ui.transferLabel.textContent = `${progress.fileIndex}/${progress.fileCount} · ${progress.name} · ${label} · ${formatFileSize(progress.transferred)} / ${formatFileSize(progress.total)}${progress.phase === 'uploading' ? ` · ${formatFileSize(progress.bytesPerSecond)}/s` : ''}`
}

function renderSftpFiles (connection = state.sftp) {
  if (!connection?.ui || !state.sftpConnections.has(connection.connectionId)) return
  const ui = connection.ui
  const table = ui.pane.querySelector('.sftp-table-wrap')
  const scrollTop = table.scrollTop
  const scrollLeft = table.scrollLeft
  ui.list.replaceChildren()
  // 筛选/后台刷新不能覆盖用户尚未提交的路径输入。
  if (document.activeElement !== ui.path) ui.path.value = connection.path
  ui.path.title = connection.path
  const profile = profileById(connection.profileId)
  ui.target.textContent = profile ? `${profile.username}@${profile.host}` : connection.title
  const ready = connection.status === 'ready'
  ui.filter.disabled = !ready
  ui.showHidden.disabled = !ready
  ui.connectionState.classList.toggle('hidden', ready)
  ui.connectionState.classList.toggle('connecting', ['queued', 'connecting'].includes(connection.status))
  ui.connectionState.classList.toggle('failed', connection.status === 'failed')
  ui.connectionLabel.textContent = connection.status === 'queued' ? '等待连接…' : connection.status === 'connecting' ? '正在连接服务器… 网络异常时自动重试' : connection.error || '连接失败'
  ui.retry.classList.toggle('hidden', connection.status !== 'failed')
  ui.pane.querySelector('.sftp-table-wrap').classList.toggle('hidden', !ready)
  if (!ready) {
    ui.count.textContent = ''
    return
  }
  const entries = filterFiles(connection.entries, ui.filter.value, ui.showHidden.checked)
  ui.count.textContent = `${entries.length}${entries.length !== connection.entries.length ? ` / ${connection.entries.length}` : ''} 个项目`
  ui.parent.disabled = connection.busy || connection.path === '/'

  if (entries.length === 0) {
    ui.message.textContent = connection.entries.length ? '没有匹配的文件，请调整筛选条件' : '这个目录是空的'
    ui.message.classList.remove('hidden')
    table.scrollLeft = scrollLeft
    return
  }
  ui.message.classList.add('hidden')

  for (const entry of entries) {
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
      () => entry.type === 'directory' ? refreshSftp(remotePath, connection) : downloadSftpFile(remotePath, connection),
      entry.type === 'directory' ? `打开文件夹 ${entry.name}` : `下载 ${entry.name}`
    ))
    nameCell.firstChild.title = entry.name

    const sizeCell = document.createElement('td')
    sizeCell.className = 'sftp-meta'
    sizeCell.textContent = entry.type === 'directory' ? '—' : formatFileSize(entry.size)
    const modifiedCell = document.createElement('td')
    modifiedCell.className = 'sftp-meta'
    modifiedCell.textContent = entry.modifiedAt
      ? fileDateFormat.format(new Date(entry.modifiedAt))
      : '—'
    const actionCell = document.createElement('td')
    actionCell.className = 'sftp-row-actions'
    if (entry.type !== 'directory') {
      actionCell.append(createButton('下载', 'text-button', () => downloadSftpFile(remotePath, connection), `下载 ${entry.name}`))
    }
    if (entry.type === 'file') {
      actionCell.append(createButton('复制到…', 'text-button', () => openCopyDialog({ connection, path: remotePath, name: entry.name }), `复制 ${entry.name} 到其他服务器`))
    }
    actionCell.append(createButton('删除', 'text-button delete', () => removeSftpEntry(remotePath, connection), `删除 ${entry.name}`))
    row.append(nameCell, sizeCell, modifiedCell, actionCell)
    ui.list.append(row)
  }
  if (connection.busy) for (const button of ui.list.querySelectorAll('button')) button.disabled = true
  table.scrollTop = scrollTop
  table.scrollLeft = scrollLeft
}

/** 先按用户选择顺序创建占位文件栏，队列外的服务器也立即可见。 */
function prepareSftp (profileId) {
  const existing = [...state.sftpConnections.values()].find(connection => connection.profileId === profileId)
  if (existing) return existing
  const profile = profileById(profileId)
  if (!profile) return null
  const connection = { profileId, title: `${profile.name} · SFTP`, connectionId: `pending:${profileId}`, status: 'queued', path: '', entries: [], busy: false, operation: '' }
  state.sftpConnections.set(connection.connectionId, connection)
  state.filesOpen = true
  createRemotePane(connection)
  setSftpBusy(false, '', connection)
  renderSftpFiles(connection)
  renderTabs()
  renderRemoteChoices()
  return connection
}

/** 连接完成仅原位替换占位数据；关闭后的晚到结果必须释放，不重新插入窗口。 */
async function connectSftp (profileId, { activate = true, quiet = false, connection = null } = {}) {
  const profile = profileById(profileId)
  if (!profile || state.sftpConnecting.has(profileId)) return
  connection ??= prepareSftp(profileId)
  if (!connection || !state.sftpConnections.has(connection.connectionId)) return
  if (activate) activateSftp(connection.connectionId)
  if (connection.status === 'ready') return connection.connectionId

  connection.status = 'connecting'
  connection.error = ''
  renderSftpFiles(connection)
  renderTabs()
  syncWorkspaceState()
  state.sftpConnecting.add(profileId)
  renderProfiles()
  let credential
  try {
    credential = profile.auth === 'password' ? await requestSftpSecret(profile) : { accepted: true, secret: '' }
    if (!credential.accepted) throw new Error('已取消连接')
    if (!state.sftpConnections.has(connection.connectionId)) return
    if (!quiet) notify(`正在连接 ${profile.name} 的文件服务，临时网络异常将自动重试…`)
    // 私钥是否加密由主进程读取配置文件判定，界面不接触私钥内容。
    let result = await api.sftp.connect(profileId, credential.secret)
    if (result.needsSecret) {
      if (!state.sftpConnections.has(connection.connectionId)) return
      credential = await requestSftpSecret(profile)
      if (!credential.accepted) throw new Error('已取消连接')
      if (!state.sftpConnections.has(connection.connectionId)) return
      result = await api.sftp.connect(profileId, credential.secret)
    }
    if (!state.sftpConnections.has(connection.connectionId)) {
      await api.sftp.close(result.connectionId).catch(() => {})
      return
    }
    const previousId = connection.connectionId
    Object.assign(connection, result, { status: 'ready' })
    // 保留 Map、DOM 和用户拖动后的标签顺序，不按网络完成顺序重新追加。
    state.sftpConnections = new Map([...state.sftpConnections].map(([id, item]) => [id === previousId ? result.connectionId : id, item]))
    tabOrder = tabOrder.map(key => key === `sftp:${previousId}` ? `sftp:${result.connectionId}` : key)
    uploadTargets.add(result.connectionId)
    setSftpBusy(false, '', connection)
    renderSftpFiles(connection)
    renderTabs()
    renderRemoteChoices()
    syncWorkspaceState()
    if (!quiet) notify('文件服务已连接')
    return result.connectionId
  } catch (error) {
    if (state.sftpConnections.has(connection.connectionId)) {
      connection.status = 'failed'
      connection.error = errorMessage(error)
      setSftpBusy(false, '', connection)
      renderSftpFiles(connection)
      renderTabs()
      syncWorkspaceState()
      if (!quiet) notify(`${profile.name}：${errorMessage(error)}`, true)
    }
  } finally {
    if (credential) credential.secret = ''
    state.sftpConnecting.delete(profileId)
    renderProfiles()
  }
}

async function refreshSftpAfterOperation (connection) {
  const result = await api.sftp.list(connection.connectionId, connection.path)
  if (!state.sftpConnections.has(connection.connectionId)) return
  connection.path = result.path
  connection.entries = result.entries
}

async function refreshSftp (remotePath = state.sftp?.path, connection = state.sftp) {
  if (!connection || connection.busy || !remotePath) return
  setSftpBusy(true, '正在读取目录…', connection)
  try {
    const result = await api.sftp.list(connection.connectionId, remotePath)
    if (!state.sftpConnections.has(connection.connectionId)) return
    if (connection.path !== result.path) {
      // 新目录从头浏览；仅刷新当前目录则保留筛选和滚动位置。
      connection.ui.filter.value = ''
      connection.ui.pane.querySelector('.sftp-table-wrap').scrollTop = 0
    }
    connection.path = result.path
    connection.ui.path.value = result.path
    connection.entries = result.entries
  } catch (error) {
    notify(errorMessage(error), true)
  } finally {
    setSftpBusy(false, '', connection)
    renderSftpFiles(connection)
  }
}

async function uploadSftpFile (connection = state.sftp) {
  if (!connection || connection.busy) return
  setSftpBusy(true, '正在上传文件…', connection, true)
  try {
    const result = await api.sftp.upload(connection.connectionId, connection.path)
    if (!result.canceled) await refreshSftpAfterOperation(connection)
    if (!result.canceled) notify('上传完成')
  } catch (error) {
    notify(errorMessage(error), true)
  } finally {
    setSftpBusy(false, '', connection)
    renderSftpFiles(connection)
  }
}

async function downloadSftpFile (remotePath, connection = state.sftp) {
  if (!connection || connection.busy) return
  setSftpBusy(true, '正在下载文件…', connection)
  try {
    const result = await api.sftp.download(connection.connectionId, remotePath)
    if (!result.canceled) notify('文件已保存到所选位置')
  } catch (error) {
    notify(errorMessage(error), true)
  } finally {
    setSftpBusy(false, '', connection)
    renderSftpFiles(connection)
  }
}

/** 使用应用内表单收集名称，Electron 不支持 window.prompt。 */
function createSftpDirectory (connection = state.sftp) {
  if (!connection || connection.busy) return
  folderConnection = connection
  folderForm.reset()
  folderError.textContent = ''
  folderDialog.showModal()
  folderName.focus()
}

/** 创建成功才关闭弹窗；失败保留名称，便于修正后重试。 */
async function submitSftpDirectory (event) {
  event.preventDefault()
  const connection = folderConnection
  if (!connection || connection.busy || !state.sftpConnections.has(connection.connectionId)) return
  const name = folderName.value.trim()
  if (!name || name === '.' || name === '..' || name.includes('/')) {
    folderError.textContent = '请输入有效名称，不能包含 / 或仅为 .、..'
    return
  }
  const submit = folderForm.querySelector('[type="submit"]')
  submit.disabled = true
  folderError.textContent = ''
  setSftpBusy(true, '正在新建文件夹…', connection)
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
    renderSftpFiles(connection)
  }
}

async function removeSftpEntry (remotePath, connection = state.sftp) {
  if (!connection || connection.busy) return
  setSftpBusy(true, '等待删除确认…', connection)
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
    renderSftpFiles(connection)
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
  document.querySelector('.local-pane').scrollIntoView({ block: 'nearest', inline: 'start', behavior: 'smooth' })
  if (!localDirectory) loadLocalDirectory(null)
}

/** 导航只使用目录令牌；同目录刷新以新令牌恢复选择，跨目录清空筛选与选择。 */
async function loadLocalDirectory (id = localDirectory?.id ?? null) {
  if (localLoading || localUploading) return
  localLoading = true
  document.querySelector('#local-message').textContent = '正在读取本机目录…'
  syncLocalActions()
  try {
    const result = await api.local.list(id)
    const selection = refreshedSelection(localDirectory, result, localSelection)
    if (localDirectory?.path !== result.path) {
      document.querySelector('#local-filter').value = ''
      document.querySelector('.local-pane .sftp-table-wrap').scrollTop = 0
    }
    localDirectory = result
    localSelection.clear()
    for (const value of selection) localSelection.add(value)
    localSelectionAnchor = null
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
  return filterFiles(localDirectory?.entries ?? [], document.querySelector('#local-filter').value, document.querySelector('#local-show-hidden').checked)
}

/** 更新勾选而不销毁行 DOM，保留焦点、滚动和拖拽起点。 */
function chooseLocalFile (id, checked, extend = false) {
  if (localLoading || localUploading) return
  const selection = selectFileRange(visibleLocalFiles(), localSelection, localSelectionAnchor, id, checked, extend)
  if (selection === localSelection) notify('一次最多选择 100 个文件', true)
  else {
    localSelection.clear()
    for (const value of selection) localSelection.add(value)
    localSelectionAnchor = id
  }
  syncLocalActions()
}

/** 渲染本地元数据，选择与拖放只携带文件令牌，不传递路径给上传接口。 */
function renderLocalFiles () {
  const list = document.querySelector('#local-file-list')
  const table = document.querySelector('.local-pane .sftp-table-wrap')
  const scrollTop = table.scrollTop
  const scrollLeft = table.scrollLeft
  list.replaceChildren()
  if (!localDirectory) return
  document.querySelector('#local-path').textContent = localDirectory.path
  document.querySelector('#local-path').title = localDirectory.path
  const entries = visibleLocalFiles()
  for (const entry of entries) {
    const row = document.createElement('tr')
    row.dataset.fileId = entry.id
    const choice = document.createElement('td')
    if (entry.type === 'file') {
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.checked = localSelection.has(entry.id)
      checkbox.setAttribute('aria-label', `选择本地文件 ${entry.name}`)
      checkbox.addEventListener('click', event => chooseLocalFile(entry.id, checkbox.checked, event.shiftKey))
      choice.append(checkbox)
      row.draggable = true
      row.addEventListener('dragstart', event => {
        if (localUploading || localLoading) return event.preventDefault()
        draggedLocalIds = localSelection.has(entry.id) ? [...localSelection] : [entry.id]
        event.dataTransfer.setData('application/x-serverlink-local-files', entry.name)
        event.dataTransfer.effectAllowed = 'copy'
      })
      row.addEventListener('dragend', () => { draggedLocalIds = null })
    }
    const name = document.createElement('td')
    const button = createButton(`${entry.type === 'directory' ? '▸' : '·'} ${entry.name}`, 'sftp-name', () => {}, entry.name)
    button.title = `${entry.name} · ${entry.modifiedAt}`
    button.disabled = !['directory', 'file'].includes(entry.type)
    if (entry.type === 'file') {
      // 点击名称即可勾选；不像远端下载，不启动外部应用或执行文件。
      button.addEventListener('click', event => chooseLocalFile(entry.id, !localSelection.has(entry.id), event.shiftKey))
    }
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
    const modified = document.createElement('td')
    modified.textContent = entry.modifiedAt ? fileDateFormat.format(new Date(entry.modifiedAt)) : '—'
    row.append(choice, name, size, kind, modified)
    list.append(row)
  }
  document.querySelector('#local-message').textContent = entries.length ? '' : localDirectory.entries.length ? '没有匹配的文件，请调整筛选条件' : '此目录为空'
  table.scrollTop = scrollTop
  table.scrollLeft = scrollLeft
  syncLocalActions()
}

function syncLocalActions () {
  const busy = localLoading || localUploading
  document.querySelector('#local-parent').disabled = busy || !localDirectory?.parentId
  document.querySelector('#local-home').disabled = busy
  document.querySelector('#local-refresh').disabled = busy
  document.querySelector('#local-show-hidden').disabled = busy
  for (const row of document.querySelectorAll('#local-file-list tr')) {
    const checkbox = row.querySelector('input')
    if (checkbox) { checkbox.disabled = busy; checkbox.checked = localSelection.has(row.dataset.fileId) }
    row.classList.toggle('file-selected', localSelection.has(row.dataset.fileId))
  }
  const selectAll = document.querySelector('#local-select-all')
  const files = visibleLocalFiles().filter(entry => entry.type === 'file')
  selectAll.disabled = busy || !files.length
  selectAll.checked = files.length > 0 && files.every(entry => localSelection.has(entry.id))
  selectAll.indeterminate = files.some(entry => localSelection.has(entry.id)) && !selectAll.checked
  const button = document.querySelector('#local-upload')
  button.disabled = busy || !localSelection.size || !uploadTargets.size
  button.textContent = localUploading ? '正在上传…' : `上传所选${localSelection.size ? ` ${localSelection.size}` : ''}`
  const visibleSelected = files.filter(entry => localSelection.has(entry.id)).length
  document.querySelector('#local-count').textContent = `已选 ${localSelection.size} 个${localSelection.size > visibleSelected ? `（${localSelection.size - visibleSelected} 个在筛选外）` : ''} · ${uploadTargets.size} 台目标`
}

/** 同步各文件栏的目标勾选与高亮，不重建目录内容或改变其他服务器的选择。 */
function renderRemoteChoices () {
  for (const connection of state.sftpConnections.values()) {
    if (!connection.ui) continue
    connection.ui.selected.checked = uploadTargets.has(connection.connectionId)
    connection.ui.selected.disabled = localUploading || connection.status !== 'ready'
    connection.ui.pane.classList.toggle('active-pane', state.sftp === connection)
  }
  syncLocalActions()
}

function showServerPicker () {
  if (state.sftpConnecting.size || selectingServers || localUploading) return notify('正在连接或传输，请稍候')
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

/** 先展示全部占位，再四路并发；完成只更新上传目标，不改变当前文件栏和滚动位置。 */
async function connectSelectedServers (event) {
  event.preventDefault()
  const ids = [...document.querySelectorAll('#server-options input:checked')].map(input => input.value)
  if (!ids.length || ids.length > 20) return notify('请选择 1～20 台服务器', true)
  document.querySelector('#servers-dialog').close()
  selectingServers = true
  try {
    notify(`正在并发连接 ${ids.length} 台服务器，临时网络异常将自动重试…`)
    const connections = ids.map(prepareSftp).filter(Boolean)
    const results = await connectBatch(connections, connection => connectSftp(connection.profileId, { activate: false, quiet: true, connection }))
    const selected = new Set(results.filter(id => id && state.sftpConnections.has(id)))
    uploadTargets.clear()
    for (const id of selected) uploadTargets.add(id)
    renderRemoteChoices()
    // 失败摘要保留到用户关闭，避免多台连接时只看到一闪而过的成功数量。
    notify(`已选择 ${selected.size} 台上传目标${ids.length > selected.size ? `，${ids.length - selected.size} 台未连接，可在对应栏重试` : ''}`, ids.length > selected.size)
  } finally {
    selectingServers = false
  }
}

/** 一次上传到勾选的多个目录，主进程逐项返回结果，失败不回滚已成功的文件。 */
async function uploadLocalSelection (targets = [...state.sftpConnections.values()].filter(item => uploadTargets.has(item.connectionId)), fileIds = [...localSelection]) {
  if (localUploading || !targets.length || !fileIds.length) return
  if (targets.some(item => item.busy || item.status !== 'ready')) return notify('有目标服务器尚未就绪或正在操作，请稍后上传', true)
  localUploading = true
  syncLocalActions()
  renderRemoteChoices()
  const resultBox = document.querySelector('#transfer-results')
  resultBox.classList.remove('hidden')
  resultBox.textContent = `正在将 ${fileIds.length} 个文件上传到 ${targets.length} 台服务器…`
  for (const target of targets) setSftpBusy(true, `接收本地 ${fileIds.length} 个文件…`, target, true)
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
    for (const connection of state.sftpConnections.values()) renderSftpFiles(connection)
  }
}

/** 恢复每个 SFTP 标签自己的目录及传输状态。 */
function activateSftp (connectionId = state.sftp?.connectionId, { scroll = true } = {}) {
  const connection = state.sftpConnections.get(connectionId)
  if (!connection) return
  state.sftp = connection
  state.filesOpen = true
  state.sftpActive = true
  state.activeSessionId = null
  renderTabs()
  syncWorkspaceState()
  renderSftpFiles()
  renderRemoteChoices()
  if (scroll) connection.ui.pane.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  if (!localDirectory) loadLocalDirectory(null)
}

/** 关闭非当前栏不改选择；关闭当前栏选相邻栏，保留仍可见栏的位置，不跳到末尾。 */
async function closeSftp (connection = state.sftp) {
  if (!connection) return
  if (connection.busy) return notify('请等待当前文件操作完成后再关闭')
  const wasActive = state.sftp === connection
  const columns = document.querySelector('.file-columns')
  const panes = [...columns.querySelectorAll('.file-pane')]
  const left = columns.getBoundingClientRect().left
  const anchor = panes.find(pane => pane !== connection.ui.pane && pane.getBoundingClientRect().right > left)
  const anchorLeft = anchor?.getBoundingClientRect().left
  const connections = [...state.sftpConnections.values()]
  const index = connections.indexOf(connection)
  const neighbor = connections[index + 1] ?? connections[index - 1]
  state.sftpConnections.delete(connection.connectionId)
  uploadTargets.delete(connection.connectionId)
  connection.ui?.pane.remove()
  if (wasActive) {
    state.sftp = neighbor ?? null
  }
  renderTabs()
  renderRemoteChoices()
  syncWorkspaceState()
  if (anchor) columns.scrollTo({ left: columns.scrollLeft + anchor.getBoundingClientRect().left - anchorLeft, behavior: 'instant' })
  // 先更新视图再跨进程关闭，避免等待期间用户切换标签后被旧回调抢走焦点。
  if (connection.status === 'ready') await api.sftp.close(connection.connectionId).catch(() => {})
  else await api.sftp.cancelConnect(connection.profileId).catch(() => {})
}

/** 本地多文件拖放逐项反馈结果；标签切换后仍刷新原来的目标目录。 */
async function uploadDroppedFiles (connection, files) {
  if (!connection || connection.busy || connection.status !== 'ready') return notify('目标服务器尚未就绪或正在执行文件操作，请稍后再试')
  if (!files.length || files.length > 100) return notify('请一次拖入 1～100 个普通文件', true)
  setSftpBusy(true, `正在上传 ${files.length} 个文件…`, connection, true)
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
    renderSftpFiles(connection)
  }
}

/** 文件面板和服务器标签共用拖放语义，内部拖拽只读当前窗口记录。 */
function bindSftpDropTarget (target, getConnection) {
  target.addEventListener('dragover', event => {
    if (!isFileDrag(event) && !state.draggedRemote && !draggedLocalIds) return
    event.preventDefault()
    const connection = getConnection()
    const allowed = connection && connection.status === 'ready' && !connection.busy && (!state.draggedRemote || state.draggedRemote.connection !== connection)
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
  const destinations = [...state.sftpConnections.values()].filter(item => item !== source.connection && item.status === 'ready' && !item.busy)
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
    for (const connection of state.sftpConnections.values()) renderSftpFiles(connection)
  }
}

/** 渲染期间保留统一顺序；拖动时延后状态重绘，避免销毁指针捕获节点。 */
function renderTabs () {
  if (tabPointer) return
  const scrollLeft = elements.tabs.scrollLeft
  let focusedKey = elements.tabs.contains(document.activeElement) ? document.activeElement.closest('[data-tab-key]')?.dataset.tabKey : null
  // 握手完成会更换占位 ID；键盘焦点仍属于同一台服务器，而不是新完成的标签。
  if (focusedKey?.startsWith('sftp:pending:')) {
    const connection = [...state.sftpConnections.values()].find(item => item.profileId === focusedKey.slice('sftp:pending:'.length))
    if (connection) focusedKey = `sftp:${connection.connectionId}`
  }
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
    label.textContent = `${connection.title}${connection.status === 'ready' ? '' : connection.status === 'failed' ? ' · 失败' : ' · 连接中'}`
    tab.replaceChildren(label)
    tab.setAttribute('role', 'tab')
    const active = state.sftpActive && state.sftp === connection
    tab.setAttribute('aria-selected', String(active))
    tab.classList.toggle('active', active)
    bindSftpDropTarget(tab, () => connection)
    const dot = document.createElement('span')
    dot.className = `tab-dot ${connection.status === 'ready' ? 'running' : connection.status === 'failed' ? 'exited' : 'connecting'}`
    tab.prepend(dot)
    elements.tabs.append(tab)
  }
  const nodes = new Map([...elements.tabs.children].map(tab => [tab.dataset.tabKey, tab]))
  tabOrder = tabOrder.filter(key => nodes.has(key))
  for (const key of nodes.keys()) if (!tabOrder.includes(key)) tabOrder.push(key)
  for (const key of tabOrder) elements.tabs.append(nodes.get(key))
  elements.tabs.scrollLeft = scrollLeft
  // 只恢复原本位于标签栏的焦点，后台状态刷新不能抢终端输入或改变横向位置。
  if (focusedKey) nodes.get(focusedKey)?.focus({ preventScroll: true })
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
  syncTerminalPresentation(session)
  window.requestAnimationFrame(() => {
    // SFTP 切换或关闭标签后，旧帧不能重新聚焦隐藏终端或发送错误尺寸。
    if (state.sftpActive || state.activeSessionId !== sessionId || !state.sessions.has(sessionId) || !session.opened || session.terminalMount.classList.contains('hidden')) return
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
  elements.reconnect.disabled = !session
  elements.close.disabled = !hasView
  elements.close.classList.toggle('hidden', !hasView)
  elements.reconnect.classList.toggle('hidden', !session)

  if (state.sftpActive && state.sftp) {
    elements.sessionStatus.textContent = state.sftp.status === 'ready' ? 'SFTP 已连接' : state.sftp.status === 'failed' ? 'SFTP 连接失败' : 'SFTP 连接中'
    elements.sessionStatus.className = 'status-pill running'
    return
  }
  if (!session) {
    elements.sessionStatus.textContent = state.sftpActive ? '本机文件' : '未连接'
    elements.sessionStatus.className = 'status-pill'
    return
  }
  const labels = { running: session.connected ? '已连接' : '连接中', exited: '已断开', closing: '关闭中' }
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
    if (!session.connected && !session.showLogs) {
      session.showLogs = true
      syncTerminalPresentation(session)
    }
    // 终端输出不改变标签状态，避免高频输出重建标签、打断点击及排序。
    return
  } else if (payload.type === 'progress') {
    if (!['connecting', 'retrying', 'verifying', 'authenticating', 'connected', 'failed'].includes(payload.phase)) return
    session.phase = payload.phase
    session.retryAttempt = payload.attempt
    session.logs = typeof payload.logs === 'string' ? payload.logs.slice(-16000) : ''
    if (payload.phase === 'connected') session.connected = true
    syncTerminalPresentation(session)
  } else if (payload.type === 'status' && payload.status === 'running') {
    session.status = 'running'
  } else if (payload.type === 'exit') {
    session.status = 'exited'
    session.terminal.writeln(`\r\n\x1b[90m[连接已结束，退出码 ${payload.exitCode ?? '未知'}]\x1b[0m`)
    syncTerminalPresentation(session)
  }
  renderTabs()
  syncWorkspaceState()
}

/** 重连原位替换标签；创建失败保留旧终端，等待期间用户的切换或关闭优先。 */
async function reconnectActiveSession () {
  const session = state.sessions.get(state.activeSessionId)
  if (!session) return
  // 先建立替代终端但不激活，避免启动失败就丢失旧终端内容。
  const replacementId = await connectProfile(session.profileId, { activate: false })
  const replacement = state.sessions.get(replacementId)
  if (!replacement) return
  if (state.sessions.get(session.id) !== session) {
    // 用户已关闭原标签，晚到的新 PTY 也必须释放，不能重新出现。
    await removeSession(replacement, true)
    return
  }
  const oldKey = `ssh:${session.id}`
  const newKey = `ssh:${replacementId}`
  tabOrder = tabOrder.filter(key => key !== newKey).map(key => key === oldKey ? newKey : key)
  if (!state.sftpActive && state.activeSessionId === session.id) activateSession(replacementId)
  await removeSession(session, true)
}

/** 关闭立即更新界面；只替换当前标签，原生进程稍后退出不能抢回用户的新选择。 */
async function removeSession (session, requestClose) {
  if (state.sessions.get(session.id) !== session) return
  const wasActive = !state.sftpActive && state.activeSessionId === session.id
  const shouldClose = requestClose && session.status !== 'exited'
  session.inputDisposable?.dispose()
  session.terminal.dispose()
  session.container.remove()
  state.sessions.delete(session.id)
  state.pendingEvents.delete(session.id)
  state.retiredSessionIds.add(session.id)
  // 原生关闭可能延迟 1.5 秒，先留墓碑丢弃晚到事件，避免重新创建已关闭会话的缓冲。
  setTimeout(() => state.retiredSessionIds.delete(session.id), 10000)

  if (state.activeSessionId === session.id) state.activeSessionId = null
  if (wasActive) {
    // 相邻关系来自用户拖动后的混合标签顺序，不使用 SSH Map 的创建顺序。
    const index = tabOrder.indexOf(`ssh:${session.id}`)
    const neighbor = [...tabOrder.slice(index + 1), ...tabOrder.slice(0, index).reverse()].find(key => {
      if (key === 'files:local') return state.filesOpen
      if (key.startsWith('ssh:')) return state.sessions.has(key.slice(4))
      return key.startsWith('sftp:') && state.sftpConnections.has(key.slice(5))
    })
    if (neighbor === 'files:local') openFileWorkspace()
    else if (neighbor?.startsWith('ssh:')) activateSession(neighbor.slice(4))
    else if (neighbor?.startsWith('sftp:')) activateSftp(neighbor.slice(5))
  }
  renderTabs()
  syncWorkspaceState()
  // 视图与事件归属先完成清理，再跨进程结束 PTY；等待期间用户可继续切换和输入。
  if (shouldClose) await api.sessions.close(session.id).catch(() => {})
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
    if (state.sftp?.busy) return notify('请等待当前文件操作完成后再关闭')
    await closeSftp()
    return
  }
  const session = state.sessions.get(state.activeSessionId)
  if (session) await removeSession(session, true)
}

const resizeObserver = new window.ResizeObserver(() => {
  const session = state.sessions.get(state.activeSessionId)
  if (!session?.opened || session.terminalMount.classList.contains('hidden')) return
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
folderForm.addEventListener('submit', submitSftpDirectory)
document.querySelector('#folder-cancel').addEventListener('click', () => folderDialog.close())
document.querySelector('#folder-cancel-x').addEventListener('click', () => folderDialog.close())
profileSearch.addEventListener('input', renderProfiles)
profileSearch.addEventListener('search', renderProfiles)
document.querySelector('#open-files').addEventListener('click', openFileWorkspace)
addPaneResize(document.querySelector('.local-pane'))
document.querySelector('#sidebar-toggle').addEventListener('click', () => {
  const hidden = document.querySelector('#app').classList.toggle('sidebar-hidden')
  const button = document.querySelector('#sidebar-toggle')
  button.setAttribute('aria-expanded', String(!hidden))
  button.setAttribute('aria-label', hidden ? '展开服务器侧栏' : '隐藏服务器侧栏')
  button.title = hidden ? '展开服务器侧栏' : '隐藏服务器侧栏'
})
for (const [id, direction] of [['files-scroll-left', -1], ['files-scroll-right', 1]]) {
  document.querySelector(`#${id}`).addEventListener('click', () => {
    const strip = document.querySelector('.file-columns')
    strip.scrollBy({ left: direction * 560, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  })
}
document.querySelector('#select-servers').addEventListener('click', showServerPicker)
document.querySelector('#empty-select-servers').addEventListener('click', showServerPicker)
document.querySelector('#servers-form').addEventListener('submit', connectSelectedServers)
document.querySelector('#servers-cancel').addEventListener('click', () => document.querySelector('#servers-dialog').close())
document.querySelector('#servers-cancel-x').addEventListener('click', () => document.querySelector('#servers-dialog').close())
document.querySelector('#local-home').addEventListener('click', () => loadLocalDirectory(null))
document.querySelector('#local-parent').addEventListener('click', () => loadLocalDirectory(localDirectory?.parentId))
document.querySelector('#local-refresh').addEventListener('click', () => loadLocalDirectory())
document.querySelector('#local-show-hidden').addEventListener('change', renderLocalFiles)
document.querySelector('#local-filter').addEventListener('input', renderLocalFiles)
document.querySelector('#local-filter').addEventListener('search', renderLocalFiles)
document.querySelector('#local-select-all').addEventListener('change', event => {
  const files = visibleLocalFiles().filter(item => item.type === 'file')
  if (event.target.checked && files.length > 100) {
    event.target.checked = false
    return notify('一次最多选择 100 个文件，请手动选择', true)
  }
  const selection = new Set(localSelection)
  for (const entry of files) {
    if (event.target.checked) selection.add(entry.id)
    else selection.delete(entry.id)
  }
  if (selection.size > 100) { syncLocalActions(); return notify('一次最多选择 100 个文件', true) }
  localSelection.clear()
  for (const id of selection) localSelection.add(id)
  syncLocalActions()
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
    if (document.querySelector('#app').classList.contains('sidebar-hidden')) document.querySelector('#sidebar-toggle').click()
    profileSearch.focus()
    profileSearch.select()
  } else if (event.key.toLowerCase() === 'n') {
    event.preventDefault()
    openProfileDialog()
  } else if (state.sftpActive && ['f', 'l', 'r'].includes(event.key.toLowerCase())) {
    // 仅文件工作区接管快捷键，SSH 中的 Ctrl+R 等按键仍交给远端 shell。
    const pane = document.activeElement?.closest('.file-pane')
    const connection = pane?.classList.contains('local-pane') ? null : [...state.sftpConnections.values()].find(item => item.ui?.pane === pane) ?? state.sftp
    const key = event.key.toLowerCase()
    if (key === 'f') {
      event.preventDefault()
      const input = connection ? connection.ui.filter : document.querySelector('#local-filter')
      input.focus()
      input.select()
    } else if (key === 'l' && connection?.status === 'ready') {
      event.preventDefault()
      connection.ui.path.focus()
      connection.ui.path.select()
    } else if (key === 'r') {
      event.preventDefault()
      if (connection?.status === 'ready') refreshSftp(connection.path, connection)
      else if (!connection) loadLocalDirectory()
    }
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
api.sftp.onProgress(handleUploadProgress)

try {
  state.profiles = await api.profiles.list()
  renderProfiles()
  syncWorkspaceState()
} catch (error) {
  elements.profileList.textContent = `无法读取连接配置：${errorMessage(error)}`
}
