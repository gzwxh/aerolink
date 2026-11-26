import { useCallback, useEffect, useRef, useState } from 'react'
import { usePageRefreshEpoch } from '@/contexts/page-refresh-context'
import { useQuery } from '@tanstack/react-query'
import { Pod } from 'kubernetes-types/core/v1'

import {
  HelmChartContent,
  HelmChartContentType,
  HelmChartDetail,
  HelmChartList,
  HelmRelease,
  HelmReleaseAutoUpgrade,
  HelmReleaseAutoUpgradeRequest,
  HelmReleaseDryRunResponse,
  HelmReleaseHistoryResponse,
  HelmReleaseInstallRequest,
  HelmReleaseUpgradeRequest,
  HelmRepository,
  ImageTagInfo,
  RelatedResources,
  ResourceHistoryResponse,
  ResourcesTypeMap,
  ResourceTemplate,
  ResourceType,
  ResourceTypeMap,
  WorkloadRevisionResourceType,
  WorkloadRevisionsResponse,
} from '@/types/api'
import type { CustomResource } from '@/types/api'
import { supportsRelatedResources } from '@/lib/resource-catalog'
import { getResourceQueryKey } from '@/lib/resource-metadata'
import { useCluster } from '@/hooks/use-cluster'

import { API_BASE_URL, apiClient } from '../api-client'
import {
  appendCurrentClusterParam,
  withCurrentClusterPath,
} from '../current-cluster'
import { withSubPath } from '../subpath'
import { encryptRequestBody } from '../transport-envelope'
import { fetchAPI } from './shared'

type ResourcesItems<T extends ResourceType> = ResourcesTypeMap[T]['items']

export const fetchResources = <T>(
  resource: string,
  namespace?: string,
  opts?: {
    limit?: number
    continueToken?: string
    /** 真分页（配合 limit / continue）：服务端会绕过 informer 缓存。 */
    paginate?: boolean
    labelSelector?: string
    fieldSelector?: string
    reduce?: boolean
    /** 多选命名空间：仅在跨命名空间（`_all`）请求上生效，由服务端收窄范围。 */
    namespaces?: string[]
  }
): Promise<T> => {
  let endpoint = namespace ? `/${resource}/${namespace}` : `/${resource}`
  const params = new URLSearchParams()

  if (opts?.limit) {
    params.append('limit', opts.limit.toString())
  }
  if (opts?.continueToken) {
    params.append('continue', opts.continueToken)
  }
  if (opts?.paginate) {
    params.append('paginate', 'true')
  }
  if (opts?.labelSelector) {
    params.append('labelSelector', opts.labelSelector)
  }
  if (opts?.fieldSelector) {
    params.append('fieldSelector', opts.fieldSelector)
  }
  if (opts?.reduce) {
    params.append('reduce', 'true')
  }
  // 多选命名空间由服务端收窄：否则 `_all` 只返回全集群的一页，选中集合可能
  // 全在分页窗口之外（见 docs/dev/plans/2026-11-20-多命名空间列表分页.md）。
  if (opts?.namespaces && opts.namespaces.length > 0) {
    params.append('namespaces', opts.namespaces.join(','))
  }

  if (params.toString()) {
    endpoint += `?${params.toString()}`
  }

  return fetchAPI<T>(endpoint)
}

// 搜索 API 类型
export interface SearchResult {
  id: string
  name: string
  namespace?: string
  resourceType: string
  createdAt: string
}

export interface SearchResponse {
  results: SearchResult[]
  total: number
}

// 全局搜索 API
export const globalSearch = async (
  query: string,
  options?: {
    limit?: number
    namespace?: string
  }
): Promise<SearchResponse> => {
  if (!query.trim()) {
    return { results: [], total: 0 }
  }

  const params = new URLSearchParams({
    q: query,
    limit: String(options?.limit || 50),
  })

  if (options?.namespace) {
    params.append('namespace', options.namespace)
  }

  const endpoint = `/search?${params.toString()}`
  const response = await fetchAPI<SearchResponse>(endpoint)
  const results = response.results || []
  return {
    ...response,
    results,
    total: response.total ?? results.length,
  }
}
// 扩缩容 Deployment API
export const scaleDeployment = async (
  namespace: string,
  name: string,
  replicas: number
): Promise<{ message: string; deployment: unknown; replicas: number }> => {
  const endpoint = `/deployments/${namespace}/${name}/scale`
  const response = await apiClient.put<{
    message: string
    deployment: unknown
    replicas: number
  }>(endpoint, {
    replicas,
  })

  return response
}

export const upgradeHelmRelease = async (
  namespace: string,
  name: string,
  body?: HelmReleaseUpgradeRequest
): Promise<{ message?: string }> => {
  return apiClient.put<{ message?: string }>(
    `/helmrelease/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/upgrade`,
    await encryptRequestBody(body || {})
  )
}

export const dryRunUpgradeHelmRelease = async (
  namespace: string,
  name: string,
  body?: HelmReleaseUpgradeRequest
): Promise<HelmReleaseDryRunResponse> => {
  return apiClient.put<HelmReleaseDryRunResponse>(
    `/helmrelease/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/upgrade/dry-run`,
    await encryptRequestBody(body || {})
  )
}

export const rollbackHelmRelease = async (
  namespace: string,
  name: string,
  revision?: number
): Promise<{ message?: string }> => {
  return apiClient.put<{ message?: string }>(
    `/helmrelease/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/rollback`,
    revision ? { revision } : {}
  )
}

export const fetchHelmReleaseAutoUpgrade = (
  namespace: string,
  name: string
): Promise<HelmReleaseAutoUpgrade> => {
  return fetchAPI<HelmReleaseAutoUpgrade>(
    `/helmrelease/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/auto-upgrade`
  )
}

export const updateHelmReleaseAutoUpgrade = (
  namespace: string,
  name: string,
  body: HelmReleaseAutoUpgradeRequest
): Promise<HelmReleaseAutoUpgrade> => {
  return apiClient.put<HelmReleaseAutoUpgrade>(
    `/helmrelease/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/auto-upgrade`,
    body
  )
}

