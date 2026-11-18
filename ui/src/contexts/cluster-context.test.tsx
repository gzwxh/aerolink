import { ReactNode, useEffect } from 'react'
import { ClusterProvider } from '@/contexts/cluster-context'
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { Cluster } from '@/types/api'
import { useClusterLocation } from '@/lib/cluster-path'
import { getCurrentCluster, setCurrentCluster } from '@/lib/current-cluster'
import { useCluster } from '@/hooks/use-cluster'

const { fetchClusters } = vi.hoisted(() => ({ fetchClusters: vi.fn() }))

// 用真实的 useQuery 承载 ['clusters']：Provider 与设置页读的是同一份缓存，
// 只有真实查询才能验证「失效后重新取数」这条路径（见文末的回归用例）。
vi.mock('@/lib/api/cluster', async () => {
  const { useQuery } = await import('@tanstack/react-query')
  return {
    useCurrentClusterList: (options?: { enabled?: boolean }) =>
      useQuery({
        queryKey: ['clusters'],
        queryFn: fetchClusters,
        enabled: options?.enabled ?? false,
        retry: false,
      }),
  }
})

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  Trans: (props: { children?: ReactNode }) => props.children ?? null,
}))

const CLUSTERS = [
  { id: 1, name: 'alpha', slug: 'alpha', isDefault: true },
  { id: 2, name: 'beta', slug: 'beta', isDefault: false },
] as unknown as Cluster[]

/** 只读的诊断面板：不进 Gate，任何状态下都能读到当前集群上下文。 */
function Diagnostics() {
  const { currentCluster, isLoading, slugError, clusters } = useCluster()
  const location = useClusterLocation()
  return (
    <div>
      <span data-testid="current">{currentCluster ?? '-'}</span>
      <span data-testid="loading">{String(isLoading)}</span>
      <span data-testid="slug-error">{String(slugError)}</span>
      <span data-testid="pathname">{location.pathname}</span>
      {/* 顶栏徽章 / 侧边栏选择器读的就是这份上下文里的集群数据。 */}
      <span data-testid="badges">
        {clusters.map((cluster) => cluster.badgeText ?? '-').join(',')}
      </span>
    </div>
  )
}

function SwitchButton() {
  const { setCurrentCluster: switchCluster } = useCluster()
  return <button onClick={() => switchCluster('beta')}>switch-beta</button>
}

/**
 * 模拟一个真的会发集群作用域请求的子组件：请求体里取的就是 getCurrentCluster()
 * ——api-client 用同一个值拼 `x-cluster-name` / 请求路径（lib/current-cluster.ts），
 * 所以这里的观测值等同于「首个请求带的集群」。
 */
function ScopedRequest({
  onResult,
}: {
  onResult?: (cluster: string | null) => void
}) {
  const { data } = useQuery({
    queryKey: ['scoped-probe'],
    queryFn: async () => getCurrentCluster(),
  })
  useEffect(() => {
    if (data !== undefined) {
      onResult?.(data)
    }
  }, [data, onResult])
  return <span data-testid="scoped">{String(data)}</span>
}

/** 与 App.tsx 的 ClusterGate 同构：加载/错误/未知 slug 时都不挂载子内容。 */
function Gate({ children }: { children: ReactNode }) {
  const { isLoading, error, slugError } = useCluster()
  if (isLoading) {
    return <span data-testid="gate">loading</span>
  }
  if (error) {
    return <span data-testid="gate">error</span>
  }
  if (slugError) {
    return <span data-testid="gate">slug-error</span>
  }
  return <>{children}</>
}

let activeQueryClient: QueryClient | null = null

function renderClusterApp(
  initialPath: string,
  options: {
    clusters?: Cluster[]
    onScopedResult?: (cluster: string | null) => void
  } = {}
) {
  fetchClusters.mockResolvedValue(options.clusters ?? CLUSTERS)

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  activeQueryClient = queryClient

  const router = createMemoryRouter(
    [
      {
        path: '/_clusters/:clusterSlug/*',
        element: (
          <ClusterProvider>
            <Diagnostics />
            <SwitchButton />
            <Gate>
              <ScopedRequest onResult={options.onScopedResult} />
            </Gate>
          </ClusterProvider>
        ),
      },
    ],
    { initialEntries: [initialPath] }
  )

  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )

  return router
}

beforeEach(() => {
  localStorage.clear()
})

