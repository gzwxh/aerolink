/// <reference types="@testing-library/jest-dom" />
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LegacyClusterRedirect } from './legacy-cluster-redirect'

vi.mock('react-i18next', () => ({
  // 组件只用 t(key[, defaultValue])，直接回 key，断言的就是 i18n 键本身。
  useTranslation: () => ({
    t: (key: string, defaultValue?: string) => defaultValue ?? key,
  }),
}))

const { mockNavigate, mockRefetch, mockUseCurrentClusterList } = vi.hoisted(
  () => ({
    mockNavigate: vi.fn(),
    mockRefetch: vi.fn(),
    mockUseCurrentClusterList: vi.fn(),
  })
)

vi.mock('@/lib/api/cluster', () => ({
  useCurrentClusterList: () => mockUseCurrentClusterList(),
}))

// 位置对象必须是稳定引用，否则 effect 的依赖每次渲染都变。
const location = { pathname: '/deployments/aerolink', search: '', hash: '' }

vi.mock('@/lib/cluster-path', () => ({
  useRawLocation: () => location,
  useRawNavigate: () => mockNavigate,
  withClusterPath: (path: string, slug?: string | null) => {
    const normalized = path.startsWith('/') ? path : `/${path}`
    if (!slug) {
      return normalized
    }
    return `/_clusters/${slug}${normalized === '/' ? '' : normalized}`
  },
}))

vi.mock('@/lib/current-cluster', () => ({
  getCurrentCluster: () => '',
  decodeClusterName: (name: string) => name,
}))

function mockClusters(clusters: Record<string, unknown>[], isFetching = false) {
  mockUseCurrentClusterList.mockReturnValue({
    data: clusters,
    isFetching,
    refetch: mockRefetch,
  })
}

describe('LegacyClusterRedirect', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('按「列表首个」补上集群段后 replace 跳转', () => {
    mockClusters([{ name: '开发环境', slug: 'dev', isDefault: true }])

    render(<LegacyClusterRedirect />)

    expect(mockNavigate).toHaveBeenCalledWith(
      '/_clusters/dev/deployments/aerolink',
      { replace: true }
    )
  })

  it('有集群但一个短名都没有时，给出可诊断的迁移提示', () => {
    mockClusters([{ name: '开发环境' }, { name: '生产环境' }])

    render(<LegacyClusterRedirect />)

    expect(
      screen.getByText('cluster.unavailable.slugMissingTitle')
    ).toBeInTheDocument()
    expect(
      screen.queryByText('cluster.unavailable.title')
    ).not.toBeInTheDocument()
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('「重新检测」重新拉取集群列表', async () => {
    mockClusters([{ name: '开发环境' }])

    render(<LegacyClusterRedirect />)
    await userEvent.click(
      screen.getByRole('button', { name: 'cluster.unavailable.retry' })
    )

    expect(mockRefetch).toHaveBeenCalled()
  })

  it('列表真的为空时保留原提示，且不给重新检测', () => {
    mockClusters([])

    render(<LegacyClusterRedirect />)

    expect(screen.getByText('cluster.unavailable.title')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'cluster.unavailable.retry' })
    ).not.toBeInTheDocument()
  })

  it('拉取中不宣布没有可用集群', () => {
    mockClusters([], true)

    render(<LegacyClusterRedirect />)

    expect(
      screen.getByText('cluster.unavailable.redirecting')
    ).toBeInTheDocument()
  })
})