export const useHelmReleaseAutoUpgrade = (
  namespace: string,
  name: string,
  options?: { enabled?: boolean; staleTime?: number }
) => {
  return useQuery({
    queryKey: ['helmrelease-auto-upgrade', namespace, name],
    queryFn: () => fetchHelmReleaseAutoUpgrade(namespace, name),
    enabled: (options?.enabled ?? true) && !!namespace && !!name,
    staleTime: options?.staleTime || 30000,
  })
}

export const installHelmRelease = async (
  namespace: string,
  body: HelmReleaseInstallRequest
): Promise<HelmRelease> => {
  // values 可能直接写口令（数据库密码之类），整包走信封加密。
  return apiClient.post<HelmRelease>(
    `/helmrelease/${encodeURIComponent(namespace)}`,
    await encryptRequestBody(body)
  )
}

export const dryRunInstallHelmRelease = async (
  namespace: string,
  body: HelmReleaseInstallRequest
): Promise<HelmReleaseDryRunResponse> => {
  return apiClient.post<HelmReleaseDryRunResponse>(
    `/helmrelease/${encodeURIComponent(namespace)}/dry-run`,
    await encryptRequestBody(body)
  )
}

export const fetchHelmReleaseHistory = (
  namespace: string,
  name: string
): Promise<HelmReleaseHistoryResponse> => {
  return fetchAPI<HelmReleaseHistoryResponse>(
    `/helmrelease/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/history`
  )
}

export const useHelmReleaseHistory = (
  namespace: string,
  name: string,
  options?: { enabled?: boolean; staleTime?: number }
) => {
  return useQuery({
    queryKey: ['helmrelease-history', namespace, name],
    queryFn: () => fetchHelmReleaseHistory(namespace, name),
    enabled: options?.enabled ?? true,
    staleTime: options?.staleTime || 30000,
  })
}

export const fetchHelmRepositories = (): Promise<HelmRepository[]> => {
  return fetchAPI<HelmRepository[]>('/charts/repositories')
}

export const createHelmRepository = async (
  body: Pick<HelmRepository, 'name' | 'url'> & {
    username?: string
    password?: string
  }
): Promise<HelmRepository> => {
  // 带 username / password 的仓库凭据。
  return apiClient.post<HelmRepository>(
    '/admin/charts/repositories',
    await encryptRequestBody(body)
  )
}

export const deleteHelmRepository = (
  id: number
): Promise<{ message: string }> => {
  return apiClient.delete<{ message: string }>(
    `/admin/charts/repositories/${id}`
  )
}

export const fetchHelmCharts = (options?: {
  repository?: string
  query?: string
}): Promise<HelmChartList> => {
  const params = new URLSearchParams()
  if (options?.repository) {
    params.append('repository', options.repository)
  }
  if (options?.query) {
    params.append('q', options.query)
  }
  const query = params.toString()
  return fetchAPI<HelmChartList>(`/charts${query ? `?${query}` : ''}`)
}

export const fetchArtifactHubCharts = (options?: {
  query?: string
  verifiedPublisher?: boolean
  limit?: number
  offset?: number
}): Promise<HelmChartList> => {
  const params = new URLSearchParams()
  if (options?.query) {
    params.append('q', options.query)
  }
  if (options?.verifiedPublisher !== undefined) {
    params.append('verifiedPublisher', String(options.verifiedPublisher))
  }
  if (options?.limit) {
    params.append('limit', String(options.limit))
  }
  if (options?.offset) {
    params.append('offset', String(options.offset))
  }
  const query = params.toString()
  return fetchAPI<HelmChartList>(
    `/charts/artifacthub${query ? `?${query}` : ''}`
  )
}

export const fetchHelmChart = (
  repository: string,
  name: string,
  version?: string,
  source?: 'repository' | 'artifacthub'
): Promise<HelmChartDetail> => {
  const params = new URLSearchParams()
  if (version) {
    params.append('version', version)
  }
  const query = params.toString()
  const endpoint =
    source === 'artifacthub'
      ? `/charts/artifacthub/${encodeURIComponent(repository)}/${encodeURIComponent(name)}`
      : `/charts/${encodeURIComponent(repository)}/${encodeURIComponent(name)}`

  return fetchAPI<HelmChartDetail>(`${endpoint}${query ? `?${query}` : ''}`)
}

export const fetchHelmChartContent = (
  repository: string,
  name: string,
  content: HelmChartContentType,
  version?: string,
  source?: 'repository' | 'artifacthub'
): Promise<HelmChartContent> => {
  const params = new URLSearchParams()
  if (version) {
    params.append('version', version)
  }
  const query = params.toString()
  const endpoint =
    source === 'artifacthub'
      ? `/charts/artifacthub/${encodeURIComponent(repository)}/${encodeURIComponent(name)}/content/${content}`
      : `/charts/${encodeURIComponent(repository)}/${encodeURIComponent(name)}/content/${content}`

  return fetchAPI<HelmChartContent>(`${endpoint}${query ? `?${query}` : ''}`)
}

export const useHelmRepositories = () => {
  return useQuery({
    queryKey: ['helmcharts', 'repositories'],
    queryFn: fetchHelmRepositories,
  })
}

export const useHelmCharts = (options?: {
  repository?: string
  query?: string
  enabled?: boolean
}) => {
  return useQuery({
    queryKey: [
      'helmcharts',
      'charts',
      options?.repository || '',
      options?.query || '',
    ],
    queryFn: () => fetchHelmCharts(options),
    enabled: options?.enabled ?? true,
  })
}

export const useArtifactHubCharts = (options?: {
  query?: string
  verifiedPublisher?: boolean
  limit?: number
  offset?: number
  enabled?: boolean
}) => {
  return useQuery({
    queryKey: [
      'helmcharts',
      'artifacthub',
      options?.query || '',
      options?.verifiedPublisher ?? true,
      options?.limit || 20,
      options?.offset || 0,
    ],
    queryFn: () => fetchArtifactHubCharts(options),
    enabled: options?.enabled ?? true,
  })
}

export const useHelmChart = (
  repository: string | undefined,
  name: string | undefined,
  version?: string,
  source?: 'repository' | 'artifacthub',
  enabled = true
) => {
  return useQuery({
    queryKey: [
      'helmcharts',
      'chart',
      source || 'repository',
      repository,
      name,
      version || '',
    ],
    queryFn: () =>
      fetchHelmChart(repository || '', name || '', version, source),
    enabled: Boolean(enabled && repository && name),
  })
}

