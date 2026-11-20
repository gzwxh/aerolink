import { useMemo } from 'react'

import { ResourceType } from '@/types/api'
import { useResources, useResourcesWatch } from '@/lib/api'
import { usePagedResources } from '@/hooks/use-paged-resources'

interface UseResourceTableDataOptions {
  resourceName: string
  resourceType?: ResourceType
  namespace?: string
  useSSE: boolean
  refreshInterval: number
  labelSelector?: string
  /** 外部数据模式：不发起请求，数据由调用方提供（例如详情页内嵌表格）。 */
  disabled?: boolean
  /**
   * 多选命名空间集合。请求仍折叠成 `_all`，但把集合交给服务端收窄，
   * 分页与逐条鉴权都作用在选中范围内（见 usePagedResources / 后端 namespaces 参数）。
   */
  namespaces?: string[]
}

export function useResourceTableData<T>({
  resourceName,
  resourceType,
  namespace,
  useSSE,
  refreshInterval,
  labelSelector,
  disabled,
  namespaces,
}: UseResourceTableDataOptions) {
  const resolvedResourceType = (resourceType ??
    (resourceName.toLowerCase() as ResourceType)) as ResourceType

  // 「全部命名空间」与集群级资源（namespace 为空）不再一次拉全量：
  // 先取一批，再由表尾的「加载更多」按 continue token 追加。单命名空间保持
  // 原有全量请求，客户端搜索 / 列筛选 / 导出的语义不变。
  const pagedMode =
    !disabled && !useSSE && (namespace === undefined || namespace === '_all')

  const paged = usePagedResources(resolvedResourceType, {
    namespace,
    enabled: pagedMode,
    refreshInterval,
    labelSelector,
    namespaces,
    reduce: true,
  })

  const query = useResources(resolvedResourceType, namespace, {
    refreshInterval: useSSE ? 0 : refreshInterval,
    reduce: true,
    disable: useSSE || disabled || pagedMode,
    labelSelector,
    namespaces,
  })

  const watch = useResourcesWatch(resolvedResourceType, namespace, {
    reduce: true,
    enabled: useSSE && !disabled,
    labelSelector,
    // 被限流时按同一节奏降级为轮询，观感与关掉 SSE 的页面一致。
    fallbackPollInterval: refreshInterval,
  })

  const data = useMemo(
    () =>
      (useSSE ? watch.data : pagedMode ? paged.data : query.data) as
        T[] | undefined,
    [query.data, useSSE, watch.data, pagedMode, paged.data]
  )

  return {
    resourceType: resolvedResourceType,
    data,
    isLoading: useSSE
      ? watch.isLoading
      : pagedMode
        ? paged.isLoading
        : query.isLoading,
    isError: useSSE
      ? Boolean(watch.error)
      : pagedMode
        ? paged.isError
        : query.isError,
    error: (useSSE
      ? watch.error
      : pagedMode
        ? paged.error
        : query.error) as Error | null,
    refetch: useSSE ? watch.refetch : pagedMode ? paged.refetch : query.refetch,
    isConnected: watch.isConnected,
    hasMore: pagedMode ? paged.hasMore : false,
    isLoadingMore: pagedMode ? paged.isLoadingMore : false,
    loadMore: pagedMode ? paged.loadMore : undefined,
  }
}
