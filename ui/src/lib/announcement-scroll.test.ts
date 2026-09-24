import { describe, expect, it } from 'vitest'

import {
  announcementScrollMode,
  combinedScrollMode,
  pacedAnimationName,
} from './announcement-scroll'

const item = (overrides: { scroll?: boolean; scrollMode?: string }) =>
  ({ scroll: true, ...overrides }) as never

describe('announcementScrollMode', () => {
  it('优先用三态字段', () => {
    expect(announcementScrollMode(item({ scrollMode: 'paced' }))).toBe('paced')
    expect(announcementScrollMode(item({ scrollMode: 'none', scroll: true }))).toBe(
      'none'
    )
  })

  // 老数据/老接口只有 scroll(bool)：false = 不滚动，true = 连续滚动（历史行为）。
  it('没有三态字段时按 scroll 推导', () => {
    expect(announcementScrollMode(item({ scroll: false }))).toBe('none')
    expect(announcementScrollMode(item({ scroll: true }))).toBe('continuous')
    expect(announcementScrollMode(item({}))).toBe('continuous')
  })
})

describe('combinedScrollMode', () => {
  // 多条串成一条轨道，没法一半一种方式：取最强的（与「级别取最高」同一套取舍）。
  it('取最强的那一种', () => {
    expect(
      combinedScrollMode([
        item({ scrollMode: 'continuous' }),
        item({ scrollMode: 'paced' }),
      ])
    ).toBe('paced')

    expect(
      combinedScrollMode([item({ scroll: false }), item({ scroll: true })])
    ).toBe('continuous')

    expect(combinedScrollMode([item({ scroll: false })])).toBe('none')
  })

  it('空列表当作不滚动', () => {
    expect(combinedScrollMode([])).toBe('none')
  })
})

// 「每轮停留」= 滚一段（时长随内容长短变化）+ 固定停 2 秒，所以停留点随滚动时长变化。
describe('pacedAnimationName', () => {
  it('停留点 = 滚动秒数 /（滚动秒数 + 2）', () => {
    // 20 / 22 ≈ 90.9091%
    expect(pacedAnimationName(20)).toBe('announcement-scroll-paced-909091')
    // 58 / 60 ≈ 96.6667%
    expect(pacedAnimationName(58)).toBe('announcement-scroll-paced-966667')
    // 30 / 32 = 93.75%（整数比例，名字里不带小数点）
    expect(pacedAnimationName(30)).toBe('announcement-scroll-paced-9375')
  })

  it('把关键帧注入 head，同一比例只注入一次', () => {
    const name = pacedAnimationName(30, 2)
    const selector = `style[data-announcement-keyframes="${name}"]`

    const first = document.head.querySelector(selector)
    expect(first?.textContent).toContain(`@keyframes ${name}`)
    expect(first?.textContent).toContain('93.75%')
    expect(first?.textContent).toContain('translateX(-50%)')

    pacedAnimationName(30, 2)
    expect(document.head.querySelectorAll(selector)).toHaveLength(1)
  })
})