export const useHelmChartContent = (
  repository: string | undefined,
  name: string | undefined,
  content: HelmChartContentType,
  version?: string,
  source?: 'repository' | 'artifacthub',
  enabled = true
) => {
  return useQuery({
    queryKey: [
      'helmcharts',
      'chart-content',
      source || 'repository',
      repository,
      name,
      version || '',
      content,
    ],
    queryFn: () =>
      fetchHelmChartContent(
        repository || '',
        name || '',
        content,
        version,
        source
      ),
    enabled: Boolean(enabled && repository && name),
  })
}

// 节点操作 API
export const drainNode = async (
  nodeName: string,
  options: {
    force: boolean
    gracePeriod: number
    deleteLocalData: boolean
    ignoreDaemonsets: boolean
    /** 超过这么多秒后中止 drain（0 = 不超时）。 */
    timeout?: number
  }
): Promise<{
  message: string
  node: string
  pods: number
  warnings?: string | string[]
}> => {
  const endpoint = `/nodes/_all/${nodeName}/drain`
  const response = await apiClient.put<{
    message: string
    node: string
    pods: number
    warnings?: string | string[]
  }>(endpoint, options, { operation: 'nodeMaintenance' })

  return response
}

export const cordonNode = async (
  nodeName: string
): Promise<{ message: string; node: string; unschedulable: boolean }> => {
  const endpoint = `/nodes/_all/${nodeName}/cordon`
  const response = await apiClient.put<{
    message: string
    node: string
    unschedulable: boolean
  }>(endpoint, undefined, { operation: 'nodeMaintenance' })

  return response
}

export const uncordonNode = async (
  nodeName: string
): Promise<{ message: string; node: string; unschedulable: boolean }> => {
  const endpoint = `/nodes/_all/${nodeName}/uncordon`
  const response = await apiClient.put<{
    message: string
    node: string
    unschedulable: boolean
  }>(endpoint, undefined, { operation: 'nodeMaintenance' })

  return response
}

export const taintNode = async (
  nodeName: string,
  taint: {
    key: string
    value: string
    effect: 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute'
  }
): Promise<{ message: string; node: string; taint: unknown }> => {
  const endpoint = `/nodes/_all/${nodeName}/taint`
  const response = await apiClient.put<{
    message: string
    node: string
    taint: unknown
  }>(endpoint, taint, { operation: 'nodeMaintenance' })

  return response
}

export const untaintNode = async (
  nodeName: string,
  key: string
): Promise<{ message: string; node: string; removedTaintKey: string }> => {
  const endpoint = `/nodes/_all/${nodeName}/untaint`
  const response = await apiClient.put<{
    message: string
    node: string
    removedTaintKey: string
  }>(endpoint, { key }, { operation: 'nodeMaintenance' })

  return response
}

export const updateResource = async <T extends ResourceType>(
  resource: T,
  name: string,
  namespace: string | undefined,
  body: ResourceTypeMap[T]
): Promise<void> => {
  const endpoint = `/${resource}/${namespace || '_all'}/${name}`
  // Secret 的 data / stringData 是敏感值，整包走信封加密；其它资源保持明文，
  // 不给大对象凭空加一次加密开销。
  await apiClient.put(
    `${endpoint}`,
    resource === 'secrets' ? await encryptRequestBody(body) : body
  )
}

export const resizePod = async (
  namespace: string,
  name: string,
  body: Partial<Pod>
): Promise<void> => {
  const endpoint = `/pods/${namespace || '_all'}/${name}/resize`
  await apiClient.patch(`${endpoint}`, body)
}

export const debugPod = async (
  namespace: string,
  name: string,
  body: { image: string; targetContainerName: string; command?: string[] }
): Promise<{ pod: Pod; containerName: string }> => {
  return apiClient.patch(`/pods/${namespace}/${name}/debug`, body)
}

export const copyDebugPod = async (
  namespace: string,
  name: string,
  body: {
    copyTo: string
    targetContainerName: string
    image?: string
    command: string[]
  }
): Promise<{ pod: Pod; containerName: string }> => {
  return apiClient.post(`/pods/${namespace}/${name}/debug-copy`, body)
}

// DeepPartial 描述 patch 请求体：只提交要改的字段，其余不动。工作负载行的
// 「修改镜像」菜单需要按资源类型拼出这个请求体（Pod 与 CronJob 的容器路径不同），
// 因此把类型一并导出。
export type DeepPartial<T> = T extends object
  ? {
      [P in keyof T]?: DeepPartial<T[P]>
    }
  : T
export const patchResource = async <T extends ResourceType>(
  resource: T,
  name: string,
  namespace: string | undefined,
  body: DeepPartial<ResourceTypeMap[T]>
): Promise<void> => {
  const endpoint = `/${resource}/${namespace || '_all'}/${name}`
  await apiClient.patch(`${endpoint}`, body)
}

// 自定义资源走 CRD 路由（/:crd/:namespace/:name）；CRD 不支持 strategic-merge
// patch，后端默认按 JSON Merge Patch 处理，patchType 'json' 切换为 JSON Patch。
export const patchCustomResource = async (
  crd: string,
  name: string,
  namespace: string | undefined,
  body: DeepPartial<CustomResource>,
  patchType?: 'json'
): Promise<void> => {
  const endpoint = `/${crd}/${namespace || '_all'}/${name}`
  const query = patchType ? `?patchType=${patchType}` : ''
  await apiClient.patch(`${endpoint}${query}`, body)
}

export const restartWorkload = async (
  resource: 'deployments' | 'statefulsets' | 'daemonsets',
  name: string,
  namespace: string
): Promise<void> => {
  const endpoint = `/${resource}/${namespace}/${name}`
  // 显式标注为「重启」：它与普通修改用同一个 URL、同一个 PATCH，只是请求体里多了
  // restartedAt 注解，仅凭 method 与路径无法区分（见 lib/write-confirm.ts 的分类口径）。
  await apiClient.patch(
    endpoint,
    {
      spec: {
        template: {
          metadata: {
            annotations: {
              'aerolink.kubernetes.io/restartedAt': new Date().toISOString(),
            },
          },
        },
      },
    },
    { operation: 'restart' }
  )
}

