/// <reference types="@testing-library/jest-dom" />
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AnnouncementManagement } from './announcement-management'

const mutate = vi.hoisted(() => vi.fn())
// 列表数据放在可变的 store 里：有的用例需要「两条同时生效的公告」。
const store = vi.hoisted(() => ({ items: [] as unknown[] }))

const BASE_ITEM = {
  id: 7,
  title: '维护通知',
  content: '{warning}今晚 22:00 停服{/warning}',
  level: 'warning',
  priority: 3,
  enabled: true,
  // 特意取 false：覆盖式 PUT 若漏传这个字段（或把它当默认 true 处理），
  // 断言会立刻失败——这是最容易悄悄丢掉的一个设置。
  scroll: false,
  startAt: '2026-09-21T14:00:00+08:00',
  endAt: '2026-09-21T16:00:00+08:00',
  creatorId: 1,
  createdAt: '2026-09-21T10:00:00+08:00',
  updatedAt: '2026-09-21T10:00:00+08:00',
}

vi.mock('@/lib/api', () => ({
  useAllAnnouncements: () => ({
    data: { items: store.items },
    isLoading: false,
  }),
  useCreateAnnouncement: () => ({ mutate, isPending: false }),
  useUpdateAnnouncement: () => ({ mutate, isPending: false }),
  useDeleteAnnouncement: () => ({ mutate, isPending: false }),
}))

vi.mock('@/contexts/settings-section-context', () => ({
  useSettingsSectionAccess: () => ({ readOnly: false }),
}))

vi.mock('react-i18next', () => ({
  // 编辑弹窗里的未保存确认对话框用了 <Trans>，这里给一个最小实现（回显 key）。
  Trans: ({ i18nKey }: { i18nKey?: string }) => i18nKey ?? null,
  useTranslation: () => ({
    // 只能拿到 defaultValue 的键走 defaultValue；级别那三个键在代码里没写默认值
    // （中文是唯一事实来源），所以在这里补上，避免断言变成在断言 key。
    t: (key: string, options?: unknown) =>
      LEVEL_LABELS[key] ??
      (typeof options === 'string'
        ? options
        : ((options as { defaultValue?: string })?.defaultValue ?? key)),
  }),
}))

const LEVEL_LABELS: Record<string, string> = {
  'notifications.announcements.levels.info': '提示',
  'notifications.announcements.levels.warning': '警告',
  'notifications.announcements.levels.danger': '严重',
}

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

beforeEach(() => {
  store.items = [BASE_ITEM]
  mutate.mockClear()
})

