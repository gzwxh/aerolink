/// <reference types="@testing-library/jest-dom" />
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { Cluster } from '@/types/api'

import { ClusterBadgeDialog } from './cluster-badge-dialog'

vi.mock('react-i18next', () => ({
  // 组件只用 t(key, defaultValue)，直接回 defaultValue。
  useTranslation: () => ({
    t: (key: string, defaultValue?: string) => defaultValue ?? key,
  }),
  // 未保存确认弹窗用 Trans 拼富文本，这里的断言不关心它的文案。
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}))

vi.mock('@/lib/api', () => ({
  uploadClusterBadgeIcon: vi.fn(),
  deleteClusterBadgeIcon: vi.fn(),
}))

const cluster = {
  id: 1,
  name: 'dev',
  badgeEnabled: true,
  badgeText: '开发环境',
  badgeIconEnabled: true,
  badgeIconText: 'PROD',
} as Cluster

function renderDialog(onSubmit: (data: unknown) => void) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <ClusterBadgeDialog
        open
        onOpenChange={() => {}}
        cluster={cluster}
        onSubmit={onSubmit}
      />
    </QueryClientProvider>
  )
}

/** 图标文本字号是「自动 / 小 / 标准 / 大」的按钮组，按无障碍名称取到对应的那一项。 */
function sizeOption(groupName: string, label: string) {
  const group = screen.getByRole('radiogroup', { name: groupName })
  return within(group).getByRole('radio', { name: label })
}

/** 说明字号是像素输入框（10–24），留空按标准档。 */
function setTextSize(value: string) {
  // number 输入框在 jsdom 下没有 user-event 依赖的 value setter，直接派发 input 事件。
  fireEvent.input(screen.getByLabelText('字号'), { target: { value } })
}

describe('ClusterBadgeDialog 字号与加粗', () => {
  // 字号/加粗是草稿态字段：必须随「应用」一起提交，否则用户选完保存后
  // 展示端拿到的还是默认排版。
  it('说明选了大字号并加粗后，提交体带上 badgeTextSize 与 badgeBold', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    renderDialog(onSubmit)

    setTextSize('18')
    await user.click(screen.getByRole('switch', { name: '加粗' }))
    await user.type(screen.getByPlaceholderText('留空自动'), '#00ffff')
    await user.click(screen.getByRole('button', { name: '应用' }))

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        badgeTextSize: '18',
        badgeBold: true,
        badgeTextColor: '#00ffff',
      })
    )
  })

  // 图标文本的排版与说明各有一套：只改图标的那组，不能串到说明的字段上。
  it('图标文本的字号、加粗与颜色单独提交', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    renderDialog(onSubmit)

    await user.click(sizeOption('图标文本字号', '大'))
    await user.click(screen.getByRole('switch', { name: '图标文本加粗' }))
    await user.type(screen.getByPlaceholderText('同徽章'), '#112233')
    await user.type(screen.getByPlaceholderText('留空按底色'), '#ffcc00')
    await user.click(screen.getByRole('button', { name: '应用' }))

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        badgeIconTextSize: 'lg',
        badgeIconBold: true,
        badgeIconTextColor: '#ffcc00',
        badgeIconTextBackground: '#112233',
        badgeTextSize: '12',
        badgeBold: false,
        badgeTextColor: '',
      })
    )
  })

  // 自定义字号限定 10–24：越界时按钮禁用，不让明显超出范围的值提交上去。
  it('字号超出范围时不允许提交', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    renderDialog(onSubmit)

    setTextSize('30')

    expect(screen.getByRole('button', { name: '应用' })).toBeDisabled()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('老数据没有样式设置时按默认档回填并原样提交', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    renderDialog(onSubmit)

    await user.click(screen.getByRole('button', { name: '应用' }))

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        badgeTextSize: '12',
        badgeBold: false,
        badgeTextColor: '',
        badgeIconTextSize: '',
        badgeIconTextColor: '',
        badgeIconTextBackground: '',
        badgeIconBold: false,
      })
    )
  })
})