export const createResource = async <T extends ResourceType>(
  resource: T,
  namespace: string | undefined,
  body: ResourceTypeMap[T]
): Promise<ResourceTypeMap[T]> => {
  const endpoint = `/${resource}/${namespace || '_all'}`
  return await apiClient.post<ResourceTypeMap[T]>(
    `${endpoint}`,
    resource === 'secrets' ? await encryptRequestBody(body) : body
  )
}

export const deleteResource = async <T extends ResourceType>(
  resource: T,
  name: string,
  namespace: string | undefined,
  opts?: {
    force?: boolean
    wait?: boolean
  }
): Promise<void> => {
  const params = new URLSearchParams()
  if (opts?.force) {
    params.append('force', 'true')
  }
  if (opts?.wait === false) {
    params.append('wait', 'false')
  }
  const endpoint = `/${resource}/${namespace || '_all'}/${name}?${params.toString()}`
  await apiClient.delete(endpoint)
}

// 从 YAML 应用资源
export interface ApplyResourceRequest {
  yaml: string
  namespace?: string
}

export interface ApplyResourceResponse {
  message: string
  kind?: string
  name?: string
  namespace?: string
  count?: number
  resources?: Array<{
    kind: string
    name: string
    namespace?: string
  }>
}

export const applyResource = async (
  yaml: string,
  namespace?: string
): Promise<ApplyResourceResponse> => {
  // YAML 里可能直接带 Secret / 证书 / 口令，整包加密。
  return await apiClient.post<ApplyResourceResponse>(
    '/resources/apply',
    await encryptRequestBody({ yaml, namespace })
  )
}

export const useResourcesEvents = <T extends ResourceType>(
  resource: T,
  name: string,
  namespace?: string,
  options?: { refreshInterval?: number }
) => {
  return useQuery({
    queryKey: ['resource-events', resource, namespace, name],
    queryFn: () => {
      const endpoint =
        '/events/resources?' +
        new URLSearchParams({
          resource: resource,
          name: name,
          namespace: namespace || '',
        }).toString()
      return fetchAPI<ResourcesTypeMap['events']>(endpoint)
    },
    select: (data: ResourcesTypeMap['events']): ResourcesItems<'events'> =>
      data.items,
    placeholderData: (prevData) => prevData,
    refetchInterval: options?.refreshInterval || 0,
  })
}

export const useResources = <T extends ResourceType>(
  resource: T,
  namespace?: string,
  options?: {
    staleTime?: number
    limit?: number
    labelSelector?: string
    fieldSelector?: string
    refreshInterval?: number
    disable?: boolean
    reduce?: boolean
    namespaces?: string[]
  }
) => {
  const namespacesKey = options?.namespaces?.join(',')
  return useQuery({
    queryKey: [
      resource,
      namespace,
      options?.limit,
      options?.labelSelector,
      options?.fieldSelector,
      namespacesKey,
    ],
    queryFn: () => {
      return fetchResources<ResourcesTypeMap[T]>(resource, namespace, {
        limit: options?.limit,
        continueToken: undefined,
        labelSelector: options?.labelSelector,
        fieldSelector: options?.fieldSelector,
        reduce: options?.reduce,
        namespaces: options?.namespaces,
      })
    },
    enabled: !options?.disable,
    select: (data: ResourcesTypeMap[T]): ResourcesItems<T> => data.items,
    placeholderData: (prevData) => prevData,
    refetchInterval: options?.refreshInterval || 0,
    staleTime: options?.staleTime || (resource === 'crds' ? 5000 : 1000),
  })
}

// 服务端明确拒绝（429 限流、403 无权限等）时，EventSource 的 readyState 会是 CLOSED，
// 浏览器不会自动重连；而网络抖动、服务端主动断流是 CONNECTING，浏览器自己会重连。
// 这里用数值常量而不是 EventSource.CLOSED：测试里的替身不一定带静态常量。
const EVENT_SOURCE_CLOSED = 2

// 被限流降级为轮询时的默认轮询间隔，以及「定期把 SSE 抢回来」的探测间隔。
const WATCH_FALLBACK_POLL_INTERVAL = 5000
const WATCH_STREAM_PROBE_INTERVAL = 30000

// 每次连接建立后的「重同步窗口」：服务端的初始快照是一串 added 事件、没有结束标记，
// 客户端只能把这段时间里收到的对象记下来，窗口一关就把没再出现过的行丢掉。
// 断线期间被删掉的对象不会再有任何事件，不丢就等于把已删除的行永久留在列表里
// （用户报过的「Pod 已经删了、点刷新还在」）。取值远大于快照在正常网络下的到达时间，
// 窗口内还没到的行会被各自的事件补回来。
const WATCH_RESYNC_WINDOW_MS = 800

/** watch 列表里一条对象的身份：命名空间 + 名字。 */
const watchItemKey = (obj: {
  metadata?: { namespace?: string; name?: string }
}) => `${obj.metadata?.namespace || ''}/${obj.metadata?.name || ''}`

