/** 识别数字序号前缀或分隔符前缀；地址型名称不按 IP 数字段分组。 */
function groupName (name) {
  const text = name.trim()
  if (/^\d+(?:\.\d+){3}$/u.test(text) || text.includes(':')) return text
  const numbered = text.match(/^(.*?\D)[\s_-]*\d+$/u)
  if (numbered) return numbered[1].replace(/[\s_-]+$/u, '') || text
  return text.split(/[\s/_·-]+/u)[0] || text
}

/** 手动分组优先于旧前缀规则；保存过拖动顺序后按输入顺序展示，不再覆盖用户排序。 */
export function groupProfiles (profiles) {
  const groups = new Map()
  const ordered = profiles.some(profile => Number.isInteger(profile.order) && profile.order >= 0)
  for (const profile of profiles) {
    const explicit = typeof profile.group === 'string'
    const name = explicit ? profile.group.trim() : groupName(profile.name)
    const key = explicit && !name ? `single:${profile.id}` : `group:${name.toLocaleLowerCase()}`
    if (!groups.has(key)) groups.set(key, { key, name: name || profile.name, profiles: [], manual: false })
    const group = groups.get(key)
    group.manual ||= explicit && Boolean(name)
    group.profiles.push(profile)
  }
  return [...groups.values()].map(group => ({
    ...group,
    grouped: group.manual || group.profiles.length > 1,
    profiles: ordered ? group.profiles : group.profiles.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
  }))
}

/** 返回拖动后的全量 ID 顺序；只排序、不改分组，非法目标或移动集合保持当前展示顺序。 */
export function moveProfileOrder (profiles, movingIds, targetId, after = false) {
  // 旧配置仍按自然序显示，必须从用户眼前的顺序移动，不能直接使用原始存储顺序。
  const order = groupProfiles(profiles).flatMap(group => group.profiles.map(profile => profile.id))
  if (!Array.isArray(movingIds) || !movingIds.length || !order.includes(targetId)) return order
  const movingSet = new Set(movingIds)
  if (movingSet.size !== movingIds.length || movingSet.has(targetId)) return order
  const moving = order.filter(id => movingSet.has(id))
  if (moving.length !== movingIds.length) return order
  const remaining = order.filter(id => !movingSet.has(id))
  remaining.splice(remaining.indexOf(targetId) + (after ? 1 : 0), 0, ...moving)
  return remaining
}
