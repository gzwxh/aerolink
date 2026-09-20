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

describe('useResourcesWatch', () => {
  afterEach(() => {
    FakeEventSource.instances = []
    vi.unstubAllGlobals()
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
})
