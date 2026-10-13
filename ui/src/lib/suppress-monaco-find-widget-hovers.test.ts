import { describe, expect, it, vi } from 'vitest'

import { suppressMonacoFindWidgetHovers } from './suppress-monaco-find-widget-hovers'

/** 在 target 上派发一次冒泡的 mouseover。 */
function dispatchMouseOver(target: HTMLElement): void {
  target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
}

describe('suppressMonacoFindWidgetHovers', () => {
  it('拦下 find-widget 内元素的 mouseover，阻止后续监听器收到事件', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const findWidget = document.createElement('div')
    findWidget.className = 'find-widget'
    const closeButton = document.createElement('div')
    closeButton.className = 'button codicon-widget-close'
    findWidget.appendChild(closeButton)
    container.appendChild(findWidget)

    const dispose = suppressMonacoFindWidgetHovers(container)
    // 模拟 Monaco 在按钮上注册的 hover 监听器（注册在拦截器之后）。
    const monacoHoverListener = vi.fn()
    closeButton.addEventListener('mouseover', monacoHoverListener)

    dispatchMouseOver(closeButton)

    expect(monacoHoverListener).not.toHaveBeenCalled()

    dispose()
    findWidget.remove()
    container.remove()
  })

  it('不拦截 find-widget 之外的 mouseover，编辑器内容 hover 不受影响', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const viewLines = document.createElement('div')
    viewLines.className = 'view-lines'
    container.appendChild(viewLines)

    const dispose = suppressMonacoFindWidgetHovers(container)
    const contentHoverListener = vi.fn()
    viewLines.addEventListener('mouseover', contentHoverListener)

    dispatchMouseOver(viewLines)

    expect(contentHoverListener).toHaveBeenCalled()

    dispose()
    viewLines.remove()
    container.remove()
  })

  it('解绑后不再拦截', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const findWidget = document.createElement('div')
    findWidget.className = 'find-widget'
    container.appendChild(findWidget)

    const dispose = suppressMonacoFindWidgetHovers(container)
    dispose()

    const listener = vi.fn()
    findWidget.addEventListener('mouseover', listener)
    dispatchMouseOver(findWidget)

    expect(listener).toHaveBeenCalled()

    findWidget.remove()
    container.remove()
  })
})
