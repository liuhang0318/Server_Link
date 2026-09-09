/** 按目标前后移动标签；未知 ID 和原地移动保持原顺序，不改变任何会话状态。 */
export function moveTab (order, source, target, after = false) {
  if (source === target || !order.includes(source) || !order.includes(target)) return order
  const result = order.filter(key => key !== source)
  result.splice(result.indexOf(target) + Number(after), 0, source)
  return result
}

/** 忽略亚像素误差，内容未溢出或已到边界时禁用对应方向，不改变当前选中项。 */
export function tabScrollState (scrollLeft, clientWidth, scrollWidth) {
  const maximum = Math.max(0, scrollWidth - clientWidth)
  return { canScrollLeft: scrollLeft > 1, canScrollRight: scrollLeft < maximum - 1 }
}