describe('AnnouncementManagement 行内操作', () => {
  // 「启动」与「等级」是最常调的开关，不该强迫管理员先点开编辑弹窗。
  it('不打开编辑弹窗也能停用一条公告', () => {
    render(<AnnouncementManagement />)

    fireEvent.click(screen.getByRole('switch', { name: '启用' }))

    expect(mutate).toHaveBeenCalledTimes(1)
    const [payload] = mutate.mock.calls[0]
    expect(payload.id).toBe(7)
    // 接口是覆盖式的 PUT：除改动字段外，其余字段原样回传。
    expect(payload.data).toEqual({
      title: '维护通知',
      content: '{warning}今晚 22:00 停服{/warning}',
      level: 'warning',
      priority: 3,
      enabled: false,
      // 覆盖式 PUT 不会带上没传的字段：行内改动必须把滚动设置一起回传，
      // 否则一次点「启用」就会把管理员的「不滚动」设置悄悄清掉。
      scroll: false,
      // scrollMode 是新口径，与 scroll 成对回传；老数据没有该字段时按 scroll 推导。
      scrollMode: 'none',
      // 三个滚动参数同样是覆盖式 PUT 的受害者：漏传一次行内改动就被重置成默认值。
      // 老数据没有这些字段，兜底成默认值回传（60px/s、停留 2 秒、时长自动）。
      scrollSpeed: 60,
      pauseSeconds: 2,
      displaySeconds: 0,
      startAt: '2026-09-21T14:00:00+08:00',
      endAt: '2026-09-21T16:00:00+08:00',
    })
  })

  // 右侧只有下拉与开关，扫一眼列表读不出「现在是启用还是停用」「滚不滚动」，
  // 所以这几项状态都要写成文字。
  it('列表行把启用与滚动状态写成文字', () => {
    render(<AnnouncementManagement />)

    expect(screen.getByText('已启用')).toBeInTheDocument()
    expect(screen.getByText('不滚动')).toBeInTheDocument()
  })

  it('等级是行内下拉，默认显示当前值', () => {
    render(<AnnouncementManagement />)

    const level = screen.getByRole('combobox', { name: '级别' })
    expect(level).toHaveTextContent('警告')
  })

  it('行内仍然可以打开编辑弹窗', () => {
    render(<AnnouncementManagement />)

    fireEvent.click(screen.getByRole('button', { name: '编辑' }))

    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})

// 顶栏把生效公告串成一条轨道、滚动方式取最强的一种：如果界面不说这一句，
// 管理员看到的就是「选了不滚动却还在滚」，像设置没保存。
describe('AnnouncementManagement 滚动方式合并提示', () => {
  const twoActive = () => [
    {
      ...BASE_ITEM,
      id: 1,
      title: '甲',
      startAt: '',
      endAt: '',
      scroll: false,
      scrollMode: 'none',
    },
    {
      ...BASE_ITEM,
      id: 2,
      title: '乙',
      startAt: '',
      endAt: '',
      scroll: true,
      scrollMode: 'paced',
    },
  ]

  it('行内标出被别的生效公告盖过后的实际效果', () => {
    store.items = twoActive()

    const { container } = render(<AnnouncementManagement />)

    const hint = container.querySelector('[data-scroll-mode-actual]')
    expect(hint).toHaveAttribute('data-scroll-mode-actual', 'paced')
    // 自身设置仍照实显示，只是在后面补了「实际：…」。
    expect(container.textContent).toContain('不滚动')
  })

  it('编辑弹窗里提示本条设置会被别的公告盖过', () => {
    store.items = twoActive()

    render(<AnnouncementManagement />)
    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0])

    expect(
      document.querySelector('[data-scroll-mode-conflict]')
    ).toHaveAttribute('data-scroll-mode-conflict', 'paced')
  })

  it('只有一条生效公告时不提示（设置就是最终效果）', () => {
    store.items = [
      {
        ...BASE_ITEM,
        id: 3,
        title: '丙',
        startAt: '',
        endAt: '',
        scroll: false,
        scrollMode: 'none',
      },
    ]

    const { container } = render(<AnnouncementManagement />)

    expect(container.querySelector('[data-scroll-mode-actual]')).toBeNull()
  })
})

