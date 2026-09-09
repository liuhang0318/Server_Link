/** 只筛选当前目录已有的元数据，不递归访问文件系统；名称匹配不区分大小写。 */
export function filterFiles (entries, query = '', showHidden = true) {
  const term = query.trim().toLocaleLowerCase()
  return entries.filter(entry => (showHidden || !entry.name.startsWith('.')) && entry.name.toLocaleLowerCase().includes(term))
}

/** 刷新同一路径时按文件名映射新授权令牌，跨目录不保留旧选择。 */
export function refreshedSelection (previous, next, selected) {
  if (previous?.path !== next.path) return new Set()
  const names = new Set(previous.entries.filter(entry => selected.has(entry.id) && entry.type === 'file').map(entry => entry.name))
  return new Set(next.entries.filter(entry => entry.type === 'file' && names.has(entry.name)).map(entry => entry.id))
}

/** Shift 范围仅包含可见普通文件，超过批次上限时整次选择不生效。 */
export function selectFileRange (entries, selected, anchor, id, checked, extend = false) {
  const ids = entries.filter(entry => entry.type === 'file').map(entry => entry.id)
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