// Hook：资源列表的 SSE watch（初始快照 + ADDED/MODIFIED/DELETED）
//
// 列表数据在本地 state 里，不写进 react-query 缓存：外壳点「刷新」时
// `refetchQueries` 碰不到它，靠订阅页面刷新信号（见 page-refresh-context）驱动重连重取。
export function useResourcesWatch<T extends ResourceType>(
  resource: T,
  namespace?: string,
  options?: {
    labelSelector?: string
    fieldSelector?: string
    reduce?: boolean
    enabled?: boolean
    /** 页面不可见时断开连接（默认开启），可见时立即重连并重新取快照。 */
    pauseWhenHidden?: boolean
    /** 被限流降级为轮询时的轮询间隔（毫秒，默认 5000）。 */
    fallbackPollInterval?: number
  }
) {
  const pageRefreshEpoch = usePageRefreshEpoch()
  const [data, setData] = useState<ResourcesItems<T> | undefined>(undefined)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const eventSourceRef = useRef<EventSource | null>(null)
  // refetch 的重连定时器：不记下来就可能在组件卸载后又建一条连接。
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 降级轮询的定时器，以及探测 SSE 是否可用的定时器。
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const streamProbeTimerRef = useRef<ReturnType<typeof setInterval> | null>(
    null
  )
  // 是否处于「被服务端拒绝、降级为轮询」的状态。
  const degradedRef = useRef(false)
  // 让定时器与可见性监听都能调到最新的 connect，避免两个 useCallback 互相依赖。
  const connectRef = useRef<() => void>(() => {})
  // 是否已经收到过数据：重连时据此保留旧列表，只在首屏进加载态。
  const hasDataRef = useRef(false)
  // 上一次连接的 URL：用来区分「重连」与「切换集群 / 命名空间 / 资源」。
  const lastUrlRef = useRef<string | null>(null)
  // 连续重连次数：连接成功后清零，用于指数退避。
  const reconnectAttemptRef = useRef(0)
  // 重同步窗口：本轮快照里见过的对象，以及窗口的关闭定时器（见 WATCH_RESYNC_WINDOW_MS）。
  const resyncKeysRef = useRef<Set<string> | null>(null)
  const resyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const buildUrl = useCallback(() => {
    const ns = namespace || '_all'
    const params = new URLSearchParams()
    if (options?.reduce !== false) params.append('reduce', 'true')
    if (options?.labelSelector)
      params.append('labelSelector', options.labelSelector)
    if (options?.fieldSelector)
      params.append('fieldSelector', options.fieldSelector)
    appendCurrentClusterParam(params)
    return withSubPath(
      `${API_BASE_URL}/${resource}/${ns}/watch?${params.toString()}`
    )
  }, [
    resource,
    namespace,
    options?.reduce,
    options?.labelSelector,
    options?.fieldSelector,
  ])

  const disconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }
    // 断开时不留半截重同步窗口：下一次连接会重新开一个，按旧集合裁剪会误删
    // 「新快照还没轮到」的行。
    if (resyncTimerRef.current) {
      clearTimeout(resyncTimerRef.current)
      resyncTimerRef.current = null
    }
    resyncKeysRef.current = null
  }, [])

  /**
   * 关掉当前的重同步窗口：把这轮快照里没再出现过的行丢掉。
   *
   * 服务端的初始快照是一串 `added`、没有结束标记，客户端只能靠这个窗口判断
   * 「快照大概发完了」。若不这样做，断线期间被删掉的对象（不会再有任何事件）会永久
   * 留在列表里——重连只是又合并了一次快照，点刷新也去不掉。
   */
  const endResync = useCallback(() => {
    if (resyncTimerRef.current) {
      clearTimeout(resyncTimerRef.current)
      resyncTimerRef.current = null
    }
    const keys = resyncKeysRef.current
    resyncKeysRef.current = null
    if (!keys) return
    setData((prev) => {
      if (!prev) return prev
      const next = prev.filter((item) =>
        keys.has(watchItemKey(item as ResourceTypeMap[T] & object))
      )
      return next.length === prev.length
        ? prev
        : (next as unknown as ResourcesItems<T>)
    })
  }, [])

  const beginResync = useCallback(() => {
    if (resyncTimerRef.current) clearTimeout(resyncTimerRef.current)
    resyncKeysRef.current = new Set()
    resyncTimerRef.current = setTimeout(endResync, WATCH_RESYNC_WINDOW_MS)
  }, [endResync])

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
    if (streamProbeTimerRef.current) {
      clearInterval(streamProbeTimerRef.current)
      streamProbeTimerRef.current = null
    }
    degradedRef.current = false
  }, [])

  // 停掉这条 watch 的一切：SSE 连接、重连定时器与降级轮询。
  const stopAll = useCallback(() => {
    disconnect()
    stopPolling()
  }, [disconnect, stopPolling])

  // 取一次列表：与 useResources 同一条 REST 路径。只在拿不到 SSE 连接时才用
  // （服务端按用户限流返回 429），拿到的整份列表直接当作最新状态。
  const pollList = useCallback(async () => {
    try {
      const result = await fetchResources<ResourcesTypeMap[T]>(
        resource,
        namespace,
        {
          labelSelector: options?.labelSelector,
          fieldSelector: options?.fieldSelector,
          // 与 buildUrl 同一口径（默认裁剪），别让轮询拿回一份字段更全的列表。
          reduce: options?.reduce !== false,
        }
      )
      hasDataRef.current = true
      setIsLoading(false)
      setError(null)
      setData(result.items as ResourcesItems<T>)
    } catch (err) {
      setIsLoading(false)
      if (err instanceof Error) setError(err)
    }
  }, [
    resource,
    namespace,
    options?.labelSelector,
    options?.fieldSelector,
    options?.reduce,
  ])

  const pollInterval =
    options?.fallbackPollInterval && options.fallbackPollInterval > 0
      ? options.fallbackPollInterval
      : WATCH_FALLBACK_POLL_INTERVAL

  // 服务端拒绝连接（如 429 限流）时的降级路径：改用轮询刷新，
  // 同时定期探测 SSE 是否已经可用，可用就切回去（onopen 里停掉轮询）。
  const startPolling = useCallback(() => {
    if (degradedRef.current) return
    degradedRef.current = true
    void pollList()
    pollTimerRef.current = setInterval(() => void pollList(), pollInterval)
    streamProbeTimerRef.current = setInterval(
      () => connectRef.current(),
      WATCH_STREAM_PROBE_INTERVAL
    )
  }, [pollInterval, pollList])

  const connect = useCallback(() => {
    disconnect()
    if (options?.enabled === false) return
    const url = buildUrl()
    // 集群 / 命名空间 / 资源等参数变了就清空旧数据，避免短暂显示上一个集群的列表；
    // 同一参数下的重连则保留旧数据，避免列表闪空或一直转圈。
    if (url !== lastUrlRef.current) {
      lastUrlRef.current = url
      hasDataRef.current = false
      // 换了目标就重新开始退避计数，别让上一个目标的失败拖慢新连接。
      reconnectAttemptRef.current = 0
      setData(undefined)
    }
    // 只有还没有任何数据时才进加载态（首个快照要等 watch 的首批事件）。
    if (!hasDataRef.current) setIsLoading(true)
    setError(null)
    setIsConnected(false)

    try {
      const es = new EventSource(url, { withCredentials: true })
      eventSourceRef.current = es
      // 开一个重同步窗口：这轮快照（一串 added）发完后，把没再出现过的行丢掉。
      beginResync()

      es.onopen = () => {
        setIsConnected(true)
        // 连接已建立：抢回来的连接要让降级轮询停下来。
        stopPolling()
        // 连接已建立，退避计数清零。
        reconnectAttemptRef.current = 0
      }

      const getKey = (obj: ResourceTypeMap[T]) =>
        watchItemKey(obj as ResourceTypeMap[T] & object)

      const upsert = (obj: string) => {
        const object = JSON.parse(obj) as ResourceTypeMap[T]
        hasDataRef.current = true
        setIsLoading(false)
        // 重同步窗口内收到的对象都要记下来：窗口关闭时按这份集合裁剪（见 endResync）。
        resyncKeysRef.current?.add(getKey(object))
        setData((prev) => {
          const arr = prev ? [...prev] : []
          const key = getKey(object)
          const idx = arr.findIndex(
            (it) => getKey(it as ResourceTypeMap[T]) === key
          )
          if (idx >= 0) arr[idx] = object
          else arr.unshift(object)
          return arr as ResourcesItems<T>
        })
      }

      const remove = (obj: string) => {
        const object = JSON.parse(obj) as ResourceTypeMap[T]
        hasDataRef.current = true
        setIsLoading(false)
        setData((prev) => {
          const arr = prev ? [...prev] : []
          const key = getKey(object)
          const filtered = arr.filter(
            (it) => getKey(it as ResourceTypeMap[T]) !== key
          )
          return filtered as ResourcesItems<T>
        })
      }

      es.addEventListener('added', (e: MessageEvent<string>) => {
        upsert(e.data)
      })
      es.addEventListener('modified', (e: MessageEvent<string>) => {
        upsert(e.data)
      })
      es.addEventListener('deleted', (e: MessageEvent<string>) => {
        remove(e.data)
      })

      // Pods 的周期用量推送：服务端只下发用量数字，这里 merge 进已有行，
      // 避免每 15s 重传整个 Pod 本体。其它资源不会收到该事件。
      type PodMetricsUpdate = {
        namespace: string
        name: string
        cpuUsage: number
        memoryUsage: number
      }
      es.addEventListener('metrics', (e: MessageEvent<string>) => {
        let updates: PodMetricsUpdate[]
        try {
          updates = JSON.parse(e.data) as PodMetricsUpdate[]
        } catch {
          return
        }
        if (!Array.isArray(updates) || updates.length === 0) return
        hasDataRef.current = true
        const byKey = new Map<string, PodMetricsUpdate>(
          updates.map((u): [string, PodMetricsUpdate] => [
            `${u.namespace}/${u.name}`,
            u,
          ])
        )
        setData((prev) => {
          if (!prev) return prev
          const next = prev.map((item) => {
            const update = byKey.get(getKey(item as ResourceTypeMap[T]))
            if (!update) return item
            const withMetrics = item as ResourceTypeMap[T] & {
              metrics?: Record<string, number> | null
            }
            return {
              ...withMetrics,
              metrics: {
                ...(withMetrics.metrics ?? {}),
                cpuUsage: update.cpuUsage,
                memoryUsage: update.memoryUsage,
              },
            } as ResourceTypeMap[T]
          })
          return next as ResourcesItems<T>
        })
      })

      // 服务端若显式给出「快照发完」的标记，就不用等窗口到期了。
      // 空快照（无匹配对象或 RBAC 过滤后为 0）不会带来任何 added：
      // 快照完成即收起加载态，否则界面会永远停在「加载中」。
      es.addEventListener('synced', () => {
        hasDataRef.current = true
        setIsLoading(false)
        endResync()
      })

      es.addEventListener('error', (e: MessageEvent) => {
        try {
          const payload = JSON.parse(e.data)
          setError(new Error(payload?.error || 'SSE error'))
        } catch {
          setError(new Error('SSE error'))
        }
        setIsLoading(false)
        setIsConnected(false)
      })
      es.addEventListener('close', () => {
        setIsConnected(false)
      })

      es.onerror = () => {
        // 连接失败时也要收起加载态，否则会一直停在「加载中」。
        setIsLoading(false)
        setIsConnected(false)
        // CLOSED 表示服务端明确拒绝（如 429 限流）：浏览器不会自动重连，
        // 此时降级为轮询，别让页面一直停在「已断开」且不再刷新。
        if (
          eventSourceRef.current === es &&
          es.readyState === EVENT_SOURCE_CLOSED
        ) {
          startPolling()
        }
      }
    } catch (err) {
      if (err instanceof Error) setError(err)
      setIsLoading(false)
      setIsConnected(false)
    }
  }, [
    buildUrl,
    disconnect,
    options?.enabled,
    startPolling,
    stopPolling,
    beginResync,
    endResync,
  ])

  // 定时器与可见性监听通过 ref 调用，避免与 connect 形成循环依赖。
  connectRef.current = connect

  const refetch = useCallback(
    (options?: { immediate?: boolean }) => {
      // 降级期间重新取一次列表就够了：再抢 SSE 也只会立刻被拒。
      if (degradedRef.current) {
        void pollList()
        return
      }
      disconnect()
      // 用户显式点「刷新」（含页面刷新信号）时立刻重连一次：退避是给自动重连抗抖动用的，
      // 不该让一次手动刷新等上几十秒。
      if (options?.immediate) {
        reconnectAttemptRef.current = 0
        reconnectTimerRef.current = setTimeout(connect, 0)
        return
      }
      // 连续重连时指数退避（1s → 30s 封顶），避免服务端抖动时所有页面同时回连；
      // 连接成功后在 onopen 里清零。
      const delay = Math.min(1000 * 2 ** reconnectAttemptRef.current, 30000)
      reconnectAttemptRef.current += 1
      reconnectTimerRef.current = setTimeout(connect, delay)
    },
    [disconnect, connect, pollList]
  )

  // 页面外壳点「刷新」时重新连接并重取快照。首次挂载不算刷新（先记下初始代数），
  // refetch 身份变化（labelSelector 变了等）也不触发，所以只依赖代数本身。
  const refetchRef = useRef(refetch)
  refetchRef.current = refetch
  const appliedEpochRef = useRef(pageRefreshEpoch)
  useEffect(() => {
    if (appliedEpochRef.current === pageRefreshEpoch) return
    appliedEpochRef.current = pageRefreshEpoch
    refetchRef.current({ immediate: true })
  }, [pageRefreshEpoch])

  useEffect(() => {
    if (options?.enabled === false) return
    connect()
    return () => {
      // stopAll 会一并清掉尚在等待的重连定时器与降级轮询。
      stopAll()
    }
  }, [connect, stopAll, options?.enabled])

  // 页面不可见时断开连接：一条 watch 会常驻占用一个上游流与一个浏览器连接名额，
  // 而没人看的标签页不需要实时数据（服务端的连接数也随之下降）。
  // 可见时立即重连，重新拿到一份快照。
  useEffect(() => {
    if (options?.pauseWhenHidden === false) return
    const onVisibilityChange = () => {
      if (document.hidden) {
        stopAll()
      } else {
        connectRef.current()
      }
    }
    // 挂载时就已经不可见（浏览器恢复会话会这样）：别白建一条连接。
    if (document.hidden) stopAll()
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [options?.pauseWhenHidden, stopAll])

  return { data, isLoading, error, isConnected, refetch, stop: stopAll }
}

