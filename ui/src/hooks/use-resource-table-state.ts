import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ColumnFiltersState,
  ColumnSizingState,
  PaginationState,
  RowSelectionState,
  SortingState,
} from '@tanstack/react-table'

import { useResources } from '@/lib/api'
import { getClusterScopedStorageKey } from '@/lib/current-cluster'

interface UseResourceTableStateOptions {
  resourceName: string
  clusterScope: boolean
  defaultHiddenColumns: string[]
  /** 可选的命名空间，优先于存储的偏好（例如 URL 参数）。 */
  initialNamespace?: string
  /**
   * 可选的搜索词，优先于存储的偏好（例如从工作负载页跳过来时带的
   * `?search=<service 名>`，只显示那一个对象）。
   */
  initialSearch?: string
  /** 初始排序（例如命名空间页默认按「项目」分组的列排序展示）。 */
  initialSorting?: SortingState
}

function readStoredJSON<T>(storage: Storage, key: string, fallback: T): T {
  const value = storage.getItem(key)
  if (!value) {
    return fallback
  }

  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

/**
 * 把「用户存下的选择」收敛到「当前用户能访问的命名空间」上。
 *
 * `available` 来自 `/namespaces` 列表，后端已按 RBAC 过滤。没有选择（或原来选的
 * 命名空间已被回收权限）时优先落到 `default`，否则取列表第一个——不能写死
 * `default`，受限账号会一进页面就 403。`_all` 是显式选择，原样保留。
 */
export function resolveNamespaceSelection(
  current: string | undefined,
  available: string[]
): string | undefined {
  const fallback = available.includes('default') ? 'default' : available[0]
  if (!current) {
    return fallback
  }
  if (current === '_all') {
    return current
  }

  const wanted = current
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  const accessible = wanted.filter((name) => available.includes(name))
  if (accessible.length === 0) {
    return fallback
  }
  return accessible.length === wanted.length ? current : accessible.join(',')
}

export function useResourceTableState({
  resourceName,
  clusterScope,
  defaultHiddenColumns,
  initialNamespace,
  initialSearch,
  initialSorting,
}: UseResourceTableStateOptions) {
  const [sorting, setSorting] = useState<SortingState>(initialSorting ?? [])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>(() =>
    readStoredJSON(
      sessionStorage,
      getClusterScopedStorageKey(`-${resourceName}-columnFilters`),
      []
    )
  )
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState<string>(() => {
    if (initialSearch !== undefined) return initialSearch
    return (
      sessionStorage.getItem(
        getClusterScopedStorageKey(`-${resourceName}-searchQuery`)
      ) || ''
    )
  })
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState(searchQuery)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [columnVisibility, setColumnVisibility] = useState<
    Record<string, boolean>
  >(() => {
    const savedVisibility = readStoredJSON<Record<string, boolean> | null>(
      localStorage,
      getClusterScopedStorageKey(`-${resourceName}-columnVisibility`),
      null
    )
    if (savedVisibility) {
      return savedVisibility
    }

    const initialVisibility: Record<string, boolean> = {}
    defaultHiddenColumns.forEach((columnId) => {
      initialVisibility[columnId] = false
    })
    return initialVisibility
  })
  const [pagination, setPagination] = useState<PaginationState>(() => {
    const savedPageSize = localStorage.getItem(
      getClusterScopedStorageKey(`-${resourceName}-pageSize`)
    )
    return {
      pageIndex: 0,
      pageSize: savedPageSize ? Number(savedPageSize) : 20,
    }
  })
  // 列宽偏好：只存用户手动调整过的列（columnId -> 像素宽），
  // 未调整的列走列定义里的 size。读入时过滤掉非法值。
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>(() => {
    const saved = readStoredJSON<Record<string, unknown> | null>(
      localStorage,
      getClusterScopedStorageKey(`-${resourceName}-columnSizing`),
      null
    )
    if (!saved) {
      return {}
    }
    return Object.fromEntries(
      Object.entries(saved).filter(([, size]) => Number.isFinite(size))
    ) as ColumnSizingState
  })
  const [refreshInterval, setRefreshInterval] = useState(5000)
  // 命名空间列表在后端已按 RBAC 过滤（见 generic_resource_handler_list.go），
  // 就是「当前用户能看的命名空间」。与命名空间选择器共用一个 query key，不会重复请求。
  const namespacesQuery = useResources('namespaces', undefined, {
    disable: clusterScope,
    staleTime: 30_000,
  })
  const availableNamespaces = useMemo(() => {
    if (!namespacesQuery.data) return undefined
    return (
      namespacesQuery.data
        .map((ns) => ns.metadata?.name)
        .filter((name): name is string => Boolean(name))
        // 后端列表按创建时间倒序，取「第一个」时要可预期：按名字升序。
        .sort((left, right) => left.localeCompare(right))
    )
  }, [namespacesQuery.data])

  const [namespacePreference, setNamespacePreference] = useState<
    string | undefined
  >(() => {
    if (clusterScope) return undefined
    if (initialNamespace) return initialNamespace
    // 优先使用按标签页隔离的 sessionStorage，以隔离各标签页的命名空间选择
    const tabNamespace = sessionStorage.getItem(
      getClusterScopedStorageKey('selectedNamespace')
    )
    if (tabNamespace) return tabNamespace
    // 回退到 localStorage 作为全局偏好（新标签页继承上次选择）
    return (
      localStorage.getItem(getClusterScopedStorageKey('selectedNamespace')) ||
      undefined
    )
  })

  // 在渲染期就按可访问列表校正选择，而不是等 effect：否则会先按无权限的
  // 命名空间打一次必然 403 的请求。
  const selectedNamespace = useMemo(() => {
    if (clusterScope) return undefined
    if (!availableNamespaces || availableNamespaces.length === 0) {
      return namespacePreference
    }
    return resolveNamespaceSelection(namespacePreference, availableNamespaces)
  }, [availableNamespaces, clusterScope, namespacePreference])

  // 命名空间列表回来之前不发资源请求；列表请求失败时不再拦截（回落到旧行为）。
  const namespaceReady =
    clusterScope ||
    Boolean(initialNamespace) ||
    namespacesQuery.isError ||
    availableNamespaces !== undefined

  const [useSSE, setUseSSE] = useState(false)

  const effectiveNamespace = clusterScope
    ? undefined
    : selectedNamespace?.includes(',')
      ? '_all'
      : selectedNamespace

  // 解析出来的默认命名空间也要写回偏好，否则每个新标签页都会先读到
  // 已无权限的旧值、再校正一次（多一次不必要的命名空间列表等待）。
  useEffect(() => {
    if (clusterScope || !selectedNamespace) return
    const storageKey = getClusterScopedStorageKey('selectedNamespace')
    if (sessionStorage.getItem(storageKey) !== selectedNamespace) {
      sessionStorage.setItem(storageKey, selectedNamespace)
    }
    if (localStorage.getItem(storageKey) !== selectedNamespace) {
      localStorage.setItem(storageKey, selectedNamespace)
    }
  }, [clusterScope, selectedNamespace])

  useEffect(() => {
    const storageKey = getClusterScopedStorageKey(
      `-${resourceName}-searchQuery`
    )
    if (searchQuery) {
      sessionStorage.setItem(storageKey, searchQuery)
      return
    }

    sessionStorage.removeItem(storageKey)
  }, [resourceName, searchQuery])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery)
    }, 500)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [searchQuery])

  useEffect(() => {
    localStorage.setItem(
      getClusterScopedStorageKey(`-${resourceName}-columnVisibility`),
      JSON.stringify(columnVisibility)
    )
  }, [columnVisibility, resourceName])

  useEffect(() => {
    localStorage.setItem(
      getClusterScopedStorageKey(`-${resourceName}-pageSize`),
      pagination.pageSize.toString()
    )
  }, [pagination.pageSize, resourceName])

  useEffect(() => {
    localStorage.setItem(
      getClusterScopedStorageKey(`-${resourceName}-columnSizing`),
      JSON.stringify(columnSizing)
    )
  }, [columnSizing, resourceName])

  useEffect(() => {
    const storageKey = getClusterScopedStorageKey(
      `-${resourceName}-columnFilters`
    )
    if (columnFilters.length > 0) {
      sessionStorage.setItem(storageKey, JSON.stringify(columnFilters))
      return
    }

    sessionStorage.removeItem(storageKey)
  }, [columnFilters, resourceName])

  useEffect(() => {
    setPagination((prev) => ({ ...prev, pageIndex: 0 }))
  }, [columnFilters, searchQuery])

  const handleNamespaceChange = useCallback((value: string) => {
    // 持久化到 sessionStorage，实现标签页级隔离
    sessionStorage.setItem(
      getClusterScopedStorageKey('selectedNamespace'),
      value
    )
    // 同时更新 localStorage，作为新标签页的全局偏好
    localStorage.setItem(getClusterScopedStorageKey('selectedNamespace'), value)
    setNamespacePreference(value)
    setPagination((prev) => ({ ...prev, pageIndex: 0 }))
    setSearchQuery('')
  }, [])

  const handleUseSSEChange = useCallback((pressed: boolean) => {
    setUseSSE(pressed)
    setRefreshInterval((current) => {
      if (pressed) {
        return 0
      }
      if (current === 0) {
        return 5000
      }
      return current
    })
  }, [])

  const handleRefreshIntervalChange = useCallback((value: number) => {
    setRefreshInterval(value)
    if (value > 0) {
      setUseSSE(false)
    }
  }, [])

  return {
    sorting,
    setSorting,
    columnFilters,
    setColumnFilters,
    rowSelection,
    setRowSelection,
    deleteDialogOpen,
    setDeleteDialogOpen,
    searchQuery,
    setSearchQuery,
    debouncedSearchQuery,
    columnVisibility,
    setColumnVisibility,
    columnSizing,
    setColumnSizing,
    pagination,
    setPagination,
    refreshInterval,
    setRefreshInterval,
    selectedNamespace,
    effectiveNamespace,
    namespaceReady,
    useSSE,
    handleNamespaceChange,
    handleUseSSEChange,
    handleRefreshIntervalChange,
  }
}
