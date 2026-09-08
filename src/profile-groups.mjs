/** 识别数字序号前缀或分隔符前缀；地址型名称不按 IP 数字段分组。 */
function groupName (name) {
  const text = name.trim()
  if (/^\d+(?:\.\d+){3}$/u.test(text) || text.includes(':')) return text
  const numbered = text.match(/^(.*?\D)[\s_-]*\d+$/u)
  if (numbered) return numbered[1].replace(/[\s_-]+$/u, '') || text
  return text.split(/[\s/_·-]+/u)[0] || text
}

/** 两台以上同前缀形成可折叠组；单台保持平铺，组内按数字自然排序。 */
export function groupProfiles (profiles) {
  const groups = new Map()
  for (const profile of profiles) {
    const name = groupName(profile.name)
    const key = name.toLocaleLowerCase()
    if (!groups.has(key)) groups.set(key, { key, name, profiles: [] })
    groups.get(key).profiles.push(profile)
  }
  return [...groups.values()].map(group => ({
    ...group,
    grouped: group.profiles.length > 1,
    profiles: group.profiles.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
  }))
}
