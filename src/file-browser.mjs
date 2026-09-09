/** 只筛选当前目录已有的元数据，不递归访问文件系统；名称匹配不区分大小写。 */
export function filterFiles (entries, query = '', showHidden = true) {
  const term = query.trim().toLocaleLowerCase()
  return entries.filter(entry => (showHidden || !entry.name.startsWith('.')) && entry.name.toLocaleLowerCase().includes(term))
}

/** 仅可选择普通文件或目录；链接等特殊项目不得被批量上传。 */
export function isUploadableEntry (entry) {
  return entry.type === 'file' || entry.type === 'directory'
}

/** 刷新同一路径时按名称和类型映射新令牌，跨目录或项目改变类型时不保留旧选择。 */
export function refreshedSelection (previous, next, selected) {
  if (previous?.path !== next.path) return new Set()
  const names = new Set(previous.entries.filter(entry => selected.has(entry.id) && isUploadableEntry(entry)).map(entry => `${entry.type}\0${entry.name}`))
  return new Set(next.entries.filter(entry => isUploadableEntry(entry) && names.has(`${entry.type}\0${entry.name}`)).map(entry => entry.id))
}

/** Shift 范围仅包含可见的可上传项目，超过批次上限时整次选择不生效。 */
export function selectFileRange (entries, selected, anchor, id, checked, extend = false) {
  const ids = entries.filter(isUploadableEntry).map(entry => entry.id)
  const end = ids.indexOf(id)
  if (end < 0) return selected
  const start = extend && ids.includes(anchor) ? ids.indexOf(anchor) : end
  const result = new Set(selected)
  for (const value of ids.slice(Math.min(start, end), Math.max(start, end) + 1)) {
    if (checked) result.add(value)
    else result.delete(value)
  }
  return result.size > 100 ? selected : result
}
