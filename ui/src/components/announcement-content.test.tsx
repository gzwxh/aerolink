import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AnnouncementContent } from './announcement-content'

/** 顶栏是一行动画轨道：按「一行纯文本」比对，避免空白细节把测试写脆。 */
function inlineText(markdown: string): string {
  const { container } = render(<AnnouncementContent content={markdown} />)
  return (container.textContent ?? '').replace(/\s+/g, ' ').trim()
}

// 横幅是单行轨道，块级元素会断行、撑高顶栏，所以标题/列表/引用/表格都必须压成行内。
describe('AnnouncementContent 的块级行内化', () => {
  it('标题变加粗，且与后面的正文用空格隔开', () => {
    const { container } = render(
      <AnnouncementContent content={'# 停服通知\n今晚 22:00'} />
    )

    expect(container.querySelector('h1')).toBeNull()
    expect(container.querySelector('strong')?.textContent).toBe('停服通知')
    expect(inlineText('# 停服通知\n今晚 22:00')).toBe('停服通知 今晚 22:00')
  })

  it('列表项前加 •，列表容器不产生块级元素', () => {
    const { container } = render(<AnnouncementContent content={'- 甲\n- 乙'} />)

    expect(container.querySelector('ul')).toBeNull()
    expect(inlineText('- 甲\n- 乙')).toBe('• 甲 • 乙')
  })

  it('引用变斜体，分割线变破折号', () => {
    const { container } = render(<AnnouncementContent content={'> 注意'} />)

    expect(container.querySelector('blockquote')).toBeNull()
    // blockquote 里 react-markdown 会补 `\n` 文本节点（HTML 里会被折叠），比对前先压平。
    expect(
      container
        .querySelector('.italic')
        ?.textContent?.replace(/\s+/g, ' ')
        .trim()
    ).toBe('注意')

    expect(inlineText('---\n第一段')).toBe('—— 第一段')
  })

  it('表格只留单元格文字', () => {
    expect(inlineText('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |')).toBe(
      '甲 乙 1 2'
    )
  })

  // 图片不进白名单：一行横幅里放不下，也不该让公告引用外部资源。
  it('图片不渲染成 img', () => {
    const { container } = render(
      <AnnouncementContent content="![图](https://example.com/a.png)" />
    )

    expect(container.querySelector('img')).toBeNull()
  })
})
