import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ColumnDef,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { Box, Database } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ResourceType } from '@/types/api'
import { deleteResource } from '@/lib/api'
import { getResourceMetadata } from '@/lib/resource-catalog'
import { useCanAnyNamespace } from '@/hooks/use-can'
import { useCluster } from '@/hooks/use-cluster'
import { useResourceTableData } from '@/hooks/use-resource-table-data'
import { useResourceTableState } from '@/hooks/use-resource-table-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

import { ErrorMessage } from './error-message'
import {
  ResourceTableToolbar,
  type ResourceTableBatchAction,
} from './resource-table-toolbar'
import { ResourceTableView } from './resource-table-view'

export type { ResourceTableBatchAction } from './resource-table-toolbar'

export interface ResourceTableProps<T> {
  resourceName: string
  resourceType?: ResourceType // Optional, used for fetching resources
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  columns: ColumnDef<T, any>[]
  clusterScope?: boolean // If true, don't show namespace selector
  initialNamespace?: string // Optional namespace preset (e.g. from the URL)
  onNamespaceChange?: (namespace: string) => void // Notified when the user changes the namespace filter
  searchQueryFilter?: (item: T, query: string) => boolean // Custom filter function
  showCreateButton?: boolean // If true, show create button
  onCreateClick?: () => void // Callback for create button click
  extraToolbars?: React.ReactNode[] // Additional toolbar components
  batchActions?: ResourceTableBatchAction<T>[]
  defaultHiddenColumns?: string[] // Columns to hide by default
  renderRowDetails?: (row: T) => React.ReactNode // Optional full-width details row per item
  alwaysShowBatchActions?: boolean // Keep batch buttons visible (disabled) without a selection
  showBatchDelete?: boolean // Render the built-in batch delete button
  onRowSelectionChange?: (rows: T[]) => void // Notified when the row selection changes
  /**
   * 用于权限校验的资源（默认取解析出的资源
   * 类型）。除非某个命名空间授予了相应 verb，否则创建与批量删除
   * 会被隐藏；传空字符串可完全跳过该控制。
   */
  permissionResource?: string
}

export function ResourceTable<T>(props: ResourceTableProps<T>) {
  const { currentCluster } = useCluster()
  return React.createElement(ResourceTableContent<T>, {
    ...props,
    key: currentCluster || '',
  })
}

