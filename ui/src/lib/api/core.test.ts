import {
  PageRefreshProvider,
  useRequestPageRefresh,
} from '@/contexts/page-refresh-context'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useResourcesWatch } from './core'

type Listener = (event: { data: string }) => void

// jsdom 没有 EventSource：用一个最小的替身记录连接是否被创建。
class FakeEventSource {
  static instances: FakeEventSource[] = []

  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  // EventSource 的实例常量：1 = OPEN、0 = CONNECTING、2 = CLOSED。
  readyState = 1
  private listeners = new Map<string, Listener[]>()

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: Listener) {
    const existing = this.listeners.get(type) ?? []
    existing.push(listener)
    this.listeners.set(type, existing)
  }

  removeEventListener() {}

  close() {
    this.closed = true
  }

  emit(type: string, data: string) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data })
    }
  }
}

const podEvent = (name: string) =>
  JSON.stringify({ metadata: { name, namespace: 'default' } })

/** 列表里各行的名字，按当前顺序。 */
const names = (items: Array<{ metadata?: { name?: string } }> | undefined) =>
  (items || []).map((item) => item.metadata?.name)

// 重同步窗口的长度是 hook 内部常量：这里取一个必然大于它的值，避免测试与实现耦合。
const AFTER_RESYNC_WINDOW_MS = 1000

// 服务端明确拒绝连接（429 限流 / 403 无权限）时浏览器给的状态：
// readyState 变 CLOSED 且不再自动重连。
const rejectConnection = (source: FakeEventSource) => {
  source.readyState = 2
  source.onerror?.()
}

