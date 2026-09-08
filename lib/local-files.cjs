'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

/** 本地文件浏览只返回元数据及窗口专属令牌，渲染层不获得任意路径读写能力。 */
class LocalFiles {
  constructor (homeDirectory) {
    this.homeDirectory = homeDirectory
    this.owners = new Map()
  }

  /** 首次显示用户目录，后续仅接受上次目录列表授予的文件夹令牌。 */
  async list (ownerId, directoryId = null) {
    let owner = this.owners.get(ownerId)
    if (!owner) {
      owner = { entries: new Map(), generation: 0 }
      this.owners.set(ownerId, owner)
    }
    const directory = directoryId === null ? this.homeDirectory : this.requireEntry(ownerId, directoryId, 'directory').path
    const generation = ++owner.generation
    const entries = new Map()
    const grant = (filePath, type) => {
      const id = randomUUID()
      entries.set(id, { path: filePath, type })
      return id
    }
    const id = grant(directory, 'directory')
    const parentId = directory === path.dirname(directory) ? null : grant(path.dirname(directory), 'directory')
    const dirents = await fs.readdir(directory, { withFileTypes: true })
    if (dirents.length > 10000) throw new Error('目录超过 10000 个项目，请选择更小的目录')
    const files = []
    // 分批 stat 限制并发，避免大目录耗尽文件描述符或向 UI 返回文件内容。
    for (let start = 0; start < dirents.length; start += 64) {
      const batch = await Promise.all(dirents.slice(start, start + 64).map(async entry => {
        const filePath = path.join(directory, entry.name)
        const type = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other'
        try {
          const stat = await fs.lstat(filePath)
          return { id: grant(filePath, type), name: entry.name, type, size: stat.size, modifiedAt: stat.mtime.toISOString() }
        } catch {
          return null
        }
      }))
      files.push(...batch.filter(Boolean))
    }
    if (this.owners.get(ownerId) !== owner || owner.generation !== generation) throw new Error('本地目录请求已失效')
    // 替换旧令牌以限制授权范围及内存；进行中的上传已捕获自己的路径快照。
    owner.entries = entries
    files.sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
    return { id, path: directory, parentId, entries: files }
  }

  /** 上传仅接受当前窗口目录中普通文件的令牌，不接受任意字符串路径。 */
  selectedPaths (ownerId, fileIds) {
    if (!Array.isArray(fileIds) || fileIds.length < 1 || fileIds.length > 100 || new Set(fileIds).size !== fileIds.length) throw new Error('请选择 1～100 个不同的文件')
    return fileIds.map(id => this.requireEntry(ownerId, id, 'file').path)
  }

  requireEntry (ownerId, id, type) {
    const entry = typeof id === 'string' ? this.owners.get(ownerId)?.entries.get(id) : null
    if (!entry || entry.type !== type) throw new Error('本地文件引用已失效，请刷新后重新选择')
    return entry
  }

  /** 窗口关闭即撤销该窗口所有本地文件令牌。 */
  closeOwner (ownerId) {
    this.owners.delete(ownerId)
  }
}

module.exports = { LocalFiles }
