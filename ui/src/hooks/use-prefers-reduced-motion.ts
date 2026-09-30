import * as React from 'react'

/**
 * 是否开启了系统/浏览器级的「减弱动效」。
 *
 * 通知栏的滚动是持续性的水平位移动画，对前庭敏感的用户不友好：开启该项时通知栏
 * 不自动滚动，改为静态截断显示，并由「按住拖动」与「展开全文」保证内容仍然读得到
 * （见 components/announcement-bar.tsx 与 plans/2026-09-21-顶部通知栏.md §12.10）。
 */
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

export function usePrefersReducedMotion() {
  const [prefersReduced, setPrefersReduced] = React.useState(false)

  React.useEffect(() => {
    const mql = window.matchMedia(REDUCED_MOTION_QUERY)
    const onChange = () => setPrefersReduced(mql.matches)
    mql.addEventListener('change', onChange)
    setPrefersReduced(mql.matches)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return prefersReduced
}
