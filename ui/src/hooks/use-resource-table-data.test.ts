import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useResourceTableData } from './use-resource-table-data'

const { mockUsePagedResources, mockUseResources, mockUseResourcesWatch } =
  vi.hoisted(() => ({
    mockUsePagedResources: vi.fn(),
    mockUseResources: vi.fn(),
    mockUseResourcesWatch: vi.fn(),
  }))

vi.mock('@/lib/api', () => ({
  useResources: (...args: unknown[]) => mockUseResources(...args),
  useResourcesWatch: (...args: unknown[]) => mockUseResourcesWatch(...args),
}))

vi.mock('@/hooks/use-paged-resources', () => ({
  usePagedResources: (...args: unknown[]) => mockUsePagedResources(...args),
}))

const idleQuery = {
  data: undefined,
  isLoading: false,
  isError: false,
  error: null,
  refetch: vi.fn(),
}

describe('useResourceTableData', () => {
  beforeEach(() => {
    mockUsePagedResources.mockReset().mockReturnValue({
      ...idleQuery,
      hasMore: false,
      isLoadingMore: false,
      loadMore: vi.fn(),
    })
    mockUseResources.mockReset().mockReturnValue({ ...idleQuery })
    mockUseResourcesWatch.mockReset().mockReturnValue({
      ...idleQuery,
      isConnected: false,
    })
  })

  // 回归：多选命名空间折叠成 `_all` 后，集合必须交给服务端收窄，同时仍走
  // 服务端分页——否则选中集合排在分页窗口之外时列表会恒为空。
  it('多选命名空间时把集合透传给分页请求，并保持分页模式', () => {
    renderHook(() =>
      useResourceTableData({
        resourceName: 'deployments',
        namespace: '_all',
        useSSE: false,
        refreshInterval: 0,
        namespaces: ['swy-base', 'swy-congo'],
      })
    )

    expect(mockUsePagedResources.mock.calls[0][1]).toMatchObject({
      enabled: true,
      namespaces: ['swy-base', 'swy-congo'],
    })
    expect(mockUseResources.mock.calls[0][2]).toMatchObject({
      disable: true,
      namespaces: ['swy-base', 'swy-congo'],
    })
  })

  it('「全部命名空间」不传集合', () => {
    renderHook(() =>
      useResourceTableData({
        resourceName: 'deployments',
        namespace: '_all',
        useSSE: false,
        refreshInterval: 0,
      })
    )

    expect(mockUsePagedResources.mock.calls[0][1]).toMatchObject({
      enabled: true,
      namespaces: undefined,
    })
  })

  it('单命名空间不走分页', () => {
    renderHook(() =>
      useResourceTableData({
        resourceName: 'deployments',
        namespace: 'swy-base',
        useSSE: false,
        refreshInterval: 0,
      })
    )

    expect(mockUsePagedResources.mock.calls[0][1]).toMatchObject({
      enabled: false,
    })
    expect(mockUseResources.mock.calls[0][2]).toMatchObject({ disable: false })
  })
})
