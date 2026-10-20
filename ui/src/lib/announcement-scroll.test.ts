import { describe, expect, it } from 'vitest'

import {
  ANNOUNCEMENT_DEFAULT_PAUSE_SECONDS,
  ANNOUNCEMENT_DEFAULT_SCROLL_SPEED,
  announcementScrollMode,
  announcementScrollParams,
  combinedScrollMode,
  combinedScrollParams,
  pacedAnimationName,
} from './announcement-scroll'

const item = (overrides: {
  scroll?: boolean
  scrollMode?: string
  scrollSpeed?: number
  pauseSeconds?: number
  displaySeconds?: number
}) => ({ scroll: true, ...overrides }) as never

describe('announcementScrollMode', () => {
  it('优先用三态字段', () => {
    expect(announcementScrollMode(item({ scrollMode: 'paced' }))).toBe('paced')
    expect(
      announcementScrollMode(item({ scrollMode: 'none', scroll: true }))
    ).toBe('none')
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

// 三个数值参数是后加的：库里的老公告、老接口响应都没有这些字段，
// 必须回落到默认值（= 升级前写死的常量），不能把 undefined/0 带进渲染。
describe('announcementScrollParams', () => {
  it('缺字段时回落默认值', () => {
    expect(announcementScrollParams(item({}))).toEqual({
      mode: 'continuous',
      speed: ANNOUNCEMENT_DEFAULT_SCROLL_SPEED,
      pauseSeconds: ANNOUNCEMENT_DEFAULT_PAUSE_SECONDS,
      displaySeconds: 0,
    })
  })

  it('显式配了就按配的算', () => {
    expect(
      announcementScrollParams(
        item({
          scrollMode: 'paced',
          scrollSpeed: 40,
          pauseSeconds: 5,
          displaySeconds: 30,
        })
      )
    ).toEqual({
      mode: 'paced',
      speed: 40,
      pauseSeconds: 5,
      displaySeconds: 30,
    })
  })

  // 0/负数只可能来自脏数据或手改库：回落到默认值，而不是让整条通知栏停下。
  it('非法值（0、负数）回落默认值', () => {
    const params = announcementScrollParams(
      item({ scrollSpeed: 0, pauseSeconds: -1, displaySeconds: -5 })
    )
    expect(params.speed).toBe(ANNOUNCEMENT_DEFAULT_SCROLL_SPEED)
    expect(params.pauseSeconds).toBe(ANNOUNCEMENT_DEFAULT_PAUSE_SECONDS)
    expect(params.displaySeconds).toBe(0)
  })
})

// 一条轨道只能有一个速度、一次停留、一个循环时长，所以逐项取最保守的那个。
describe('combinedScrollParams', () => {
  it('速度取最慢、停留与显示时长取最长', () => {
    const params = combinedScrollParams([
      item({ scrollMode: 'continuous', scrollSpeed: 90, pauseSeconds: 2 }),
      item({ scrollMode: 'continuous', scrollSpeed: 40, pauseSeconds: 8 }),
      item({ scrollMode: 'none', scrollSpeed: 120, displaySeconds: 45 }),
    ])

    // 方式取最强，速度取最慢（快的那条盖掉慢的，长内容就读不完了）。
    expect(params.mode).toBe('continuous')
    expect(params.speed).toBe(40)
    expect(params.pauseSeconds).toBe(8)
    expect(params.displaySeconds).toBe(45)
  })

  // 只要有一条填了显示时长就按它走（取最长），没填（0 = 自动）的不会把它压回自动。
  it('显示时长的「自动」不会被别的公告带偏', () => {
    expect(
      combinedScrollParams([
        item({ scrollMode: 'continuous', displaySeconds: 0 }),
        item({ scrollMode: 'continuous' }),
      ]).displaySeconds
    ).toBe(0)

    expect(
      combinedScrollParams([
        item({ scrollMode: 'continuous', displaySeconds: 0 }),
        item({ scrollMode: 'continuous', displaySeconds: 25 }),
      ]).displaySeconds
    ).toBe(25)
  })

  // 默认值不是「一条公告」，不能参与取最慢/最长：否则管理员把速度调到 100 或把停留
  // 调小到 1 秒，都会被默认的 60 / 2 秒压回去，报名现象就是「设置了不生效」。
  it('单条公告的取值不会被默认值盖掉', () => {
    const params = combinedScrollParams([
      item({ scrollMode: 'paced', scrollSpeed: 100, pauseSeconds: 1 }),
    ])

    expect(params.speed).toBe(100)
    expect(params.pauseSeconds).toBe(1)
  })

  it('空列表给出默认的一套', () => {
    expect(combinedScrollParams([])).toEqual({
      mode: 'none',
      speed: ANNOUNCEMENT_DEFAULT_SCROLL_SPEED,
      pauseSeconds: ANNOUNCEMENT_DEFAULT_PAUSE_SECONDS,
      displaySeconds: 0,
    })
  })
})

// 「每轮停留」= 滚一段（时长随内容长短或显示时长变化）+ 停一段，所以停留点随两者变化。
describe('pacedAnimationName', () => {
  it('停留点 = 滚动秒数 /（滚动秒数 + 停顿时长）', () => {
    // 20 / 22 ≈ 90.9091%
    expect(pacedAnimationName(20)).toBe('announcement-scroll-paced-909091')
    // 58 / 60 ≈ 96.6667%
    expect(pacedAnimationName(58)).toBe('announcement-scroll-paced-966667')
    // 30 / 32 = 93.75%（整数比例，名字里不带小数点）
    expect(pacedAnimationName(30)).toBe('announcement-scroll-paced-9375')
  })

  // 停留时长可配：停 5 秒时 30 / 35 ≈ 85.7143%
  it('停顿时长可配', () => {
    expect(pacedAnimationName(30, 5)).toBe('announcement-scroll-paced-857143')
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
