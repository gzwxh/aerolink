/// <reference types="@testing-library/jest-dom" />
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

// Tooltip 原语在测试里不挂 Provider，替换成透传实现，聚焦单元格自身的行为。
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}))

const mockCopyToClipboard = vi.fn()
vi.mock('@/lib/clipboard', () => ({
  copyToClipboard: (...args: unknown[]) => mockCopyToClipboard(...args),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}))

import { toast } from 'sonner'

import { ContainerImageCell } from './deployment-list-page'

const containers = [
  { name: 'app', image: 'registry.example.com/team/app:v1.2.3' },
  { name: 'sidecar', image: 'registry.example.com/team/proxy:v0.1.0' },
]

describe('容器与镜像列', () => {
  it('无容器时显示空值占位', () => {
    const { container } = render(<ContainerImageCell containers={[]} />)
    expect(container).toHaveTextContent('-')
  })

  it('每个容器显示名称与缩短后的镜像，悬浮可见完整地址', () => {
    render(<ContainerImageCell containers={containers} />)
    expect(screen.getByText('app:')).toBeInTheDocument()
    expect(screen.getByText('sidecar:')).toBeInTheDocument()
    // Tooltip 透传后完整地址始终渲染在文档里
    expect(
      screen.getByText('app: registry.example.com/team/app:v1.2.3')
    ).toBeInTheDocument()
  })

  it('点击即复制完整镜像地址', async () => {
    mockCopyToClipboard.mockResolvedValue(true)
    const user = userEvent.setup()
    render(<ContainerImageCell containers={containers} />)
    await user.click(screen.getByText('app:'))
    expect(mockCopyToClipboard).toHaveBeenCalledWith(
      'registry.example.com/team/app:v1.2.3'
    )
    expect(toast.success).toHaveBeenCalledWith('已复制到剪贴板')
  })

  it('复制失败时给出失败提示', async () => {
    mockCopyToClipboard.mockResolvedValue(false)
    const user = userEvent.setup()
    render(<ContainerImageCell containers={containers} />)
    await user.click(screen.getByText('sidecar:'))
    expect(toast.error).toHaveBeenCalledWith(
      '复制失败，请手动选择文本后复制'
    )
  })
})
