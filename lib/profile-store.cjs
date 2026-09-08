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

  return {
    id: validateId(value.id),
    ...normalized,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString()
  }
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

  /** Replaces editable fields while preserving identity and creation time. */
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
