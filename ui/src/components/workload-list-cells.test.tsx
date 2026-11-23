/// <reference types="@testing-library/jest-dom" />
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { describe, expect, it, vi } from 'vitest'

import { WorkloadHealthBar, WorkloadImageCell } from './workload-list-cells'

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

const containers = [
  { name: 'app', image: 'registry.example.com/team/app:v1.2.3' },
  { name: 'sidecar', image: 'registry.example.com/team/proxy:v0.1.0' },
]

describe('健康列（行内伸缩）', () => {
  // 回归（第 19 轮 D-155）：这里曾对所有类型硬用 scaleDeployment 的说明，
  // 于是 StatefulSet 列表的行内提示写着「调整此 Deployment 的副本数。」。
  // t() 在本测试的 mock 里回退成键名本身，正好能断言取的是哪个键。
  it('StatefulSet 与 Deployment 各拿自己类型的伸缩文案', () => {
    // 伸缩单元格自己会拿 QueryClient（完成后要重取列表），测试里给它一个。
    const wrap = (ui: React.ReactElement) =>
      render(
        <QueryClientProvider client={new QueryClient()}>
          {ui}
        </QueryClientProvider>
      )

    const { unmount } = wrap(
      <WorkloadHealthBar
        ready={2}
        desired={2}
        name="sfs"
        namespace="default"
        resourceType="statefulsets"
        canUpdate
      />
    )
    const sfsTitle = screen.getByRole('button').getAttribute('title') ?? ''
    expect(sfsTitle).toContain('scaleStatefulSet')
    expect(sfsTitle).not.toContain('scaleDeployment')
    unmount()

    wrap(
      <WorkloadHealthBar
        ready={1}
        desired={1}
        name="dpl"
        namespace="default"
        resourceType="deployments"
        canUpdate
      />
    )
    expect(screen.getByRole('button').getAttribute('title')).toContain(
      'scaleDeployment'
    )
  })
})

describe('镜像列', () => {
  it('无容器时显示空值占位', () => {
    const { container } = render(<WorkloadImageCell containers={[]} />)
    expect(container).toHaveTextContent('-')
  })

  it('每个容器显示名称与缩短后的镜像，悬浮可见完整地址', () => {
    render(<WorkloadImageCell containers={containers} />)
    expect(screen.getByText('app:')).toBeInTheDocument()
    expect(screen.getByText('sidecar:')).toBeInTheDocument()
    // Tooltip 透传后完整地址始终渲染在文档里
    expect(
      screen.getByText('app: registry.example.com/team/app:v1.2.3')
    ).toBeInTheDocument()
  })

  it('单容器时不再重复容器名', () => {
    render(<WorkloadImageCell containers={[containers[0]]} />)
    expect(screen.queryByText('app:')).not.toBeInTheDocument()
    expect(screen.getByText(/team\/app:v1\.2\.3$/)).toBeInTheDocument()
  })

  it('点击即复制完整镜像地址', async () => {
    mockCopyToClipboard.mockResolvedValue(true)
    const user = userEvent.setup()
    render(<WorkloadImageCell containers={containers} />)
    await user.click(screen.getByText('app:'))
    expect(mockCopyToClipboard).toHaveBeenCalledWith(
      'registry.example.com/team/app:v1.2.3'
    )
    expect(toast.success).toHaveBeenCalledWith('已复制到剪贴板')
  })

  it('复制失败时给出失败提示', async () => {
    mockCopyToClipboard.mockResolvedValue(false)
    const user = userEvent.setup()
    render(<WorkloadImageCell containers={containers} />)
    await user.click(screen.getByText('sidecar:'))
    expect(toast.error).toHaveBeenCalledWith('复制失败，请手动选择文本后复制')
  })
})