describe('ClusterProvider 的 URL 单一事实源', () => {
  // 方案 §4 的 I1：冷启动深链必须让「首个集群作用域请求」就带上 URL 里的集群，
  // 否则会先按默认/上次的集群发一轮请求，用户看到的是别人的数据。
  it('I1 冷启动深链：子组件挂载前就固化好 URL 里的集群', async () => {
    const seen: (string | null)[] = []
    renderClusterApp('/_clusters/beta/deployments', {
      onScopedResult: (cluster) => seen.push(cluster),
    })

    // 加载期间子内容不挂载，所以还没有任何集群作用域请求发出去。
    expect(screen.getByTestId('gate')).toHaveTextContent('loading')
    expect(seen).toEqual([])

    await waitFor(() =>
      expect(screen.getByTestId('scoped')).toHaveTextContent('beta')
    )
    // beta 不是默认集群：证明没有走默认集群兜底。
    expect(seen).toEqual(['beta'])
    expect(getCurrentCluster()).toBe('beta')
    expect(screen.getByTestId('current')).toHaveTextContent('beta')
  })

  it('I1 深链的集群与上次用的不同时以 URL 为准', async () => {
    setCurrentCluster('alpha')
    renderClusterApp('/_clusters/beta/nodes')

    await waitFor(() =>
      expect(screen.getByTestId('current')).toHaveTextContent('beta')
    )
    expect(getCurrentCluster()).toBe('beta')
  })

  // 方案 §4 的 I2：未知/无权限的 slug 必须 fail-closed，不能静默落回默认集群。
  it('I2 未知 slug：报错且不回落默认集群，也不发集群作用域请求', async () => {
    renderClusterApp('/_clusters/ghost/deployments')

    await waitFor(() =>
      expect(screen.getByTestId('slug-error')).toHaveTextContent('true')
    )
    expect(screen.getByTestId('gate')).toHaveTextContent('slug-error')
    expect(screen.getByTestId('current')).toHaveTextContent('-')
    expect(getCurrentCluster()).toBeNull()
    expect(screen.queryByTestId('scoped')).toBeNull()
  })

  // 方案 §4 的 I3：URL、存储、请求头来源三处必须是同一个集群。
  it('I3 切换集群后 URL、存储与请求头来源一致', async () => {
    const router = renderClusterApp('/_clusters/alpha/deployments')
    await waitFor(() =>
      expect(screen.getByTestId('current')).toHaveTextContent('alpha')
    )
    expect(getCurrentCluster()).toBe('alpha')

    fireEvent.click(screen.getByText('switch-beta'))

    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/_clusters/beta/deployments')
    )
    await waitFor(() =>
      expect(screen.getByTestId('current')).toHaveTextContent('beta')
    )
    expect(getCurrentCluster()).toBe('beta')
  })
})

describe('切换集群后的页面回退', () => {
  it('详情页 URL 退回该资源的列表页', async () => {
    const router = renderClusterApp(
      '/_clusters/alpha/deployments/default/nginx'
    )
    await waitFor(() =>
      expect(screen.getByTestId('current')).toHaveTextContent('alpha')
    )

    fireEvent.click(screen.getByText('switch-beta'))

    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/_clusters/beta/deployments')
    )
  })

  it('按命名空间过滤的列表页保留（新集群里仍然可用）', async () => {
    const router = renderClusterApp('/_clusters/alpha/deployments/default')
    await waitFor(() =>
      expect(screen.getByTestId('current')).toHaveTextContent('alpha')
    )

    fireEvent.click(screen.getByText('switch-beta'))

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        '/_clusters/beta/deployments/default'
      )
    )
  })

  it('顶层列表页原样保留', async () => {
    const router = renderClusterApp('/_clusters/alpha/deployments')
    await waitFor(() =>
      expect(screen.getByTestId('current')).toHaveTextContent('alpha')
    )

    fireEvent.click(screen.getByText('switch-beta'))

    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/_clusters/beta/deployments')
    )
  })
})

describe('useClusterLocation', () => {
  // 侧边栏选中态（isActive）与面包屑都按剥前缀后的业务路径判断，
  // 前缀漏剥会让它们认为「当前不在这个页面」。
  it('剥掉集群前缀后暴露业务路径', async () => {
    renderClusterApp('/_clusters/alpha/deployments/default/nginx')

    await waitFor(() =>
      expect(screen.getByTestId('pathname')).toHaveTextContent(
        '/deployments/default/nginx'
      )
    )
  })

  it('集群首页的业务路径是根路径', async () => {
    renderClusterApp('/_clusters/alpha')

    await waitFor(() =>
      expect(screen.getByTestId('pathname')).toHaveTextContent('/')
    )
  })
})

describe('集群列表缓存失效', () => {
  // 设置页保存徽章 / 编辑集群后只做 invalidateQueries(['clusters'])。
  // 顶栏徽章与侧边栏选择器读的是 Provider 里的集群数据，必须跟着更新，
  // 否则用户要整页刷新才能看到新样式（enabled: false 的查询不会被重新取数）。
  it('失效后重新取数并同步到上下文', async () => {
    renderClusterApp('/_clusters/alpha/deployments')
    await waitFor(() =>
      expect(screen.getByTestId('current')).toHaveTextContent('alpha')
    )
    expect(screen.getByTestId('badges')).toHaveTextContent('-,-')

    fetchClusters.mockResolvedValue([
      {
        id: 1,
        name: 'alpha',
        slug: 'alpha',
        isDefault: true,
        badgeText: '测试环境',
      },
      {
        id: 2,
        name: 'beta',
        slug: 'beta',
        isDefault: false,
        badgeText: '预发',
      },
    ])

    await act(async () => {
      await activeQueryClient!.invalidateQueries({ queryKey: ['clusters'] })
    })

    await waitFor(() =>
      expect(screen.getByTestId('badges')).toHaveTextContent('测试环境,预发')
    )
  })
})