const setDocumentHidden = (hidden: boolean) => {
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    value: hidden,
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

const listResponse = (items: unknown[] = []) =>
  new Response(JSON.stringify({ items }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

describe('useResourcesWatch', () => {
  afterEach(() => {
    FakeEventSource.instances = []
    vi.unstubAllGlobals()
    vi.useRealTimers()
    setDocumentHidden(false)
  })

  // watch 的首批事件才是快照：这之前必须保持加载态，否则首屏会先闪一下空状态。
  it('快照到达前保持加载态，首个事件后收起', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)

    const { result } = renderHook(() => useResourcesWatch('pods', 'default'))
    expect(result.current.isLoading).toBe(true)

    act(() => {
      FakeEventSource.instances[0].emit('added', podEvent('p1'))
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.data).toHaveLength(1)
  })

  // refetch 的重连是延迟 100ms 的定时器：组件卸载后不能再用它建新连接。
  it('卸载后延迟的重连不会建立新连接', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)

    const { result, unmount } = renderHook(() =>
      useResourcesWatch('pods', 'default')
    )
    expect(FakeEventSource.instances).toHaveLength(1)

    act(() => {
      result.current.refetch()
    })
    unmount()

    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(FakeEventSource.instances).toHaveLength(1)
  })

  // 没人看的标签页不该占着上游 watch 与浏览器的连接名额。
  it('页面不可见时断开连接，可见时重连', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)

    renderHook(() => useResourcesWatch('pods', 'default'))
    expect(FakeEventSource.instances).toHaveLength(1)

    act(() => setDocumentHidden(true))
    expect(FakeEventSource.instances[0].closed).toBe(true)

    act(() => setDocumentHidden(false))
    expect(FakeEventSource.instances).toHaveLength(2)
    expect(FakeEventSource.instances[1].closed).toBe(false)
  })

  // pauseWhenHidden: false 的页面（如详情页）保持现有行为，切换标签页不影响连接。
  it('pauseWhenHidden 为 false 时不断开连接', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)

    renderHook(() =>
      useResourcesWatch('pods', 'default', { pauseWhenHidden: false })
    )
    act(() => setDocumentHidden(true))

    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.instances[0].closed).toBe(false)
  })

  // 服务端限流（429）会让浏览器停止重连：此时必须降级为轮询，而不是让页面一直空转。
  it('服务端拒绝连接时降级为轮询', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const fetchMock = vi.fn(async () => listResponse([podEvent('p1')]))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() =>
      useResourcesWatch('pods', 'default', { fallbackPollInterval: 2000 })
    )

    await act(async () => {
      rejectConnection(FakeEventSource.instances[0])
    })

    await waitFor(() => expect(result.current.data).toHaveLength(1))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/v1/pods/default')
    expect(result.current.error).toBeNull()
    expect(result.current.isLoading).toBe(false)
    // 降级期间不再反复抢必然被拒的 SSE 连接。
    expect(FakeEventSource.instances).toHaveLength(1)
  })

  // 网络抖动是 CONNECTING，浏览器自己会重连，不能误判成限流去轮询。
  it('网络抖动不降级为轮询', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const fetchMock = vi.fn(async () => listResponse())
    vi.stubGlobal('fetch', fetchMock)

    renderHook(() => useResourcesWatch('pods', 'default'))

    await act(async () => {
      FakeEventSource.instances[0].readyState = 0
      FakeEventSource.instances[0].onerror?.()
    })
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(fetchMock).not.toHaveBeenCalled()
  })

  // 降级不是终点：等限流窗口过去要把 SSE 抢回来，抢回后停止轮询。
  it('降级期间定期探测，连接恢复后停止轮询', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('EventSource', FakeEventSource)
    const fetchMock = vi.fn(async () => listResponse([podEvent('p1')]))
    vi.stubGlobal('fetch', fetchMock)

    renderHook(() =>
      useResourcesWatch('pods', 'default', { fallbackPollInterval: 2000 })
    )

    await act(async () => {
      rejectConnection(FakeEventSource.instances[0])
      await Promise.resolve()
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // 探测间隔到点：建一条新连接，onopen 后轮询必须停下。
    await act(async () => {
      vi.advanceTimersByTime(30000)
    })
    expect(FakeEventSource.instances).toHaveLength(2)

    act(() => {
      FakeEventSource.instances[1].onopen?.()
    })
    const callsAfterReconnect = fetchMock.mock.calls.length

    await act(async () => {
      vi.advanceTimersByTime(10000)
      await Promise.resolve()
    })
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterReconnect)
  })

  // 详情页外壳点「刷新」的语义是「重新取这一页的全部数据」：SSE 的数据在本地 state 里，
  // react-query 的 refetchQueries 碰不到它，只能由页面刷新信号驱动重连重取。
  it('页面刷新信号到来时立刻重连重取', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)

    const { result } = renderHook(
      () => ({
        watch: useResourcesWatch('pods', 'default'),
        requestPageRefresh: useRequestPageRefresh(),
      }),
      { wrapper: PageRefreshProvider }
    )
    expect(FakeEventSource.instances).toHaveLength(1)

    act(() => {
      result.current.requestPageRefresh()
    })
    // immediate 重连走 0ms 定时器：让出一个宏任务就够。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(FakeEventSource.instances).toHaveLength(2)
    expect(FakeEventSource.instances[0].closed).toBe(true)
    expect(FakeEventSource.instances[1].closed).toBe(false)
  })

  // 断线期间被删掉的对象不会再有任何事件：重连拿到的新快照里已经没有它，
  // 必须按快照把本地遗留的行丢掉，否则会出现「Pod 已删除、界面还在」（点刷新也去不掉，
  // 因为重连只是又合并了一次快照）。
  it('重连后按新快照丢掉已消失的行', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('EventSource', FakeEventSource)

    const { result } = renderHook(() => useResourcesWatch('pods', 'default'))

    act(() => {
      FakeEventSource.instances[0].emit('added', podEvent('p1'))
      FakeEventSource.instances[0].emit('added', podEvent('p2'))
    })
    await act(async () => {
      vi.advanceTimersByTime(AFTER_RESYNC_WINDOW_MS)
    })
    expect(names(result.current.data)).toEqual(['p2', 'p1'])

    act(() => {
      result.current.refetch({ immediate: true })
    })
    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(FakeEventSource.instances).toHaveLength(2)

    // 新快照里只剩 p1（p2 在断线期间被删掉了）。
    act(() => {
      FakeEventSource.instances[1].emit('added', podEvent('p1'))
    })
    await act(async () => {
      vi.advanceTimersByTime(AFTER_RESYNC_WINDOW_MS)
    })

    expect(names(result.current.data)).toEqual(['p1'])
  })

  // 服务端显式给出「快照发完」的标记时，不必再等窗口到期。
  it('收到 synced 立刻结束重同步窗口', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('EventSource', FakeEventSource)

    const { result } = renderHook(() => useResourcesWatch('pods', 'default'))
    act(() => {
      FakeEventSource.instances[0].emit('added', podEvent('p1'))
      FakeEventSource.instances[0].emit('added', podEvent('p2'))
    })
    act(() => {
      FakeEventSource.instances[0].emit('synced', '')
    })
    expect(names(result.current.data)).toEqual(['p2', 'p1'])

    act(() => {
      result.current.refetch({ immediate: true })
    })
    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    act(() => {
      FakeEventSource.instances[1].emit('added', podEvent('p1'))
      FakeEventSource.instances[1].emit('synced', '')
    })

    expect(names(result.current.data)).toEqual(['p1'])
  })

  // 空快照（RBAC 过滤后为 0 条、或快照被跳过）不会带来任何 added：
  // 收到 synced 就要收起加载态，否则详情页的 Pods 永远停在「加载中」。
  it('空快照收到 synced 后收起加载态', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('EventSource', FakeEventSource)

    const { result } = renderHook(() => useResourcesWatch('pods', 'default'))
    expect(result.current.isLoading).toBe(true)

    act(() => {
      FakeEventSource.instances[0].emit('synced', '')
    })

    expect(result.current.isLoading).toBe(false)
    expect(result.current.data).toBeUndefined()
  })

  // 显式刷新不吃指数退避：默认 refetch 要等 1s（连续重连更久），immediate 立刻重连。
  it('immediate 重连不等退避', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)

    const { result } = renderHook(() => useResourcesWatch('pods', 'default'))

    act(() => {
      result.current.refetch()
      result.current.refetch({ immediate: true })
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(FakeEventSource.instances).toHaveLength(2)
  })
})
