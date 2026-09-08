/** 按目标前后移动标签；未知 ID 和原地移动保持原顺序，不改变任何会话状态。 */
export function moveTab (order, source, target, after = false) {
  if (source === target || !order.includes(source) || !order.includes(target)) return order
  const result = order.filter(key => key !== source)
  result.splice(result.indexOf(target) + Number(after), 0, source)
  return result
}
