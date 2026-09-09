'use strict'

const fs = require('node:fs/promises')
const { constants } = require('node:fs')
const path = require('node:path')

const MAX_UPLOAD_ENTRIES = 10000
const MAX_UPLOAD_DEPTH = 32

function validateName (name) {
  const control = [...name].some(character => character.codePointAt(0) <= 31 || character.codePointAt(0) === 127)
  if (!name || name === '.' || name === '..' || name.includes('/') || Buffer.byteLength(name) > 255 || control) {
    throw new Error('文件名包含不支持的字符或过长')
  }
  return name
}

function sameIdentity (left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

/** 扫描和打开之间逐级确认目录身份，拒绝目录被替换成链接后越界读取。 */
async function verifyParents (parents, signal) {
  for (const parent of parents) {
    signal.throwIfAborted()
    const current = await fs.lstat(parent.path)
    if (!current.isDirectory() || !sameIdentity(current, parent.stat)) throw new Error('本地目录在上传期间发生变化，请重新选择')
  }
}

/** 有界扫描用户授权的顶层项目；拒绝链接和特殊文件，目录保留为空目录条目。 */
async function scanUploadSources (localPaths, signal) {
  let count = 0
  const sources = []
  for (const localPath of localPaths) {
    signal.throwIfAborted()
    const source = { name: path.basename(localPath), entries: [], size: 0 }
    sources.push(source)
    try {
      validateName(source.name)
      const initial = await fs.lstat(localPath)
      if (!initial.isFile() && !initial.isDirectory()) throw new Error('不支持上传符号链接或特殊文件')
      // 允许 macOS /var 等系统父路径别名，但用户选中的项目本身不能是链接。
      const canonical = await fs.realpath(localPath)
      const root = await fs.lstat(canonical)
      if (!sameIdentity(initial, root)) throw new Error('本地项目在扫描期间发生变化，请重新选择')
      source.type = root.isDirectory() ? 'directory' : 'file'

      const visit = async (currentPath, relativePath, parents, depth) => {
        signal.throwIfAborted()
        if (++count > MAX_UPLOAD_ENTRIES) throw new Error(`一次上传最多支持 ${MAX_UPLOAD_ENTRIES} 个文件和目录`)
        if (depth > MAX_UPLOAD_DEPTH) throw new Error(`文件夹层级不能超过 ${MAX_UPLOAD_DEPTH} 层`)
        validateName(path.basename(currentPath))
        await verifyParents(parents, signal)
        const stat = await fs.lstat(currentPath)
        if (!stat.isDirectory() && !stat.isFile()) throw new Error('不支持上传符号链接或特殊文件')
        if (depth === 0 && !sameIdentity(stat, root)) throw new Error('本地项目在扫描期间发生变化，请重新选择')
        const entry = { path: currentPath, relativePath, stat, parents, type: stat.isDirectory() ? 'directory' : 'file' }
        source.entries.push(entry)
        if (entry.type === 'file') {
          if (!Number.isSafeInteger(stat.size) || stat.size < 0 || !Number.isSafeInteger(source.size + stat.size)) throw new Error('文件总大小超出支持范围')
          source.size += stat.size
          return
        }
        const ancestry = [...parents, { path: currentPath, stat }]
        // opendir 流式迭代，超过条目上限时立即停止，不先读入整个大目录。
        const directory = await fs.opendir(currentPath)
        for await (const child of directory) {
          validateName(child.name)
          await visit(path.join(currentPath, child.name), path.posix.join(relativePath, child.name), ancestry, depth + 1)
        }
        await verifyParents(ancestry, signal)
      }
      await visit(canonical, '', [], 0)
    } catch (error) {
      signal.throwIfAborted()
      source.error = error
      source.entries = []
      source.size = 0
    }
  }
  return sources
}

/** O_NOFOLLOW + 文件身份复核保护扫描快照；返回的句柄由上传方始终关闭。 */
async function openUploadSource (entry, signal) {
  signal.throwIfAborted()
  await verifyParents(entry.parents, signal)
  // O_NONBLOCK 防止本地文件被替换成 FIFO 时阻塞主进程；普通文件不受影响。
  const handle = await fs.open(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || !sameIdentity(stat, entry.stat) || stat.size !== entry.stat.size || stat.mtimeMs !== entry.stat.mtimeMs) {
      throw new Error('本地文件在上传期间发生变化，请重新选择')
    }
    await verifyParents(entry.parents, signal)
    signal.throwIfAborted()
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}

module.exports = { MAX_UPLOAD_ENTRIES, MAX_UPLOAD_DEPTH, scanUploadSources, openUploadSource }
