/// <reference types="@testing-library/jest-dom" />
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AnnouncementManagement } from './announcement-management'

const mutate = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', () => ({
  useAllAnnouncements: () => ({
    data: {
      items: [
        {
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
        },
      ],
    },
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
