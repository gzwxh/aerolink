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

  // 回归：后端若漏抹 informer 缓存的假 continue token（每次都返回同一批 + 非空
  // continue），fetchBatch 会循环拉满多轮；批内必须按 itemKey 去重，不能把同一行叠加。
  it('后端重复返回同一批数据时，批内按 itemKey 去重', async () => {
    mockFetchResources.mockImplementation(async () => ({
      items: [
        row('a', '1', '2026-01-01T00:00:00Z'),
        row('b', '2', '2026-01-02T00:00:00Z'),
      ],
      metadata: { continue: 'fake' },
    }))

    const { result } = renderHook(() =>
      usePagedResources('deployments', { namespace: '_all', pageSize: 10 })
    )

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    // 确实发生了多轮拉取（continue 恒非空、又一直凑不满 target）。
    expect(mockFetchResources.mock.calls.length).toBeGreaterThan(1)
    // 但去重后只保留一份，且按创建时间倒序。
    expect(result.current.data?.map((item) => item.metadata.name)).toEqual([
      'b',
      'a',
    ])
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

  // 回归：多选命名空间时集合必须随每页请求一起发出，由服务端收窄 + 合并分页；
  // 前端的「凑够一批」判定不能再建立在未过滤的全集群数据上。
  it('多命名空间集合随每页请求透传', async () => {
    mockFetchResources.mockResolvedValueOnce({ items: [], metadata: {} })

    const { result } = renderHook(() =>
      usePagedResources('deployments', {
        namespace: '_all',
        pageSize: 2,
        namespaces: ['swy-base', 'swy-congo'],
      })
    )

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(mockFetchResources.mock.calls[0][2]).toMatchObject({
      namespaces: ['swy-base', 'swy-congo'],
    })
  })

  // 回归：后端单请求最多收 200 个命名空间，超过时前端分片轮转拉取，任何数量
  // 都不会被静默截断；分片游标打包进 continueToken，跨批续拉只发生在未耗尽的
  // 分片上。
  it('超过 200 个命名空间时分片轮转拉取并合并', async () => {
    const namespaces = Array.from(
      { length: 201 },
      (_, i) => `ns-${String(i).padStart(3, '0')}`
    )
    mockFetchResources.mockImplementation(
      (
        _resource: unknown,
        _namespace: unknown,
        opts: { namespaces?: string[]; continueToken?: string }
      ) => {
        if ((opts.namespaces ?? []).length === 200) {
          if (opts.continueToken) {
            return {
              items: [row('c', '3', '2026-01-03T00:00:00Z')],
              metadata: {},
            }
          }
          return {
            items: [row('a', '1', '2026-01-01T00:00:00Z')],
            metadata: { continue: 'chunk1-t2' },
          }
        }
        // 分片 2（1 个命名空间）：一次取完即耗尽。
        return {
          items: [row('b', '2', '2026-01-02T00:00:00Z')],
          metadata: {},
        }
      }
    )

    const { result } = renderHook(() =>
      usePagedResources('deployments', {
        namespace: '_all',
        pageSize: 2,
        namespaces,
      })
    )

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    // 首批：两个分片各请求一次，单请求命名空间数都不超 200。
    expect(mockFetchResources).toHaveBeenCalledTimes(2)
    expect(mockFetchResources.mock.calls[0][2]).toMatchObject({
      namespaces: expect.arrayContaining(['ns-000', 'ns-199']),
    })
    expect(
      (mockFetchResources.mock.calls[0][2] as { namespaces: string[] })
        .namespaces
    ).toHaveLength(200)
    expect(mockFetchResources.mock.calls[1][2]).toMatchObject({
      namespaces: ['ns-200'],
    })
    // 两批合并且按创建时间倒序。
    expect(result.current.data?.map((item) => item.metadata.name)).toEqual([
      'b',
      'a',
    ])
    expect(result.current.hasMore).toBe(true)

    await act(async () => {
      await result.current.loadMore()
    })

    // 续拉只发生在未耗尽的分片 1 并带上它的游标；分片 2 已耗尽不再发请求。
    expect(mockFetchResources).toHaveBeenCalledTimes(3)
    expect(mockFetchResources.mock.calls[2][2]).toMatchObject({
      continueToken: 'chunk1-t2',
    })
    expect(
      (mockFetchResources.mock.calls[2][2] as { namespaces: string[] })
        .namespaces
    ).toHaveLength(200)
    expect(result.current.hasMore).toBe(false)
    expect(result.current.data?.map((item) => item.metadata.name)).toEqual([
      'c',
      'b',
      'a',
    ])
  })

  // 回归：refresh 与「加载更多」竞争时，被作废的请求不清理；最后一次请求必须
  // 把两个加载状态一起收尾，否则「加载更多」按钮会永久停在「加载中」。
  it('加载更多被刷新作废后，两个加载状态都会被收尾', async () => {
    mockFetchResources.mockResolvedValueOnce({
      items: [row('b', '2', '2026-01-02T00:00:00Z')],
      metadata: { continue: 'next' },
    })

    const { result } = renderHook(() =>
      usePagedResources('deployments', { namespace: '_all', pageSize: 1 })
    )
    await waitFor(() => expect(result.current.hasMore).toBe(true))

    // loadMore 的请求挂起在闸门上。
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mockFetchResources.mockImplementationOnce(async () => {
      await gate
      return { items: [row('a', '1', '2026-01-01T00:00:00Z')], metadata: {} }
    })

    let loadMorePromise!: Promise<void>
    act(() => {
      loadMorePromise = result.current.loadMore()
    })
    await waitFor(() => expect(result.current.isLoadingMore).toBe(true))

    // 刷新作废 loadMore 的请求并完成；随后再放行旧请求。
    mockFetchResources.mockResolvedValueOnce({
      items: [row('b', '2', '2026-01-02T00:00:00Z')],
      metadata: { continue: 'next' },
    })
    await act(async () => {
      await result.current.refetch()
    })
    release()
    await act(async () => {
      await loadMorePromise
    })

    expect(result.current.isLoading).toBe(false)
    expect(result.current.isLoadingMore).toBe(false)
  })
})
