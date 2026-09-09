const motions = new WeakMap()

/** 只在用户切换或状态真正变化时播放短动画；快速重复操作替换旧动画，不堆积效果。 */
export function animateSurface (element, kind = 'enter') {
  if (!element?.isConnected || typeof element.animate !== 'function') return
  motions.get(element)?.cancel()
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const frames = kind === 'settle'
    ? [{ opacity: 0.65 }, { opacity: 1 }]
    : [{ opacity: 0.35, translate: '0 8px' }, { opacity: 1, translate: '0 0' }]
  // translate 不覆盖元素既有 transform，通知的居中和标签拖动坐标仍由原布局控制。
  const animation = element.animate(frames, { duration: kind === 'settle' ? 160 : 220, easing: 'cubic-bezier(.22,1,.36,1)' })
  motions.set(element, animation)
  animation.onfinish = () => {
    if (motions.get(element) === animation) motions.delete(element)
  }
}
