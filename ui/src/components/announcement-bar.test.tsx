import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AnnouncementBar } from './announcement-bar'

const useAnnouncements = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', () => ({
  useAnnouncements: () => useAnnouncements(),
}))

function announcement(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    title: '维护通知',
    content: '今晚 22:00 停服',
    level: 'info',
    priority: 0,
    enabled: true,
    creatorId: 1,
    createdAt: '2026-09-21T10:00:00Z',
    updatedAt: '2026-09-21T10:00:00Z',
    ...overrides,
  }
}

function renderBar(items: unknown[]) {
  useAnnouncements.mockReturnValue({ data: { items } })
  return render(<AnnouncementBar />)
}

/** 把「内容宽度 / 视口宽度」固定下来，用来验证滚动只在超宽时开启。 */
function stubWidths(contentWidth: number, viewportWidth: number) {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    width: contentWidth,
  } as DOMRect)
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(
    viewportWidth
  )
}

function stubReducedMotion() {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  )
}

describe('AnnouncementBar', () => {
  it('没有生效中的公告时不渲染任何节点', () => {
    const { container } = renderBar([])
    expect(container.firstChild).toBeNull()
  })

  it('标题与正文一起输出，图标颜色取最高级别', () => {
    const { container } = renderBar([
      announcement({ id: 1, level: 'info', title: '低优先级' }),
      announcement({ id: 2, level: 'warning', title: '高优先级' }),
    ])

    const bar = container.firstElementChild as HTMLElement
    expect(bar).toHaveAttribute('role', 'region')
    // 内容会为循环重复多份，所以按文本内容断言，不按「唯一元素」断言。
    expect(bar.textContent).toContain('低优先级')
    expect(bar.textContent).toContain('高优先级')
    // 级别取最高：info + warning → warning 的图标色（通知栏本身不套色框）。
    expect(bar.querySelector('svg.text-warning')).not.toBeNull()
    expect(bar.className).not.toMatch(/\b(border|rounded)/)
  })

  it('正文里的颜色标记渲染成对应的语义色', () => {
    const { container } = renderBar([
      announcement({
        content: '{warning}今晚停服{/warning}，{danger}请勿操作{/danger}',
      }),
    ])

    expect(container.querySelector('.text-warning')?.textContent).toBe(
      '今晚停服'
    )
    expect(container.querySelector('.text-destructive')?.textContent).toBe(
      '请勿操作'
    )
  })

  // Markdown 里的两个换行会切成两个段落，而段落被渲染成相邻的两个 span：
  // 不做合并的话「第一段第二段」会粘成一个词。
  it('正文里的空行合并成单个空白', () => {
    const { container } = renderBar([
      announcement({ content: '第一段\n\n第二段' }),
    ])

    // textContent 里留下的是换行符，浏览器按空白渲染（= 一个空格），这里按同一口径断言。
    const text = (container.textContent ?? '').replace(/\s+/g, ' ')
    expect(text).toContain('第一段 第二段')
  })

  // 短内容也要滚（管理员要的就是「滚动输出」），所以先把它重复到铺满可视区，
  // 后面的副本用于 -50% 的无缝循环。
  it('内容比可视区窄时重复铺满并滚动', () => {
    stubWidths(100, 400)
    const { container } = renderBar([announcement()])

    const track = container.querySelector('.announcement-track') as HTMLElement
    expect(track).toHaveClass('is-scrolling')
    // ceil(400 / 100) = 4 份铺满，再 4 份用于循环。
    expect(container.querySelectorAll('.announcement-run')).toHaveLength(8)
    expect(
      container.querySelectorAll('[aria-hidden="true"].announcement-run')
    ).toHaveLength(7)
  })

  it('内容超宽时滚动，并按宽度算出时长', () => {
    // 1200px / 60px 每秒 = 20s；一份就比可视区宽，不必重复。
    stubWidths(1200, 400)
    const { container } = renderBar([announcement()])

    const track = container.querySelector('.announcement-track') as HTMLElement
    expect(track).toHaveClass('is-scrolling')
    expect(track.style.getPropertyValue('--announcement-duration')).toBe('20s')
    expect(container.querySelectorAll('.announcement-run')).toHaveLength(2)
  })

  // 真机反馈：连续滚动一轮接一轮，长公告来不及读。paced 走完一轮停固定 2 秒——
  // 滚动段仍按内容宽度算（所以每轮滚多久随公告长短变化），停留固定 2 秒。
  it('每轮停留模式：滚完停 2 秒，关键帧按实际滚动时长生成', () => {
    stubWidths(1200, 400)
    const { container } = renderBar([
      announcement({ scroll: true, scrollMode: 'paced' }),
    ])

    const track = container.querySelector('.announcement-track') as HTMLElement
    expect(track).toHaveClass('is-scrolling')
    expect(track).toHaveClass('is-paced')
    // 1200 / 60 = 20s 滚动 + 2s 停留 → 22s。
    expect(track.style.getPropertyValue('--announcement-duration')).toBe('22s')
    // 停留点 = 20 / 22 ≈ 90.9091%，编进动画名，关键帧同时注入到 <head>。
    const name = 'announcement-scroll-paced-909091'
    expect(track.style.getPropertyValue('--announcement-animation')).toBe(name)
    const injected = document.head.querySelector(
      `style[data-announcement-keyframes="${name}"]`
    )
    expect(injected?.textContent).toContain(`@keyframes ${name}`)
    expect(injected?.textContent).toContain('90.9091%')
  })

  it('连续滚动不带停留关键帧', () => {
    stubWidths(1200, 400)
    const { container } = renderBar([
      announcement({ scroll: true, scrollMode: 'continuous' }),
    ])

    const track = container.querySelector('.announcement-track') as HTMLElement
    expect(track).toHaveClass('is-scrolling')
    expect(track).not.toHaveClass('is-paced')
    expect(track.style.getPropertyValue('--announcement-duration')).toBe('20s')
  })

  // 多条公告串成一条轨道，没法一半一种方式：取「最强」的那种。
  it('多条里有一条要求停留时整条都按停留走', () => {
    stubWidths(1200, 400)
    const { container } = renderBar([
      announcement({ id: 1, scrollMode: 'continuous' }),
      announcement({ id: 2, scrollMode: 'paced' }),
    ])

    const track = container.querySelector('.announcement-track') as HTMLElement
    expect(track).toHaveClass('is-paced')
  })

  // 滚动只是「读全」的手段之一：消息太长时用户来不及看完，
  // 所以要能按住拖动看前后文（悬停时动画已暂停，拖的就是静止的内容）。
  it('按住横向拖动可以看前后文', () => {
    stubWidths(1200, 400)
    const { container } = renderBar([announcement()])

    const viewport = container.querySelector(
      '.announcement-viewport'
    ) as HTMLElement
    // 可视化（jsdom 没有布局）：scrollLeft 自己托管，只验证写入的偏移量。
    let scrollLeft = 200
    Object.defineProperty(viewport, 'scrollLeft', {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => {
        scrollLeft = value
      },
    })

    fireEvent.pointerDown(viewport, { button: 0, clientX: 300 })
    fireEvent.pointerMove(viewport, { clientX: 260 })
    // 向左拖 40px → 内容跟着往左走（scrollLeft 增加 40）。
    expect(scrollLeft).toBe(240)

    fireEvent.pointerUp(viewport)
    fireEvent.pointerMove(viewport, { clientX: 100 })
    expect(scrollLeft).toBe(240)
  })

  it('右键按下不会进入拖动状态', () => {
    stubWidths(1200, 400)
    const { container } = renderBar([announcement()])
    const viewport = container.querySelector(
      '.announcement-viewport'
    ) as HTMLElement
    let scrollLeft = 0
    Object.defineProperty(viewport, 'scrollLeft', {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => {
        scrollLeft = value
      },
    })

    fireEvent.pointerDown(viewport, { button: 2, clientX: 300 })
    fireEvent.pointerMove(viewport, { clientX: 100 })
    expect(scrollLeft).toBe(0)
  })

  it('展开全文会给出可换行的完整内容', () => {
    const { container } = renderBar([
      announcement({ title: '维护通知', content: '今晚 22:00 停服' }),
    ])
    const before = container.textContent ?? ''

    fireEvent.click(
      // 展开按钮在通知栏里（顶栏的其它按钮不在这个测试的渲染范围）。
      container.querySelector('[aria-label="展开全文"]') as HTMLElement
    )

    // 弹层里每一个字段各一份，因此出现次数比展开前多。
    const after = document.body.textContent ?? ''
    expect(after.length).toBeGreaterThan(before.length)
    expect(after).toContain('今晚 22:00 停服')
  })

  // 公告可以配置成不滚动：此时只渲染一份内容，不再铺重复副本做循环；
  // 按住拖动与右侧的「展开全文」都还在。
  it('公告关闭横向滚动时静止显示', () => {
    stubWidths(1200, 400)
    const { container } = renderBar([announcement({ scroll: false })])

    expect(container.querySelector('.announcement-track')).not.toHaveClass(
      'is-scrolling'
    )
    // 静止时只渲染一份内容，否则文字会出现两遍。
    expect(container.querySelectorAll('.announcement-run')).toHaveLength(1)
  })

  // 多条公告串成一条轨道输出，没法一半滚一半不滚：任一条要求滚动就滚动
  // （与「级别取最高」同一套取舍）。
  it('只要有一条公告开启滚动，整条通知栏就滚动', () => {
    stubWidths(1200, 400)
    const { container } = renderBar([
      announcement({ id: 1, scroll: false }),
      announcement({ id: 2, scroll: true }),
    ])

    expect(container.querySelector('.announcement-track')).toHaveClass(
      'is-scrolling'
    )
  })

  // 系统级的减弱动效**不再**否决公告的滚动配置：滚动是管理员按条给出的内容呈现要求，
  // 被客户端偏好静默推翻，会得到「勾了滚动却没滚、也没有任何解释」（用户实测反馈）。
  it('系统开启减弱动效时，仍按公告的配置滚动', () => {
    stubReducedMotion()
    stubWidths(1200, 400)
    const { container } = renderBar([announcement()])

    expect(container.querySelector('.announcement-track')).toHaveClass(
      'is-scrolling'
    )
  })

  // 拖动查看与滚不滚无关：内容很长时用户来不及看完，随时都要能拖。
  it('按住拖动可以查看前后文', () => {
    stubWidths(1200, 400)
    const { container } = renderBar([announcement()])

    const viewport = container.querySelector(
      '.announcement-viewport'
    ) as HTMLElement
    let scrollLeft = 200
    Object.defineProperty(viewport, 'scrollLeft', {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => {
        scrollLeft = value
      },
    })
    fireEvent.pointerDown(viewport, { button: 0, clientX: 300 })
    fireEvent.pointerMove(viewport, { clientX: 260 })
    expect(scrollLeft).toBe(240)

    // 展开全文与滚动无关，任何时候都在。
    expect(container.querySelector('[aria-label="展开全文"]')).not.toBeNull()
  })
})
