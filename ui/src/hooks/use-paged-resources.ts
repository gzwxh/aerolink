import { useCallback, useEffect, useRef, useState } from 'react'

import { ResourcesTypeMap, ResourceType } from '@/types/api'
import { fetchResources } from '@/lib/api'

type ResourceItems<T extends ResourceType> = ResourcesTypeMap[T]['items']

/**
 * 一次取多少条。列表每页 20 行，一批够翻 10 页，先给用户一个能用的首屏，
 * 剩下的由「加载更多」按需追加——「全部命名空间」下不再一次拉全量。
 */
export const PAGED_RESOURCE_PAGE_SIZE = 200

/**
 * 服务端 RBAC 逐项过滤发生在 `limit` 之后，一页可能被滤空。这里继续往后翻，
 * 直到凑够这一批或翻到末尾；上限防止权限极小时无限翻页。分片模式下上限还会
 * 与分片数联动（见 fetchBatch）。
 */
const MAX_PAGE_FETCHES = 10

/**
 * 单次请求最多携带的命名空间数，与后端 maxNamespaceFilterCount 对齐。选择超过
 * 这个数量时由前端分片轮转拉取（见 fetchBatch），任何数量都不会被静默截断。
 */
const NAMESPACE_FILTER_CHUNK_SIZE = 200

interface UsePagedResourcesOptions {
  namespace?: string
  pageSize?: number
  labelSelector?: string
  fieldSelector?: string
  /** 自动刷新间隔（毫秒，0 表示不刷新）。刷新重取「已加载条数」。 */
  refreshInterval?: number
  enabled?: boolean
  reduce?: boolean
  /** 多选命名空间集合：交给服务端收窄，避免分页窗口与客户端过滤错位。 */
  namespaces?: string[]
}

interface ItemIdentity {
  uid?: string
  namespace?: string
  name?: string
  creationTimestamp?: string
}

function metadataOf(item: unknown): ItemIdentity | undefined {
  return (item as { metadata?: ItemIdentity } | null | undefined)?.metadata
}

function itemKey(item: unknown): string | undefined {
  const metadata = metadataOf(item)
  if (!metadata) return undefined
  if (metadata.uid) return metadata.uid
  if (!metadata.name) return undefined
  return `${metadata.namespace || ''}/${metadata.name}`
}

/** 与后端列表口径一致：创建时间倒序，同时间按名字升序，跨批次追加后仍单调。 */
function sortByCreationDesc<T>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const left = metadataOf(a)
    const right = metadataOf(b)
    const leftTime = left?.creationTimestamp || ''
    const rightTime = right?.creationTimestamp || ''
    if (leftTime !== rightTime) {
      return leftTime < rightTime ? 1 : -1
    }
    return (left?.name || '').localeCompare(right?.name || '')
  })
}

/** 把命名空间集合切成 ≤size 的互不相交分片。 */
function splitNamespaceChunks(namespaces: string[], size: number): string[][] {
  const chunks: string[][] = []
  for (let start = 0; start < namespaces.length; start += size) {
    chunks.push(namespaces.slice(start, start + size))
  }
  return chunks
}

/**
 * 分片游标的打包与解包：每个分片一条独立游标，null 表示该分片已耗尽。
 * 打包结果仍是一个不透明字符串，调用方的 continueToken 状态不感知内部分片。
 */
function packChunkCursors(cursors: (string | null)[]): string | undefined {
  return cursors.some((cursor) => cursor !== null)
    ? JSON.stringify(cursors)
    : undefined
}

function unpackChunkCursors(
  raw: string | undefined,
  count: number
): (string | null)[] {
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (
        Array.isArray(parsed) &&
        parsed.length === count &&
        parsed.every((item) => typeof item === 'string' || item === null)
      ) {
        return parsed as (string | null)[]
      }
    } catch {
      // 落到下面的兜底
    }
  }
  // 无法识别的游标：所有分片从头拉，批内与跨批的 itemKey 去重兜住重复。
  return new Array<string | null>(count).fill('')
}

