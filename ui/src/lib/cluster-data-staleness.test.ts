import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  clearClusterDataStaleness,
  CLUSTER_DATA_AGE_HEADER,
  CLUSTER_DATA_STALE_HEADER,
  getClusterDataStaleness,
  reportClusterDataStaleness,
  resetClusterDataStalenessForTest,
  subscribeClusterDataStaleness,
} from './cluster-data-staleness'

function headers(entries: Record<string, string> = {}): Headers {
  const result = new Headers()
  for (const [key, value] of Object.entries(entries)) {
    result.set(key, value)
  }
  return result
}

describe('cluster-data-staleness', () => {
  afterEach(() => {
    resetClusterDataStalenessForTest()
    vi.useRealTimers()
  })

  it('不做任何上报时是健康的', () => {
    expect(getClusterDataStaleness()).toEqual({
      stale: false,
      cluster: '',
      lastFreshAt: null,
    })
  })

  it('陈旧响应记录集群名与数据最后一次是新的时刻', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-16T10:00:00Z'))

    reportClusterDataStaleness(
      headers({
        [CLUSTER_DATA_STALE_HEADER]: '1',
        [CLUSTER_DATA_AGE_HEADER]: '120',
      }),
      'prod'
    )

    // 展示的是「最后更新于 09:58」，所以要存绝对时刻而不是秒数，
    // 否则同一份数据每次渲染算出的时间都不一样。
    expect(getClusterDataStaleness()).toEqual({
      stale: true,
      cluster: 'prod',
      lastFreshAt: Date.parse('2026-10-16T09:58:00Z'),
    })
  })

  it('响应头 Date 与浏览器时钟有偏差时按服务器时间换算', () => {
    vi.useFakeTimers()
    // 浏览器时钟比服务器快 2 分钟：横幅时间不该被这台机器的漂移带偏。
    vi.setSystemTime(new Date('2026-10-16T10:02:00Z'))

    reportClusterDataStaleness(
      headers({
        [CLUSTER_DATA_STALE_HEADER]: '1',
        [CLUSTER_DATA_AGE_HEADER]: '120',
        Date: 'Fri, 16 Oct 2026 10:00:00 GMT',
      }),
      'prod'
    )

    expect(getClusterDataStaleness()).toEqual({
      stale: true,
      cluster: 'prod',
      // 服务器的 10:00 减 120s，而不是浏览器 10:02 减 120s。
      lastFreshAt: Date.parse('2026-10-16T09:58:00Z'),
    })
  })

  it('Date 头缺失或非法时回落浏览器时钟', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-16T10:00:00Z'))

    reportClusterDataStaleness(
      headers({
        [CLUSTER_DATA_STALE_HEADER]: '1',
        [CLUSTER_DATA_AGE_HEADER]: '60',
        Date: 'not-a-date',
      }),
      'prod'
    )
    expect(getClusterDataStaleness().lastFreshAt).toBe(
      Date.parse('2026-10-16T09:59:00Z')
    )

    reportClusterDataStaleness(
      headers({
        [CLUSTER_DATA_STALE_HEADER]: '1',
        [CLUSTER_DATA_AGE_HEADER]: '60',
      }),
      'prod'
    )
    expect(getClusterDataStaleness().lastFreshAt).toBe(
      Date.parse('2026-10-16T09:59:00Z')
    )
  })

  it('从未成功访问过的集群没有可展示的时间', () => {
    reportClusterDataStaleness(
      headers({ [CLUSTER_DATA_STALE_HEADER]: '1' }),
      'prod'
    )

    expect(getClusterDataStaleness()).toMatchObject({
      stale: true,
      cluster: 'prod',
      lastFreshAt: null,
    })
  })

  it('带上 age 却没有 stale 头即视为恢复并清除', () => {
    reportClusterDataStaleness(
      headers({
        [CLUSTER_DATA_STALE_HEADER]: '1',
        [CLUSTER_DATA_AGE_HEADER]: '60',
      }),
      'prod'
    )
    expect(getClusterDataStaleness().stale).toBe(true)

    reportClusterDataStaleness(
      headers({ [CLUSTER_DATA_AGE_HEADER]: '0' }),
      'prod'
    )

    expect(getClusterDataStaleness()).toEqual({
      stale: false,
      cluster: 'prod',
      lastFreshAt: null,
    })
  })

  it('两个头都不带的响应不参与判定', () => {
    reportClusterDataStaleness(
      headers({
        [CLUSTER_DATA_STALE_HEADER]: '1',
        [CLUSTER_DATA_AGE_HEADER]: '60',
      }),
      'prod'
    )

    // /api/v1/clusters、会话探活等集群作用域之外的响应不带这两个头：
    // 它们既证明不了集群数据是新的，也不该把提示冲掉。
    reportClusterDataStaleness(headers(), null)

    expect(getClusterDataStaleness().stale).toBe(true)
  })

  it('清除后回到健康并通知订阅者（切换集群用）', () => {
    const listener = vi.fn()
    subscribeClusterDataStaleness(listener)
    reportClusterDataStaleness(
      headers({
        [CLUSTER_DATA_STALE_HEADER]: '1',
        [CLUSTER_DATA_AGE_HEADER]: '60',
      }),
      'prod'
    )
    expect(getClusterDataStaleness().stale).toBe(true)

    clearClusterDataStaleness()

    expect(getClusterDataStaleness()).toEqual({
      stale: false,
      cluster: '',
      lastFreshAt: null,
    })
    expect(listener).toHaveBeenCalledTimes(2)

    // 本来就没有提示时再清一次是无操作，不能惊动订阅者。
    clearClusterDataStaleness()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('值没变时不通知订阅者', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeClusterDataStaleness(listener)
    const stale = headers({ [CLUSTER_DATA_STALE_HEADER]: '1' })

    reportClusterDataStaleness(stale, 'prod')
    reportClusterDataStaleness(stale, 'prod')
    expect(listener).toHaveBeenCalledTimes(1)

    reportClusterDataStaleness(
      headers({ [CLUSTER_DATA_AGE_HEADER]: '0' }),
      'prod'
    )
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    reportClusterDataStaleness(stale, 'prod')
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