// 速度 / 每轮停留 / 显示时长也是「每条各配、整条合并」，合并规则同滚动方式：
// 速度取最慢、停留与显示时长取最长。界面必须把结果写出来，否则又是「改了没生效」。
describe('AnnouncementManagement 滚动参数', () => {
  const paramsOf = (mutateFn: typeof mutate) =>
    mutateFn.mock.calls[0][0].data as Record<string, unknown>

  it('编辑弹窗里改的速度/停留/时长会原样回传', () => {
    store.items = [{ ...BASE_ITEM, scroll: true, scrollMode: 'continuous' }]

    render(<AnnouncementManagement />)
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))

    fireEvent.change(screen.getByLabelText('滚动速度'), {
      target: { value: '40' },
    })
    fireEvent.change(screen.getByLabelText('每轮停留'), {
      target: { value: '5' },
    })
    fireEvent.change(screen.getByLabelText('显示时长'), {
      target: { value: '30' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(paramsOf(mutate)).toMatchObject({
      scrollSpeed: 40,
      pauseSeconds: 5,
      displaySeconds: 30,
    })
  })

  // 数字输入必须能清空：受控输入若在删空的那一刻就回落成默认值，管理员只能从 60
  // 一点点加减，想填 300 得点几十下。
  it('数值输入可以清空后重新输入', () => {
    store.items = [{ ...BASE_ITEM, scroll: true, scrollMode: 'paced' }]

    render(<AnnouncementManagement />)
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))

    const pause = screen.getByLabelText('每轮停留') as HTMLInputElement
    fireEvent.change(pause, { target: { value: '' } })
    expect(pause.value).toBe('')

    fireEvent.change(pause, { target: { value: '1' } })
    expect(pause.value).toBe('1')

    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(paramsOf(mutate)).toMatchObject({ pauseSeconds: 1 })
  })

  // 清空后直接保存：空串按默认值算，绝不能把 0 发给后端（会被区间校验拒绝）。
  it('数值清空后保存按默认值发送', () => {
    store.items = [{ ...BASE_ITEM, scroll: true, scrollMode: 'paced' }]

    render(<AnnouncementManagement />)
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.change(screen.getByLabelText('每轮停留'), {
      target: { value: '' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(paramsOf(mutate)).toMatchObject({ pauseSeconds: 2 })
  })

  // 弹窗里有滚动预览（与顶栏同一个组件），改了参数能立刻看到效果。
  it('编辑弹窗里有滚动预览', () => {
    store.items = [{ ...BASE_ITEM }]

    render(<AnnouncementManagement />)
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))

    // 弹窗走 Portal，挂在 body 下，所以不能查 render 的 container。
    expect(document.querySelector('[data-announcement-preview]')).not.toBeNull()
  })

  // 标题和正文都空的公告保存不了，也就无法启用：按钮要灰掉，并写清原因。
  it('内容为空时不能保存并提示原因', () => {
    store.items = [{ ...BASE_ITEM, content: '' }]

    render(<AnnouncementManagement />)
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))

    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
    expect(screen.getByText(/内容不能为空/)).toBeTruthy()
  })

  // 标题是可选项：清空标题后仍要能保存（保存按钮不能因此变灰），
  // 回传的是空串而不是被前端擅自补上的占位文字。
  it('标题可以留空，只写内容也能保存', () => {
    store.items = [{ ...BASE_ITEM }]

    render(<AnnouncementManagement />)
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.change(screen.getByLabelText('标题（可选）'), {
      target: { value: '' },
    })

    const save = screen.getByRole('button', { name: '保存' })
    expect(save).toBeEnabled()
    fireEvent.click(save)

    expect(paramsOf(mutate)).toMatchObject({ title: '' })
  })

  // 列表行首是标题，没标题时不能留白，否则一列公告分不清哪条是哪条。
  it('列表里没标题的公告显示占位', () => {
    store.items = [{ ...BASE_ITEM, title: '   ' }]

    render(<AnnouncementManagement />)

    expect(screen.getByText('无标题')).toBeTruthy()
  })

  // 填了显示时长就不再按宽度 ÷ 速度换算，速度输入必须置灰，
  // 否则「改了速度没反应」又会变成一个 bug 报告。
  it('填了显示时长后速度输入置灰', () => {
    store.items = [
      { ...BASE_ITEM, id: 9, scroll: true, scrollMode: 'continuous' },
    ]

    render(<AnnouncementManagement />)
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))

    const speed = screen.getByLabelText('滚动速度')
    expect(speed).toBeEnabled()

    fireEvent.change(screen.getByLabelText('显示时长'), {
      target: { value: '30' },
    })

    expect(speed).toBeDisabled()
  })

  // 速度取最慢的那条：自己填 90、另一条生效公告填 30，整条轨道按 30 走。
  it('列表标出被更慢公告盖过后的实际速度', () => {
    store.items = [
      {
        ...BASE_ITEM,
        id: 1,
        title: '快',
        startAt: '',
        endAt: '',
        scroll: true,
        scrollMode: 'continuous',
        scrollSpeed: 90,
      },
      {
        ...BASE_ITEM,
        id: 2,
        title: '慢',
        startAt: '',
        endAt: '',
        scroll: true,
        scrollMode: 'continuous',
        scrollSpeed: 30,
      },
    ]

    const { container } = render(<AnnouncementManagement />)

    const actual = container.querySelector('[data-scroll-params-actual]')
    expect(actual).not.toBeNull()
    expect(actual?.getAttribute('data-scroll-params-actual')).toContain(
      '30 px/s'
    )
  })

  it('每条参数一致时不提示', () => {
    store.items = [
      {
        ...BASE_ITEM,
        id: 1,
        title: '甲',
        startAt: '',
        endAt: '',
        scroll: true,
        scrollMode: 'continuous',
        scrollSpeed: 40,
      },
      {
        ...BASE_ITEM,
        id: 2,
        title: '乙',
        startAt: '',
        endAt: '',
        scroll: true,
        scrollMode: 'continuous',
        scrollSpeed: 40,
      },
    ]

    const { container } = render(<AnnouncementManagement />)

    expect(container.querySelector('[data-scroll-params-actual]')).toBeNull()
  })
})