/**
 * 「全部命名空间」/ 集群级资源的增量加载。
 *
 * 首次只取 `pageSize` 条（带 `limit`），响应里的 `metadata.continue` 交给
 * `loadMore` 继续翻页；`refetch` 只重取已加载的条数，不再回到全量。
 */
export function usePagedResources<T extends ResourceType>(
  resource: T,
  options: UsePagedResourcesOptions = {}
) {
  const {
    namespace,
    pageSize = PAGED_RESOURCE_PAGE_SIZE,
    labelSelector,
    fieldSelector,
    refreshInterval = 0,
    enabled = true,
    reduce,
    namespaces,
  } = options

  // 数组引用每次渲染可能不同，用拼接结果做依赖，避免无谓重取。
  const namespacesKey =
    namespaces && namespaces.length > 0 ? namespaces.join(',') : undefined

  const [items, setItems] = useState<ResourceItems<T>>()
  const [continueToken, setContinueToken] = useState<string>()
  const [isLoading, setIsLoading] = useState(enabled)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  // 每次请求递增；只有最后一次请求的结果会被采纳（切换命名空间/资源时丢弃旧响应）。
  const requestIdRef = useRef(0)
  // 已加载条数：自动刷新按这个量重取，而不是回到全量。
  const loadedCountRef = useRef(0)

  const fetchBatch = useCallback(
    async (target: number, startToken?: string) => {
      const collected: unknown[] = []
      const seen = new Set<string>()
      const collect = (page: ResourcesTypeMap[T]) => {
        // 批内按 itemKey 去重：后端若有 List 接口漏抹假 continue token，会反复返回
        // 同一份全量数据；这里兜住，避免同一行在单次批量拉取里叠加。
        for (const item of (page.items ?? []) as unknown[]) {
          const key = itemKey(item)
          if (key && seen.has(key)) continue
          if (key) seen.add(key)
          collected.push(item)
        }
      }
      const request = (limit: number, token?: string, chunk?: string[]) =>
        fetchResources<ResourcesTypeMap[T]>(resource, namespace, {
          limit,
          continueToken: token,
          // 告诉后端这是真分页请求：informer 缓存不支持 continue，
          // 首次带 limit 也要走直连，否则拿回的是假 token。
          paginate: true,
          labelSelector,
          fieldSelector,
          reduce,
          namespaces:
            chunk ?? (namespacesKey ? namespacesKey.split(',') : undefined),
        })

      const namespaces =
        namespacesKey && namespacesKey.length > 0
          ? namespacesKey.split(',')
          : undefined
      const chunks =
        namespaces && namespaces.length > NAMESPACE_FILTER_CHUNK_SIZE
          ? splitNamespaceChunks(namespaces, NAMESPACE_FILTER_CHUNK_SIZE)
          : null

      if (!chunks) {
        let token = startToken
        for (let attempt = 0; attempt < MAX_PAGE_FETCHES; attempt++) {
          const remaining = Math.max(target - collected.length, 1)
          const page = await request(Math.min(pageSize, remaining), token)
          collect(page)
          token = page.metadata?.continue || undefined
          if (!token || collected.length >= target) {
            break
          }
        }
        return {
          items: collected as ResourceItems<T>,
          continueToken: token,
        }
      }

      // 多分片轮转：每个分片是互不相交的命名空间集合，各自维护独立游标；分片
      // 耗尽（null）后跳过，凑满一批或全部耗尽为止。分片互不重叠，不会因此
      // 漏数据；游标打包进 continueToken，跨批续拉时解包继续。
      const cursors = unpackChunkCursors(startToken, chunks.length)
      const maxAttempts = Math.max(MAX_PAGE_FETCHES, chunks.length * 2)
      let lastPicked = 0
      for (
        let attempt = 0;
        attempt < maxAttempts && collected.length < target;
        attempt++
      ) {
        let picked = -1
        for (let i = 0; i < chunks.length; i++) {
          const index = (lastPicked + i) % chunks.length
          if (cursors[index] !== null) {
            picked = index
            break
          }
        }
        if (picked === -1) {
          break
        }
        lastPicked = (picked + 1) % chunks.length

        const remaining = Math.max(target - collected.length, 1)
        const page = await request(
          Math.min(pageSize, remaining),
          cursors[picked] || undefined,
          chunks[picked]
        )
        collect(page)
        cursors[picked] = page.metadata?.continue || null
      }
      return {
        items: collected as ResourceItems<T>,
        continueToken: packChunkCursors(cursors),
      }
    },
    [
      fieldSelector,
      labelSelector,
      namespace,
      namespacesKey,
      pageSize,
      reduce,
      resource,
    ]
  )

  const reload = useCallback(async () => {
    const requestId = ++requestIdRef.current
    const target = Math.max(pageSize, loadedCountRef.current)
    setIsLoading(loadedCountRef.current === 0)
    setError(null)
    try {
      const batch = await fetchBatch(target)
      if (requestId !== requestIdRef.current) return
      const sorted = sortByCreationDesc(batch.items as unknown[])
      loadedCountRef.current = sorted.length
      setContinueToken(batch.continueToken)
      setItems(sorted as ResourceItems<T>)
    } catch (err) {
      if (requestId !== requestIdRef.current) return
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      // 只有最后一次请求才收尾：refresh 与 loadMore 竞争时，被作废的一方不清理，
      // 两个加载状态统一交给最后一次请求收尾，避免任何一方被永久卡住。
      if (requestId === requestIdRef.current) {
        setIsLoading(false)
        setIsLoadingMore(false)
      }
    }
  }, [fetchBatch, pageSize])

  const loadMore = useCallback(async () => {
    if (!continueToken || isLoadingMore) return
    const requestId = ++requestIdRef.current
    setIsLoadingMore(true)
    try {
      const batch = await fetchBatch(pageSize, continueToken)
      if (requestId !== requestIdRef.current) return
      const seen = new Set(
        (items ?? []).map(itemKey).filter((key): key is string => Boolean(key))
      )
      const appended = batch.items.filter((item) => {
        const key = itemKey(item)
        if (key && seen.has(key)) return false
        if (key) seen.add(key)
        return true
      })
      const merged = sortByCreationDesc([
        ...((items ?? []) as unknown[]),
        ...(appended as unknown[]),
      ])
      loadedCountRef.current = merged.length
      setContinueToken(batch.continueToken)
      setItems(merged as ResourceItems<T>)
    } catch (err) {
      if (requestId !== requestIdRef.current) return
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      // 同 reload：由最后一次请求统一收尾两个加载状态。
      if (requestId === requestIdRef.current) {
        setIsLoading(false)
        setIsLoadingMore(false)
      }
    }
  }, [continueToken, fetchBatch, isLoadingMore, items, pageSize])

  // 让在途请求的结果失效：切换资源 / 命名空间后旧响应不再写回。
  const invalidateRequests = useCallback(() => {
    requestIdRef.current++
  }, [])

  // 资源 / 命名空间 / 过滤条件变化时回到第一批；卸载时丢弃在途响应。
  useEffect(() => {
    if (!enabled) return
    loadedCountRef.current = 0
    void reload()
    return invalidateRequests
  }, [enabled, invalidateRequests, reload])

  useEffect(() => {
    if (!enabled || refreshInterval <= 0) return
    const timer = setInterval(() => {
      void reload()
    }, refreshInterval)
    return () => clearInterval(timer)
  }, [enabled, refreshInterval, reload])

  return {
    data: items,
    isLoading,
    isError: Boolean(error),
    error,
    refetch: reload,
    hasMore: Boolean(continueToken),
    isLoadingMore,
    loadMore,
  }
}