export const fetchResource = <T>(
  resource: string,
  name: string,
  namespace?: string,
  cluster?: string | null
): Promise<T> => {
  const resourcePath = namespace
    ? `/${resource}/${namespace}/${name}`
    : `/${resource}/${name}`
  return fetchAPI<T>(withCurrentClusterPath(resourcePath, cluster))
}
export const useResource = <T extends keyof ResourceTypeMap>(
  resource: T,
  name: string,
  namespace?: string,
  options?: { staleTime?: number; refreshInterval?: number; enabled?: boolean }
) => {
  const { currentCluster } = useCluster()
  const ns = namespace || '_all'
  return useQuery({
    queryKey: getResourceQueryKey(resource, ns, name, currentCluster),
    // 没有名字时不要发请求：创建页会渲染同一个组件，空名字的 GET 只会拿到 404。
    enabled: options?.enabled ?? true,
    queryFn: () => {
      return fetchResource<ResourceTypeMap[T]>(
        resource,
        name,
        ns,
        currentCluster
      )
    },
    refetchOnWindowFocus: 'always',
    refetchInterval: options?.refreshInterval || 0, // Default to no auto-refresh
    staleTime: options?.staleTime || 1000,
  })
}
// Pod describe 接口
export const fetchDescribe = async (
  resourceType: ResourceType,
  name: string,
  namespace?: string
): Promise<{ result: string }> => {
  const endpoint = `/${resourceType}/${namespace ?? '_all'}/${name}/describe`
  return fetchAPI<{ result: string }>(endpoint)
}

