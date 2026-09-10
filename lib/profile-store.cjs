'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { normalizeProfileInput } = require('./ssh-args.cjs')

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const STORED_INPUT_KEYS = new Set([
  'name',
  'host',
  'port',
  'username',
  'auth',
  'privateKeyPath'
])

function cloneProfile (profile) {
  return { ...profile }
}

function validateId (value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new TypeError('profile id is invalid')
  }
  return value
}

/** 空字符串显式取消分组；名称不允许控制字符，避免不可见分组混淆侧栏。 */
function normalizeGroup (value) {
  if (typeof value !== 'string' || value.trim().length > 80 || [...value].some(character => {
    const code = character.codePointAt(0)
    return code < 32 || (code >= 127 && code <= 159)
  })) throw new TypeError('分组名称无效，请使用不超过 80 个字符的名称')
  return value.trim()
}

/** 在入队前复制并验证 ID，防止调用方后续修改数组影响待写入的操作。 */
function normalizeIds (value, maximum, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) throw new TypeError(`${label}数量无效`)
  const ids = Array.from(value, validateId)
  if (new Set(ids).size !== ids.length) throw new TypeError(`${label}不能包含重复服务器`)
  return ids
}

/** 兼容旧 v1 配置；组织元数据单独校验，绝不放宽连接配置的安全白名单。 */
function normalizeStoredProfile (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('stored profile is invalid')
  }

  // Select an explicit allowlist before validation so legacy or tampered secret
  // fields are never returned to the renderer or written back out.
  const input = {}
  for (const key of STORED_INPUT_KEYS) {
    if (Object.hasOwn(value, key)) input[key] = value[key]
  }
  const normalized = normalizeProfileInput(input)
  const createdAt = new Date(value.createdAt)
  const updatedAt = new Date(value.updatedAt)
  if (Number.isNaN(createdAt.valueOf()) || Number.isNaN(updatedAt.valueOf())) {
    throw new TypeError('stored profile timestamps are invalid')
  }

  const profile = {
    id: validateId(value.id),
    ...normalized,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString()
  }
  if (Object.hasOwn(value, 'group')) profile.group = normalizeGroup(value.group)
  if (Object.hasOwn(value, 'order')) {
    if (!Number.isSafeInteger(value.order) || value.order < 0) throw new TypeError('stored profile order is invalid')
    profile.order = value.order
  }
  return profile
}

/**
 * Persists non-secret connection profiles in one owner-only JSON file. Writes
 * use fsync plus same-directory rename so a crash cannot expose a partial file.
 */
class ProfileStore {
  constructor (directoryPath) {
    if (typeof directoryPath !== 'string' || !path.isAbsolute(directoryPath)) {
      throw new TypeError('profile directory must be absolute')
    }
    this.directoryPath = path.normalize(directoryPath)
    this.filePath = path.join(this.directoryPath, 'profiles.json')
    this.profiles = []
    this.initialized = false
    this.writeQueue = Promise.resolve()
  }

