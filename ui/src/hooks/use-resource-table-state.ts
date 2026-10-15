import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ColumnFiltersState,
  ColumnOrderState,
  ColumnSizingState,
  PaginationState,
  RowSelectionState,
  SortingState,
} from '@tanstack/react-table'

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
  // 列顺序偏好：存可见列 id 的排列；陈旧的 id 会被 TanStack 忽略、
  // 缺失的列按默认顺序追加，无需清理。
  const [columnOrder, setColumnOrder] = useState<ColumnOrderState>(() => {
    const saved = readStoredJSON<string[] | null>(
      localStorage,
      getClusterScopedStorageKey(`-${resourceName}-columnOrder`),
      null
    )
    if (!Array.isArray(saved)) {
      return []
    }
    return saved.filter((id): id is string => typeof id === 'string')
  })
  const [refreshInterval, setRefreshInterval] = useState(5000)
  const [selectedNamespace, setSelectedNamespace] = useState<
    string | undefined
  >(() => {
    if (initialNamespace && !clusterScope) {
      return initialNamespace
    }
    // 优先使用按标签页隔离的 sessionStorage，以隔离各标签页的命名空间选择
    const tabNamespace = sessionStorage.getItem(
      getClusterScopedStorageKey('selectedNamespace')
    )
    if (tabNamespace) {
      return clusterScope ? undefined : tabNamespace
    }
    // 回退到 localStorage 作为全局偏好（新标签页继承上次选择）
    const globalNamespace = localStorage.getItem(
      getClusterScopedStorageKey('selectedNamespace')
    )
    return clusterScope ? undefined : globalNamespace || 'default'
  })
  const [useSSE, setUseSSE] = useState(false)

  const effectiveNamespace = clusterScope
    ? undefined
    : selectedNamespace?.includes(',')
      ? '_all'
      : selectedNamespace

  useEffect(() => {
    if (clusterScope || selectedNamespace !== undefined) {
      return
    }

    const tabNamespace = sessionStorage.getItem(
      getClusterScopedStorageKey('selectedNamespace')
    )
    const storedNamespace =
      tabNamespace ||
      localStorage.getItem(getClusterScopedStorageKey('selectedNamespace'))
    setSelectedNamespace(storedNamespace || 'default')
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
    const storageKey = getClusterScopedStorageKey(
      `-${resourceName}-columnOrder`
    )
    if (columnOrder.length === 0) {
      localStorage.removeItem(storageKey)
      return
    }
    localStorage.setItem(storageKey, JSON.stringify(columnOrder))
  }, [columnOrder, resourceName])

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
    setSelectedNamespace(value)
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
    columnOrder,
    setColumnOrder,
    pagination,
    setPagination,
    refreshInterval,
    setRefreshInterval,
    selectedNamespace,
    effectiveNamespace,
    useSSE,
    handleNamespaceChange,
    handleUseSSEChange,
    handleRefreshIntervalChange,
  }
}