export const useDescribe = (
  resourceType: ResourceType,
  name: string,
  namespace?: string,
  options?: { staleTime?: number; enabled?: boolean }
) => {
  return useQuery({
    queryKey: [resourceType, name, namespace, 'describe'],
    queryFn: () => fetchDescribe(resourceType, name, namespace),
    enabled: (options?.enabled ?? true) && !!name,
    staleTime: options?.staleTime || 0,
    retry: 0,
  })
}
export interface FileInfo {
  name: string
  isDir: boolean
  size: string
  modTime: string
  mode: string
  uid: string
  gid: string
}

export const podListFiles = async (
  namespace: string,
  podName: string,
  container: string,
  path: string,
  options?: RequestInit
): Promise<FileInfo[]> => {
  const params = new URLSearchParams({
    container,
    path,
  })
  return apiClient.get<FileInfo[]>(
    `${withCurrentClusterPath(`/pods/${namespace}/${podName}/files`)}?${params.toString()}`,
    options
  )
}

export const podDownloadFile = (
  namespace: string,
  podName: string,
  container: string,
  path: string
) => {
  const params = new URLSearchParams({
    container,
    path,
  })
  const url = withSubPath(
    `${API_BASE_URL}${withCurrentClusterPath(`/pods/${namespace}/${podName}/files/download`)}?${params.toString()}`
  )
  window.open(url, '_blank')
}

export const podPreviewFile = (
  namespace: string,
  podName: string,
  container: string,
  path: string
) => {
  const params = new URLSearchParams({
    container,
    path,
  })
  const url = withSubPath(
    `${API_BASE_URL}${withCurrentClusterPath(`/pods/${namespace}/${podName}/files/preview`)}?${params.toString()}`
  )
  window.open(url, '_blank')
}

export const podUploadFile = async (
  namespace: string,
  podName: string,
  container: string,
  path: string,
  file: File,
  // 默认 false：后端碰到同名文件会回 409，由界面确认后带 true 重试（缺陷 D-14）。
  overwrite = false
): Promise<void> => {
  const formData = new FormData()
  formData.append('file', file)
  const params = new URLSearchParams({
    container,
    path,
  })
  if (overwrite) {
    params.set('overwrite', 'true')
  }

  await apiClient.put(
    `${withCurrentClusterPath(`/pods/${namespace}/${podName}/files/upload`)}?${params.toString()}`,
    formData
  )
}

export const fetchTemplates = async (): Promise<ResourceTemplate[]> => {
  return fetchAPI<ResourceTemplate[]>('/templates/')
}

export const createTemplate = async (
  data: Omit<ResourceTemplate, 'id'>
): Promise<ResourceTemplate> => {
  return apiClient.post<ResourceTemplate>('/admin/templates/', data)
}

export const updateTemplate = async (
  id: number,
  data: Partial<ResourceTemplate>
): Promise<ResourceTemplate> => {
  return apiClient.put<ResourceTemplate>(`/admin/templates/${id}`, data)
}

export const deleteTemplate = async (id: number): Promise<void> => {
  await apiClient.delete(`/admin/templates/${id}`)
}