  /** Creates the private store or loads and validates its current contents. */
  async init () {
    if (this.initialized) return

    await fs.mkdir(this.directoryPath, { recursive: true, mode: DIRECTORY_MODE })
    // mkdir respects the process umask only on creation; chmod also repairs an
    // existing directory that was previously more permissive.
    await fs.chmod(this.directoryPath, DIRECTORY_MODE)

    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const document = JSON.parse(raw)
      if (!document || document.version !== 1 || !Array.isArray(document.profiles)) {
        throw new TypeError('profile store format is invalid')
      }
      this.profiles = document.profiles.map(normalizeStoredProfile)
      await fs.chmod(this.filePath, FILE_MODE)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await this.persist([])
      this.profiles = []
    }
    this.initialized = true
  }

  /** Returns defensive copies so callers cannot mutate in-memory state. */
  async list () {
    await this.init()
    return this.profiles.map(cloneProfile)
  }

  /** Returns one profile by its opaque identifier. */
  async get (id) {
    await this.init()
    validateId(id)
    const profile = this.profiles.find(item => item.id === id)
    return profile ? cloneProfile(profile) : null
  }

  /** Validates and atomically appends one non-secret profile. */
  async create (input) {
    return this.enqueue(async () => {
      const now = new Date().toISOString()
      const profile = {
        id: randomUUID(),
        ...normalizeProfileInput(input),
        createdAt: now,
        updatedAt: now
      }
      const next = [...this.profiles, profile]
      await this.persist(next)
      this.profiles = next
      return cloneProfile(profile)
    })
  }

  /** 一次校验并原子写入整批连接，任意行失败都不留下部分导入记录。 */
  async createBatch (common, hostsText) {
    if (!common || typeof common !== 'object' || Array.isArray(common) ||
      Object.keys(common).some(key => !['port', 'username', 'auth', 'privateKeyPath'].includes(key))) {
      throw new TypeError('批量公共配置无效')
    }
    if (typeof hostsText !== 'string' || hostsText.length > 40000) throw new TypeError('服务器列表过长')
    const lines = hostsText.split(/\r?\n/u).map((text, index) => ({ text: text.trim(), line: index + 1 })).filter(item => item.text)
    if (lines.length < 1 || lines.length > 100) throw new TypeError('请一次输入 1～100 台服务器')
    const seen = new Set()
    const inputs = lines.map(({ text, line }) => {
      try {
        const fields = text.split(/[,，]/u).map(value => value.trim())
        if (fields.length > 2 || fields.some(value => !value)) throw new Error('格式应为 IP/域名 或 名称,IP/域名')
        const host = fields.at(-1)
        const profile = normalizeProfileInput({ ...common, name: fields.length === 2 ? fields[0] : host, host })
        const key = profile.host.toLowerCase()
        if (seen.has(key)) throw new Error('列表中有重复服务器地址')
        seen.add(key)
        return profile
      } catch (error) {
        throw new TypeError(`第 ${line} 行：${error.message}`)
      }
    })
    return this.enqueue(async () => {
      const now = new Date().toISOString()
      const created = inputs.map(input => ({ id: randomUUID(), ...input, createdAt: now, updatedAt: now }))
      const next = [...this.profiles, ...created]
      // 复用单台连接的持久化路径，整批只进行一次 fsync 和原子替换。
      await this.persist(next)
      this.profiles = next
      return created.map(cloneProfile)
    })
  }

  /** Replaces connection fields while preserving identity, creation time and organization metadata. */
  async update (id, input) {
    return this.enqueue(async () => {
      validateId(id)
      const index = this.profiles.findIndex(item => item.id === id)
      if (index === -1) throw new Error('profile not found')

      const profile = {
        ...this.profiles[index],
        ...normalizeProfileInput(input),
        updatedAt: new Date().toISOString()
      }
      const next = this.profiles.slice()
      next[index] = profile
      await this.persist(next)
      this.profiles = next
      return cloneProfile(profile)
    })
  }

  /** Atomically removes a profile; active sessions keep their own process. */
  async remove (id) {
    return this.enqueue(async () => {
      validateId(id)
      const next = this.profiles.filter(item => item.id !== id)
      if (next.length === this.profiles.length) return false
      await this.persist(next)
      this.profiles = next
      return true
    })
  }

  /** 仅修改分组和排列；全量排序必须与队列执行时的服务器集合一致，避免并发操作丢记录。 */
  async organize (change) {
    if (!change || typeof change !== 'object' || Array.isArray(change) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(change)) ||
      Reflect.ownKeys(change).some(key => !['ids', 'group', 'order'].includes(key))) {
      throw new TypeError('服务器组织配置包含无效或不支持的字段')
    }
    const hasGroup = Object.hasOwn(change, 'group')
    const hasIds = Object.hasOwn(change, 'ids')
    const hasOrder = Object.hasOwn(change, 'order')
    if (hasIds !== hasGroup || (!hasGroup && !hasOrder)) throw new TypeError('请选择分组服务器或提供完整排序')
    const ids = hasIds ? normalizeIds(change.ids, 100, '分组服务器') : []
    const group = hasGroup && change.group !== null ? normalizeGroup(change.group) : null
    const order = hasOrder ? normalizeIds(change.order, 10000, '排序服务器') : null

    // 归属检查放在串行写队列内，不能用入队前已过期的服务器列表校验并发增删。
    return this.enqueue(async () => {
      const currentIds = new Set(this.profiles.map(profile => profile.id))
      if (ids.some(id => !currentIds.has(id))) throw new Error('分组中的服务器已不存在，请刷新后重试')
      if (order && (order.length !== this.profiles.length || order.some(id => !currentIds.has(id)))) {
        throw new Error('服务器列表已变化，请刷新后重新排序')
      }

      const selected = new Set(ids)
      let next = this.profiles.map(profile => {
        if (!selected.has(profile.id)) return profile
        const updated = { ...profile }
        // 删除字段恢复名称前缀自动分组；空字符串则保持显式不分组，两者不能混用。
        if (group === null) delete updated.group
        else updated.group = group
        return updated
      })
      if (order) {
        const profilesById = new Map(next.map(profile => [profile.id, profile]))
        next = order.map((id, index) => ({ ...profilesById.get(id), order: index }))
      }

      // 一次原子落盘成功后才替换内存；分组与排序任一失败都不留下半次修改。
      await this.persist(next)
      this.profiles = next
      return next.map(cloneProfile)
    })
  }

  async enqueue (operation) {
    await this.init()
    const result = this.writeQueue.then(operation, operation)
    this.writeQueue = result.then(() => undefined, () => undefined)
    return result
  }

  async persist (profiles) {
    const temporaryPath = path.join(
      this.directoryPath,
      `.profiles-${process.pid}-${randomUUID()}.tmp`
    )
    const body = `${JSON.stringify({ version: 1, profiles }, null, 2)}\n`
    let handle

    try {
      handle = await fs.open(temporaryPath, 'wx', FILE_MODE)
      await handle.writeFile(body, 'utf8')
      await handle.sync()
      await handle.close()
      handle = null
      await fs.rename(temporaryPath, this.filePath)
      await fs.chmod(this.filePath, FILE_MODE)

      // Syncing the directory makes the rename durable across sudden power loss.
      const directory = await fs.open(this.directoryPath, 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    } catch (error) {
      if (handle) await handle.close().catch(() => {})
      await fs.unlink(temporaryPath).catch(() => {})
      throw error
    }
  }
}

module.exports = { DIRECTORY_MODE, FILE_MODE, ProfileStore }