function ResourceTableContent<T>({
  resourceName,
  resourceType,
  initialNamespace,
  onNamespaceChange,
  columns,
  clusterScope = false,
  searchQueryFilter,
  showCreateButton = false,
  onCreateClick,
  extraToolbars = [],
  batchActions = [],
  defaultHiddenColumns = [],
  renderRowDetails,
  alwaysShowBatchActions = false,
  showBatchDelete = true,
  onRowSelectionChange,
  permissionResource,
}: ResourceTableProps<T>) {
  const { t } = useTranslation()
  const {
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
  } = useResourceTableState({
    resourceName,
    clusterScope,
    defaultHiddenColumns,
    initialNamespace,
  })

  // 在内置处理器执行后通知父组件（例如同步 URL）。
  const handleNamespaceChangeWrapper = useCallback(
    (value: string) => {
      handleNamespaceChange(value)
      onNamespaceChange?.(value)
    },
    [handleNamespaceChange, onNamespaceChange]
  )

  // 当查询看起来像标签选择器时，把它转给后端 API，
  // 而不是走客户端名称过滤。
  const isLabelSelector = searchQuery.includes('=') || searchQuery.includes(':')
  const effectiveLabelSelector =
    debouncedSearchQuery.includes('=') || debouncedSearchQuery.includes(':')
      ? debouncedSearchQuery.replace(/:\s*/g, '=')
      : undefined
  const selectedNamespaces = useMemo(() => {
    if (!selectedNamespace || selectedNamespace === '_all') return []
    return selectedNamespace.split(',').filter(Boolean)
  }, [selectedNamespace])
  const namespaceDescription =
    selectedNamespace === '_all'
      ? t('resourceTable.allNamespaces')
      : selectedNamespaces.length > 1
        ? t('resourceTable.namespaceCount', {
            count: selectedNamespaces.length,
          })
        : selectedNamespace
          ? t('resourceTable.namespaceScoped', { name: selectedNamespace })
          : ''
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteProgress, setDeleteProgress] = useState({ done: 0, total: 0 })
  const {
    resourceType: resolvedResourceType,
    data,
    isLoading,
    isError,
    error,
    refetch,
    isConnected,
  } = useResourceTableData<T>({
    resourceName,
    resourceType,
    namespace: effectiveNamespace,
    useSSE,
    refreshInterval,
    labelSelector: effectiveLabelSelector,
  })
  // 创建按钮与批量删除不绑定单个命名空间，因此
  // 遵循"某处已授权"规则。Kite 没有其元数据的资源
  // （页面传入了展示名，例如 "Helm Releases"）不做处理。
  const canAnyNamespace = useCanAnyNamespace()
  const permissionTarget =
    permissionResource ??
    (getResourceMetadata(resolvedResourceType)
      ? resolvedResourceType
      : undefined)
  const canCreate =
    !permissionTarget || canAnyNamespace(permissionTarget, 'create')
  const canDelete =
    !permissionTarget || canAnyNamespace(permissionTarget, 'delete')
  const displayResourceName = (() => {
    const resource = getResourceMetadata(resolvedResourceType)
    if (!resource) {
      return resourceName
    }
    if (resource.titleKey) {
      return t(resource.titleKey, {
        defaultValue:
          resource.shortLabel || resource.pluralLabel || resourceName,
      })
    }
    return resource.shortLabel || resource.pluralLabel || resourceName
  })()

  // 在展示所有命名空间时加入命名空间列
  const enhancedColumns = useMemo(() => {
    const selectColumn: ColumnDef<T> = {
      id: 'select',
      header: ({ table }) => (
        <Checkbox
          checked={
            table.getIsAllPageRowsSelected() ||
            (table.getIsSomePageRowsSelected() && 'indeterminate')
          }
          onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
          aria-label={t('resourceTable.selectAllRows')}
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          checked={row.getIsSelected()}
          onCheckedChange={(value) => row.toggleSelected(!!value)}
          aria-label={t('resourceTable.selectRow')}
        />
      ),
      enableSorting: false,
      enableHiding: false,
    }

    const baseColumns = [selectColumn, ...columns]

    // 只有在非集群范围、展示所有命名空间、
    // 且传入的列里还没有命名空间列时，才加入命名空间列
    if (
      !clusterScope &&
      (selectedNamespace === '_all' || selectedNamespaces.length > 1)
    ) {
      // 检查传入的列里是否已有命名空间列
      const hasNamespaceColumn = columns.some((col) => {
        // 检查该列是否访问命名空间数据
        if ('accessorKey' in col && col.accessorKey === 'metadata.namespace') {
          return true
        }
        if ('accessorFn' in col && col.id === 'namespace') {
          return true
        }
        return false
      })

      // 只有在尚不存在时才加入命名空间列
      if (!hasNamespaceColumn) {
        const namespaceColumn = {
          id: 'namespace',
          header: t('resourceTable.namespace'),
          accessorFn: (row: T) => {
            // 尝试从 metadata.namespace 取命名空间
            const metadata = (row as { metadata?: { namespace?: string } })
              ?.metadata
            return metadata?.namespace || '-'
          },
          cell: ({ getValue }: { getValue: () => string }) => (
            <Badge variant="outline" className="ml-2 ">
              {getValue()}
            </Badge>
          ),
        }

        // 把命名空间列插到 select 与第一列（通常是名称）之后
        const columnsWithNamespace = [...baseColumns]
        columnsWithNamespace.splice(2, 0, namespaceColumn)
        return columnsWithNamespace
      }
    }
    return baseColumns
  }, [columns, clusterScope, selectedNamespace, selectedNamespaces.length, t])

  const namespaceFilteredData = useMemo(() => {
    if (clusterScope || selectedNamespaces.length <= 1) {
      return data
    }

    return (data as T[] | undefined)?.filter((item) => {
      const namespace = (item as { metadata?: { namespace?: string } })
        ?.metadata?.namespace
      return namespace ? selectedNamespaces.includes(namespace) : false
    })
  }, [clusterScope, data, selectedNamespaces])

  const memoizedData = useMemo(
    () => (namespaceFilteredData || []) as T[],
    [namespaceFilteredData]
  )

  useEffect(() => {
    if (!useSSE && error && !effectiveLabelSelector) {
      setRefreshInterval(0)
    }
  }, [useSSE, error, effectiveLabelSelector, setRefreshInterval])

  // 使用 TanStack Table 创建表格实例
  const table = useReactTable<T>({
    data: memoizedData,
    columns: enhancedColumns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onRowSelectionChange: setRowSelection,
    onColumnVisibilityChange: setColumnVisibility,
    getRowId: (row) => {
      const metadata = (
        row as {
          metadata?: { name?: string; namespace?: string; uid?: string }
        }
      )?.metadata
      if (!metadata?.name) {
        return `row-${Math.random()}`
      }
      return (
        metadata.uid ||
        (metadata.namespace
          ? `${metadata.namespace}/${metadata.name}`
          : metadata.name)
      )
    },
    state: {
      sorting,
      columnFilters,
      globalFilter: isLabelSelector ? '' : searchQuery,
      pagination,
      rowSelection,
      columnVisibility,
    },
    onPaginationChange: setPagination,
    // 让 TanStack Table 依据过滤后的数据自动处理分页
    manualPagination: false,
    // 提升过滤性能与一致性
    globalFilterFn: (row, _columnId, value) => {
      if (searchQueryFilter) {
        return searchQueryFilter(row.original as T, String(value).toLowerCase())
      }
      const searchValue = String(value).toLowerCase()

      // 在所有可见列中搜索
      return row.getVisibleCells().some((cell) => {
        const cellValue = String(cell.getValue() || '').toLowerCase()
        return cellValue.includes(searchValue)
      })
    },
    // 加上这个以避免不必要的分页重置
    autoResetPageIndex: false,
    enableRowSelection: true,
  })

  // 把当前选中项暴露给父组件（用于驱动工具栏状态）。
  useEffect(() => {
    onRowSelectionChange?.(
      table.getSelectedRowModel().rows.map((row) => row.original)
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowSelection])

  // 处理批量删除——必须放在 table 定义之后
  const handleBatchDelete = useCallback(async () => {
    setIsDeleting(true)
    const selectedRows = table
      .getSelectedRowModel()
      .rows.map((row) => row.original)

    const total = selectedRows.length
    setDeleteProgress({ done: 0, total })

    const deletePromises = selectedRows.map((row) => {
      const metadata = (
        row as { metadata?: { name?: string; namespace?: string } }
      )?.metadata
      const name = metadata?.name
      const namespace = clusterScope ? undefined : metadata?.namespace

      if (!name) {
        setDeleteProgress((prev) => ({ ...prev, done: prev.done + 1 }))
        return Promise.resolve()
      }

      return deleteResource(resolvedResourceType, name, namespace)
        .then(() => {
          setDeleteProgress((prev) => ({ ...prev, done: prev.done + 1 }))
          toast.success(t('resourceTable.deleteSuccess', { name }))
        })
        .catch((error) => {
          setDeleteProgress((prev) => ({ ...prev, done: prev.done + 1 }))
          console.error(`Failed to delete ${name}:`, error)

          throw error
        })
    })

    try {
      await Promise.allSettled(deletePromises)
      // 重置选择并关闭对话框
      setRowSelection({})
      setDeleteDialogOpen(false)
      // 重新拉取数据
      if (!useSSE) {
        refetch()
      }
    } finally {
      setIsDeleting(false)
    }
  }, [
    table,
    clusterScope,
    resolvedResourceType,
    t,
    useSSE,
    refetch,
    setRowSelection,
    setDeleteDialogOpen,
  ])
  // 计算总行数与过滤后的行数
  const totalRowCount = useMemo(
    () => (namespaceFilteredData as T[] | undefined)?.length || 0,
    [namespaceFilteredData]
  )
  const filteredRowCount = useMemo(() => {
    if (!namespaceFilteredData || (namespaceFilteredData as T[]).length === 0)
      return 0
    // 过滤条件变化时强制重新计算
    void searchQuery // Ensure dependency is used
    void columnFilters // Ensure dependency is used
    return table.getFilteredRowModel().rows.length
  }, [table, namespaceFilteredData, searchQuery, columnFilters])

  // 检查是否存在生效中的过滤条件
  const hasActiveFilters = useMemo(() => {
    return Boolean(searchQuery) || columnFilters.length > 0
  }, [searchQuery, columnFilters])

  // 依据条件渲染空状态
  const renderEmptyState = () => {
    // 只有在尚无数据时才显示加载状态
    if (
      isLoading &&
      (!namespaceFilteredData || (namespaceFilteredData as T[]).length === 0)
    ) {
      return (
        <div className="h-72 flex flex-col items-center justify-center">
          <div className="mb-4 bg-muted/30 p-6 rounded-full">
            <Database className="h-12 w-12 text-muted-foreground animate-pulse" />
          </div>
          <h3 className="text-lg font-medium mb-1">
            {t('resourceTable.loadingResource', {
              resource: displayResourceName,
            })}
          </h3>
          <p className="text-muted-foreground">
            {!clusterScope && namespaceDescription
              ? t('resourceTable.retrievingDataFrom', {
                  scope: namespaceDescription,
                })
              : t('resourceTable.retrievingData')}
          </p>
        </div>
      )
    }

    if (isError) {
      return (
        <ErrorMessage
          resourceName={displayResourceName}
          error={error}
          refetch={refetch}
        />
      )
    }

    if (namespaceFilteredData && (namespaceFilteredData as T[]).length === 0) {
      return (
        <div className="h-72 flex flex-col items-center justify-center">
          <div className="mb-4 bg-muted/30 p-6 rounded-full">
            <Box className="h-12 w-12 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-medium mb-1">
            {t('resourceTable.emptyTitle', { resource: displayResourceName })}
          </h3>
          <p className="text-muted-foreground">
            {searchQuery
              ? isLabelSelector
                ? t('resourceTable.emptyLabelSelector', {
                    resource: displayResourceName,
                    query: searchQuery,
                  })
                : t('resourceTable.emptySearch', { query: searchQuery })
              : clusterScope
                ? t('resourceTable.emptyCluster', {
                    resource: displayResourceName,
                  })
                : t('resourceTable.emptyNamespace', {
                    resource: displayResourceName,
                    namespace: namespaceDescription,
                  })}
          </p>
          {searchQuery && (
            <Button
              variant="outline"
              className="mt-4"
              onClick={() => setSearchQuery('')}
            >
              {t('resourceTable.clearSearch')}
            </Button>
          )}
        </div>
      )
    }

    return null
  }

  const emptyState = renderEmptyState()

  return (
    <div className="flex flex-col gap-3">
      <ResourceTableToolbar
        table={table}
        resourceName={displayResourceName}
        resourceType={resolvedResourceType}
        clusterScope={clusterScope}
        extraToolbars={extraToolbars}
        showCreateButton={showCreateButton && canCreate}
        onCreateClick={onCreateClick}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        selectedNamespace={selectedNamespace}
        handleNamespaceChange={handleNamespaceChangeWrapper}
        useSSE={useSSE}
        isConnected={isConnected}
        refreshInterval={refreshInterval}
        onUseSSEChange={handleUseSSEChange}
        onRefreshIntervalChange={handleRefreshIntervalChange}
        onRefresh={refetch}
        selectedRowCount={table.getSelectedRowModel().rows.length}
        onOpenDeleteDialog={() => setDeleteDialogOpen(true)}
        batchActions={batchActions}
        alwaysShowBatchActions={alwaysShowBatchActions}
        showBatchDelete={showBatchDelete && canDelete}
      />

      <ResourceTableView
        table={table}
        columnCount={enhancedColumns.length}
        isLoading={isLoading}
        data={namespaceFilteredData as T[] | undefined}
        fitViewportHeight={true}
        emptyState={emptyState}
        hasActiveFilters={hasActiveFilters}
        filteredRowCount={filteredRowCount}
        totalRowCount={totalRowCount}
        searchQuery={searchQuery}
        pagination={pagination}
        setPagination={setPagination}
        renderRowDetails={renderRowDetails}
      />

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('resourceTable.confirmDeletion')}</DialogTitle>
            <DialogDescription>
              {t('resourceTable.confirmDeletionMessage', {
                count: table.getSelectedRowModel().rows.length,
                resourceName: displayResourceName,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteDialogOpen(false)}
              disabled={isDeleting}
            >
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleBatchDelete}
              disabled={isDeleting}
            >
              {isDeleting
                ? t('resourceTable.deletingProgress', {
                    done: deleteProgress.done,
                    total: deleteProgress.total,
                  })
                : t('common.actions.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