export const useTemplates = (options?: { staleTime?: number }) => {
  return useQuery({
    queryKey: ['templates'],
    queryFn: fetchTemplates,
    staleTime: options?.staleTime || 30000,
  })
}
export async function getImageTags(image: string): Promise<ImageTagInfo[]> {
  if (!image) return []
  const resp = await apiClient.get<ImageTagInfo[]>(
    `/image/tags?image=${encodeURIComponent(image)}`
  )
  return resp
}

export function useImageTags(image: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['image-tags', image],
    queryFn: () => getImageTags(image),
    enabled: !!image && (options?.enabled ?? true),
    staleTime: 60 * 1000, // 1 min
    placeholderData: (prev) => prev,
  })
}

export async function getRelatedResources(
  resource: ResourceType,
  name: string,
  namespace?: string
) {
  const resp = await apiClient.get<RelatedResources[]>(
    `/${resource}/${namespace ? namespace : '_all'}/${name}/related`
  )
  return resp
}

export function useRelatedResources(
  resource: ResourceType,
  name: string,
  namespace?: string
) {
  return useQuery({
    queryKey: ['related-resources', resource, name, namespace],
    queryFn: () => getRelatedResources(resource, name, namespace),
    // 后端只为部分资源类型注册了 /related（如 nodes 就没有），对不存在的路径发请求
    // 只会得到 404 + 一个误导向的「暂无相关资源」（缺陷 D-41）。
    enabled: supportsRelatedResources(resource),
    staleTime: 60 * 1000, // 1 min
    placeholderData: (prev) => prev,
  })
}
// 资源历史 API
export const fetchResourceHistory = (
  resourceType: string,
  namespace: string,
  name: string,
  page: number = 1,
  pageSize: number = 10
): Promise<ResourceHistoryResponse> => {
  const endpoint = `/${resourceType}/${namespace}/${name}/history?page=${page}&pageSize=${pageSize}`
  return fetchAPI<ResourceHistoryResponse>(endpoint)
}

export const fetchWorkloadRevisions = (
  resourceType: WorkloadRevisionResourceType,
  namespace: string,
  name: string
): Promise<WorkloadRevisionsResponse> => {
  return fetchAPI<WorkloadRevisionsResponse>(
    `/${resourceType}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/revisions`
  )
}

export const useWorkloadRevisions = (
  resourceType: WorkloadRevisionResourceType,
  namespace: string,
  name: string,
  options?: { enabled?: boolean; staleTime?: number }
) => {
  return useQuery({
    queryKey: ['workload-revisions', resourceType, namespace, name],
    queryFn: () => fetchWorkloadRevisions(resourceType, namespace, name),
    enabled: options?.enabled ?? true,
    staleTime: options?.staleTime ?? 30000,
  })
}

export const rollbackWorkload = async (
  resourceType: WorkloadRevisionResourceType,
  namespace: string,
  name: string,
  revision: number
): Promise<{ message?: string; revision?: number }> => {
  return apiClient.put<{ message?: string; revision?: number }>(
    `/${resourceType}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/rollback`,
    { revision }
  )
}

export const useResourceHistory = (
  resourceType: string,
  namespace: string,
  name: string,
  page: number = 1,
  pageSize: number = 10,
  options?: { enabled?: boolean; staleTime?: number }
) => {
  return useQuery({
    queryKey: [
      'resource-history',
      resourceType,
      namespace,
      name,
      page,
      pageSize,
    ],
    queryFn: () =>
      fetchResourceHistory(resourceType, namespace, name, page, pageSize),
    enabled: options?.enabled ?? true,
    staleTime: options?.staleTime || 30000, // 30 seconds cache
  })
}

/** 一个对象「最近一次通过 AeroLink 成功写入」的时间（来自审计记录）。 */
export interface ResourceLastUpdate {
  resourceName: string
  namespace: string
  lastUpdatedAt: string
}

export const fetchResourceLastUpdates = async (
  resourceType: string,
  namespace: string
): Promise<ResourceLastUpdate[]> => {
  const response = await fetchAPI<{ data?: ResourceLastUpdate[] }>(
    `/${resourceType}/${encodeURIComponent(namespace)}/last-updates`
  )
  return response.data || []
}

/**
 * 列表页「平台操作时间」列的取数：一次拿回当前命名空间选择下每个对象的最近写入时间，
 * 返回 `"<namespace>/<name>" -> ISO 时间` 的映射。
 *
 * 两个口径上的限制要在界面上说得清（不要当成「从未被改过」）：
 *   - 只统计通过 AeroLink 的修改，kubectl / CI 直接改集群不会留下审计记录；
 *   - 审计 sink 不落库（parquet / ES）时后端返回 501，这里按「取不到」处理。
 *
 * 多选命名空间时逐个请求再合并：`_all` 子路由要显式的 `_all` 授权，限定命名空间
 * 的角色拿不到（与 /history 同一规则），逐个请求能让每个命名空间按自己的权限判定。
 * 单个命名空间失败（含 403）不影响其余结果。
 */
export const useResourceLastUpdates = (
  resourceType: string,
  namespaces: string[],
  options?: { enabled?: boolean; staleTime?: number }
) => {
  const { currentCluster } = useCluster()
  const namespaceKey = [...namespaces].sort().join(',')

  return useQuery({
    queryKey: [
      'resource-last-updates',
      resourceType,
      namespaceKey,
      currentCluster,
    ],
    queryFn: async () => {
      const groups = await Promise.all(
        namespaces.map((namespace) =>
          fetchResourceLastUpdates(resourceType, namespace).catch(() => [])
        )
      )

      const updates: Record<string, string> = {}
      for (const group of groups) {
        for (const item of group) {
          updates[`${item.namespace}/${item.resourceName}`] = item.lastUpdatedAt
        }
      }
      return updates
    },
    enabled: (options?.enabled ?? true) && namespaces.length > 0,
    staleTime: options?.staleTime ?? 30_000,
    placeholderData: (prev) => prev,
  })
}
export const usePodFiles = (
  namespace: string,
  podName: string,
  container: string,
  path: string,
  options?: { enabled?: boolean }
) => {
  return useQuery({
    queryKey: ['pod-files', namespace, podName, container, path],
    queryFn: () => podListFiles(namespace, podName, container, path),
    enabled: options?.enabled !== false,
    staleTime: 10000, // 10 seconds cache
  })
}
