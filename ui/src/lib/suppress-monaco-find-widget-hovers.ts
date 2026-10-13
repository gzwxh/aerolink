/**
 * 屏蔽 Monaco 查找组件（find widget）按钮上的 workbench hover。
 *
 * Monaco 给查找组件的每个按钮（关闭、前后匹配、大小写等）都硬编码注册了
 * mouseover hover（如「Close (Escape)」），且弹层优先出现在按钮上方；日志
 * 查看器的查找组件紧贴工具栏下方，鼠标从工具栏移向输入框时会路过按钮而
 * 误触发，弹层直接叠在工具栏上。Monaco 没有提供关闭这些 hover 的选项，
 * 于是在编辑器容器的捕获阶段拦下 find-widget 内的 mouseover，让 hover
 * 监听器收不到事件；查找组件的点击、输入等其他行为不受影响。
 *
 * 返回解绑函数。
 */
export function suppressMonacoFindWidgetHovers(
  container: HTMLElement
): () => void {
  const onMouseOver = (e: MouseEvent) => {
    if ((e.target as HTMLElement | null)?.closest('.find-widget')) {
      e.stopImmediatePropagation()
    }
  }
  container.addEventListener('mouseover', onMouseOver, true)
  return () => {
    container.removeEventListener('mouseover', onMouseOver, true)
  }
}
