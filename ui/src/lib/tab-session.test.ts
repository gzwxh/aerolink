import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearTabSession,
  hasTabSession,
  markTabSession,
  probeLiveTabs,
  shouldRequireLogin,
  TAB_PROBE_TIMEOUT_MS,
} from './tab-session'

/**
 * 每个标签页各有一份模块实例（本标签的身份 tabId 就是模块级的），
 * 所以跨标签的 ping/pong 必须用两份实例来测，不能指望同一份自己回自己。
 */
async function loadAsAnotherTab() {
  vi.resetModules()
  return import('./tab-session')
}

/** 只实现 ping/pong 用得到的部分，行为与浏览器一致：不投递给自己。 */
class FakeBroadcastChannel {
  static channels = new Set<FakeBroadcastChannel>()

  private listeners = new Set<(event: MessageEvent) => void>()

  constructor(private readonly channelName: string) {
    FakeBroadcastChannel.channels.add(this)
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent) => void) {
    this.listeners.add(listener)
  }

  removeEventListener(
    _type: 'message',
    listener: (event: MessageEvent) => void
  ) {
    this.listeners.delete(listener)
  }

  postMessage(data: unknown) {
    for (const channel of FakeBroadcastChannel.channels) {
      if (channel === this || channel.channelName !== this.channelName) continue
      // 浏览器里消息是异步投递的，这里也一样，否则探测会「同步」拿到回应。
      setTimeout(() => {
        channel.listeners.forEach((listener) =>
          listener({ data } as MessageEvent)
        )
      }, 0)
    }
  }

  close() {
    FakeBroadcastChannel.channels.delete(this)
  }
}

beforeEach(() => {
  sessionStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  FakeBroadcastChannel.channels.forEach((channel) => channel.close())
})

describe('标签页票据', () => {
  it('写入后可读到，清掉后读不到', () => {
    expect(hasTabSession()).toBe(false)

    markTabSession()
    expect(hasTabSession()).toBe(true)

    clearTabSession()
    expect(hasTabSession()).toBe(false)
  })
})

describe('shouldRequireLogin', () => {
  it('没有票据也没有其它标签时要求重新登录', () => {
    expect(shouldRequireLogin({ hasTicket: false, hasLivePeer: false })).toBe(
      true
    )
  })

  it('本标签有票据时放行', () => {
    expect(shouldRequireLogin({ hasTicket: true, hasLivePeer: false })).toBe(
      false
    )
  })

  it('同浏览器还有其它标签在用时不打扰（复制链接到新标签的场景）', () => {
    expect(shouldRequireLogin({ hasTicket: false, hasLivePeer: true })).toBe(
      false
    )
  })
})

describe('probeLiveTabs', () => {
  it('没有 BroadcastChannel 时按「需要重新登录」处理', async () => {
    vi.stubGlobal('BroadcastChannel', undefined)

    await expect(probeLiveTabs(0)).resolves.toBe(false)
  })

  it('没有标签回应时视为所有页面都已关闭', async () => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)

    await expect(probeLiveTabs(20)).resolves.toBe(false)
  })

  it('持有票据的标签会回应，探测结果为「仍在使用」', async () => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
    markTabSession()

    const peer = await loadAsAnotherTab()
    const stop = peer.startTabSessionResponder()

    const me = await loadAsAnotherTab()
    await expect(me.probeLiveTabs(TAB_PROBE_TIMEOUT_MS)).resolves.toBe(true)

    stop()
  })

  it('没有票据的标签（登录页、已登出）不回应', async () => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)

    const peer = await loadAsAnotherTab()
    const stop = peer.startTabSessionResponder()

    const me = await loadAsAnotherTab()
    await expect(me.probeLiveTabs(20)).resolves.toBe(false)

    stop()
  })
})
