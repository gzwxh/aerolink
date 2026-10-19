import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CLUSTER_DATA_AGE_HEADER,
  CLUSTER_DATA_STALE_HEADER,
  reportClusterDataStaleness,
  resetClusterDataStalenessForTest,
} from '@/lib/cluster-data-staleness'
import {
  reportApiFailure,
  resetServiceStatusForTest,
} from '@/lib/service-status'

import { ClusterDataStaleBanner } from './cluster-data-stale-banner'

type TArgs = { defaultValue?: string; [name: string]: unknown }

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // 模拟 i18next 的插值：文案断言要看得见真实的集群名与时间。
    t: (key: string, second?: string | TArgs) => {
      const template =
        typeof second === 'string' ? second : (second?.defaultValue ?? key)
      const values = typeof second === 'object' ? second : {}
      return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
        name in values ? String(values[name]) : `{{${name}}}`
      )
    },
  }),
}))

function headers(entries: Record<string, string> = {}): Headers {
  const result = new Headers()
  for (const [key, value] of Object.entries(entries)) {
    result.set(key, value)
  }
  return result
}

function renderBanner() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <ClusterDataStaleBanner />
    </QueryClientProvider>
  )
}

describe('ClusterDataStaleBanner', () => {
  afterEach(() => {
    resetClusterDataStalenessForTest()
    resetServiceStatusForTest()
  })

  it('数据新鲜时不渲染任何东西', () => {
    renderBanner()

    expect(screen.queryByRole('status')).toBeNull()
  })

  it('数据陈旧时说明是哪个集群、最后更新于何时', () => {
    reportClusterDataStaleness(
      headers({
        [CLUSTER_DATA_STALE_HEADER]: '1',
        [CLUSTER_DATA_AGE_HEADER]: '120',
      }),
      'prod'
    )

    renderBanner()

    const banner = screen.getByRole('status')
    expect(banner.textContent).toContain('prod')
    // 展示的是「最后更新于某时刻」，而不是「已过期 120 秒」：相对时间会随渲染漂移。
    expect(banner.textContent).not.toContain('120')
    expect(screen.getByRole('button')).toBeTruthy()
  })

  it('从未连上过的集群不编造最后更新时间', () => {
    reportClusterDataStaleness(
      headers({ [CLUSTER_DATA_STALE_HEADER]: '1' }),
      'prod'
    )

    renderBanner()

    expect(screen.getByRole('status').textContent).toContain(
      '页面数据可能已过期'
    )
  })

  it('拿不到集群名时退回「当前集群」', () => {
    reportClusterDataStaleness(
      headers({ [CLUSTER_DATA_STALE_HEADER]: '1' }),
      null
    )

    renderBanner()

    expect(screen.getByRole('status').textContent).toContain('当前集群')
  })

  it('平台自身不可用时让位给「服务不可用」横幅', () => {
    reportClusterDataStaleness(
      headers({
        [CLUSTER_DATA_STALE_HEADER]: '1',
        [CLUSTER_DATA_AGE_HEADER]: '120',
      }),
      'prod'
    )
    // service-status 的 FAILURE_THRESHOLD 为 3：连够 3 次即标记「服务不可用」。
    for (let i = 0; i < 3; i++) {
      reportApiFailure('network')
    }

    renderBanner()

    // 两条横幅占同一个位置，同时出现只会互相遮挡。
    expect(screen.queryByRole('status')).toBeNull()
  })
})
