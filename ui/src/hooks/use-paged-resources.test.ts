import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { usePagedResources } from './use-paged-resources'

const { mockFetchResources } = vi.hoisted(() => ({
  mockFetchResources: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  fetchResources: (...args: unknown[]) => mockFetchResources(...args),
}))

type Row = {
  metadata: { name: string; uid?: string; creationTimestamp?: string }
}

const row = (name: string, uid: string, creationTimestamp: string): Row => ({
  metadata: { name, uid, creationTimestamp },
})

describe('usePagedResources', () => {
  beforeEach(() => {
    mockFetchResources.mockReset()
  })

  // 回归：「全部命名空间」不再一次拉全量，首批必须带 limit，并把 continue
  // 留给「加载更多」。
  it('首批只取一页，并暴露 continue token', async () => {
    mockFetchResources.mockResolvedValueOnce({
      items: [
        row('a', '1', '2026-01-01T00:00:00Z'),
        row('b', '2', '2026-01-02T00:00:00Z'),
      ],
      metadata: { continue: 'next' },
    })

    const { result } = renderHook(() =>
      usePagedResources('deployments', { namespace: '_all', pageSize: 2 })
    )

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(mockFetchResources).toHaveBeenCalledTimes(1)
    expect(mockFetchResources.mock.calls[0][2]).toMatchObject({ limit: 2 })
    // 跨批次合并后按创建时间倒序。
    expect(result.current.data?.map((item) => item.metadata.name)).toEqual([
      'b',
      'a',
    ])
    expect(result.current.hasMore).toBe(true)
  })

  it('加载更多用上一批的 continue token 追加，并去重', async () => {
    mockFetchResources
      .mockResolvedValueOnce({
        items: [row('b', '2', '2026-01-02T00:00:00Z')],
        metadata: { continue: 'next' },
      })
      .mockResolvedValueOnce({
        items: [
          row('b', '2', '2026-01-02T00:00:00Z'),
          row('a', '1', '2026-01-01T00:00:00Z'),
        ],
        metadata: {},
      })

    const { result } = renderHook(() =>
      usePagedResources('deployments', { namespace: '_all', pageSize: 1 })
    )

    await waitFor(() => expect(result.current.hasMore).toBe(true))

    await act(async () => {
      await result.current.loadMore()
    })

    expect(mockFetchResources.mock.calls[1][2]).toMatchObject({
      limit: 1,
      continueToken: 'next',
    })
    expect(result.current.data?.map((item) => item.metadata.name)).toEqual([
      'b',
      'a',
    ])
    expect(result.current.hasMore).toBe(false)
  })

  // 服务端在 limit 之后才按 RBAC 逐项过滤，一页可能被滤空；此时要继续往后
  // 翻，否则用户会看到「有更多但当前为空」。
  it('整页被权限过滤掉时继续往后翻', async () => {
    mockFetchResources
      .mockResolvedValueOnce({ items: [], metadata: { continue: 'next' } })
      .mockResolvedValueOnce({
        items: [row('a', '1', '2026-01-01T00:00:00Z')],
        metadata: {},
      })

    const { result } = renderHook(() =>
      usePagedResources('deployments', { namespace: '_all', pageSize: 2 })
    )

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(mockFetchResources).toHaveBeenCalledTimes(2)
    expect(result.current.data).toHaveLength(1)
    expect(result.current.hasMore).toBe(false)
  })
})
