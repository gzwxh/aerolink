import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ColumnDef,
  getCoreRowModel,
  getExpandedRowModel,
  getFacetedRowModel,
  type SortingState,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getGroupedRowModel,
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
  /** 预设搜索词（例如从工作负载页跳来时只显示某一个对象）。 */
  initialSearch?: string
  /** 初始排序（例如命名空间页默认按「项目」列排序展示）。 */
  initialSorting?: SortingState
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
   * 可选的行分组：按某一列的值把行聚成组，每组前渲染一条全宽的组标题行
   * （例如 /namespaces 按权限绑定名分组）。组行本身不参与勾选，全选
   * 只作用于资源行；分组列可以处于隐藏状态（仅作分组依据）。
   */
  grouping?: {
    columnId: string
    renderGroupHeader: (value: string, rowCount: number) => React.ReactNode
  }
  /**
   * 用于权限校验的资源（默认取解析出的资源
   * 类型）。除非某个命名空间授予了相应 verb，否则创建与批量删除
   * 会被隐藏；传空字符串可完全跳过该控制。
   */
  permissionResource?: string
  /**
   * 外部数据模式：传入后组件不再自行拉取，改用调用方提供的数据
   * （例如详情页里按 labelSelector 监听的 Pod 列表）。监听开关与
   * 命名空间选择器由调用方决定，组件不再渲染。
   */
  data?: T[]
  /** 外部数据模式的加载态。 */
  isLoading?: boolean
  /** 外部数据模式的刷新回调（透传给工具栏的刷新按钮）。 */
  refetch?: () => void
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
  initialSearch,
  initialSorting,
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
  grouping,
  permissionResource,
  data: externalData,
  isLoading: externalIsLoading,
  refetch: externalRefetch,
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
  } = useResourceTableState({
    resourceName,
    clusterScope,
    defaultHiddenColumns,
    initialNamespace,
    initialSearch,
    initialSorting,
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
  const external = externalData !== undefined
  const {
    resourceType: fetchedResourceType,
    data: fetchedData,
    isLoading: fetchedIsLoading,
    isError: fetchedIsError,
    error: fetchedError,
    refetch: fetchedRefetch,
    isConnected: fetchedIsConnected,
  } = useResourceTableData<T>({
    resourceName,
    resourceType,
    namespace: effectiveNamespace,
    useSSE,
    refreshInterval,
    labelSelector: effectiveLabelSelector,
    disabled: external,
  })
  const resolvedResourceType = (
    external ? resourceType ?? resourceName.toLowerCase() : fetchedResourceType
  ) as ResourceType
  const data = external ? externalData : fetchedData
  const isLoading = external ? !!externalIsLoading : fetchedIsLoading
  const isError = external ? false : fetchedIsError
  const error = external ? null : fetchedError
  const refetch = external ? externalRefetch : fetchedRefetch
  const isConnected = external ? false : fetchedIsConnected
  // 创建按钮与批量删除不绑定单个命名空间，因此
  // 遵循"某处已授权"规则。AeroLink 没有其元数据的资源
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

  // 分组列 id 的稳定引用。state.grouping 必须引用稳定：TanStack 的分组
  // row model 以它为缓存依赖，若每次渲染都是新数组，模型就会重算，而
  // 重算会触发 autoResetExpanded → onStateChange → setState → 再渲染，
  // 形成每秒近千次的渲染风暴（页面整体卡死）。
  const groupingColumnId = grouping?.columnId
  const groupingState = useMemo(
    () => (groupingColumnId ? [groupingColumnId] : undefined),
    [groupingColumnId]
  )

  // 在展示所有命名空间时加入命名空间列
  const enhancedColumns = useMemo(() => {
    const selectColumn: ColumnDef<T> = {
      id: 'select',
      header: ({ table }) => {
        // 分组模式下页面里混着组标题行：全选只作用于资源行（叶子行）。
        // 否则会把组行也选中——组行的 original 是第一个成员行，批量操作
        // 会重复计数/删除。
        if (grouping) {
          const leafRows = table
            .getRowModel()
            .rows.flatMap((row) => (row.getIsGrouped() ? row.subRows : [row]))
          const allSelected =
            leafRows.length > 0 &&
            leafRows.every((leaf) => leaf.getIsSelected())
          const someSelected = leafRows.some((leaf) => leaf.getIsSelected())
          return (
            <Checkbox
              checked={allSelected || (someSelected && 'indeterminate')}
              onCheckedChange={(value) => {
                const next = { ...table.getState().rowSelection }
                leafRows.forEach((leaf) => {
                  if (value) {
                    next[leaf.id] = true
                  } else {
                    delete next[leaf.id]
                  }
                })
                table.setRowSelection(next)
              }}
              aria-label={t('resourceTable.selectAllRows')}
            />
          )
        }
        return (
          <Checkbox
            checked={
              table.getIsAllPageRowsSelected() ||
              (table.getIsSomePageRowsSelected() && 'indeterminate')
            }
            onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
            aria-label={t('resourceTable.selectAllRows')}
          />
        )
      },
      cell: ({ row }) =>
        grouping && row.getIsGrouped() ? null : (
          <Checkbox
            checked={row.getIsSelected()}
            onCheckedChange={(value) => row.toggleSelected(!!value)}
            aria-label={t('resourceTable.selectRow')}
            // 参照资源管理器：默认隐藏，悬停所在行或已选中时显示
            className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 data-[state=checked]:opacity-100"
          />
        ),
      enableSorting: false,
      enableHiding: false,
      // 只有一个复选框（16px + 单元格左 padding 8px），固定布局下贴紧
      // 第一数据列（参照资源管理器：复选框紧跟名称），不占多余列宽。
      size: 26,
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
            // 命名空间名可能比列宽长：截断 + 悬浮看全名，避免压到相邻列。
            <Badge
              variant="outline"
              className="ml-2 max-w-full truncate"
              title={getValue()}
            >
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
  }, [columns, clusterScope, selectedNamespace, selectedNamespaces.length, grouping, t])

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
    () => (namespaceFilteredData ? [...namespaceFilteredData] : []) as T[],
    // 分组列的 accessor 会闭包捕获异步加载的数据（如 /namespaces 的权限绑定
    // 映射）。这类数据到位时只会让 columns 引用变化、data 引用不变，TanStack
    // 的分组 row model 于是不会重算，分组停留在旧值（全「未绑定」）。把
    // columns 纳入依赖并浅拷贝一层，让 data 引用随 columns 一起变化，从而
    // 触发分组重新计算。
    [namespaceFilteredData, columns]
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
    // 固定列宽（配合表格的 table-fixed）：内容长短、排序都不该让列宽跳动。
    // 160px 是普通文本列的基本宽度，宽列（名称、污点/标签等）在列定义里单独给 size。
    defaultColumn: { size: 160, minSize: 80, maxSize: 600 },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    // expanded 是受控的常量 true；关掉自动重置，避免分组模型重算时
    // 反复触发 onStateChange 形成渲染风暴（见上面 groupingState 的说明）。
    autoResetExpanded: false,
    // 分组模式：行按 groupingState 聚组，组全部展开，分页按组计
    ...(groupingState
      ? {
          getGroupedRowModel: getGroupedRowModel(),
          getExpandedRowModel: getExpandedRowModel(),
        }
      : {}),
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onRowSelectionChange: setRowSelection,
    onColumnVisibilityChange: setColumnVisibility,
    // 列宽拖拽：拖动表头右缘实时调宽，持久化见 use-resource-table-state。
    // minSize/maxSize 来自 defaultColumn（80~600px），超出自动截停。
    enableColumnResizing: true,
    columnResizeMode: 'onChange',
    onColumnSizingChange: setColumnSizing,
    // 列顺序拖拽：拖动表头换位（勾选列/操作列固定在两端），持久化同上。
    onColumnOrderChange: setColumnOrder,
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
      columnSizing,
      columnOrder,
      ...(groupingState
        ? { grouping: groupingState, expanded: true as const }
        : {}),
      // v8 会把分组列强制排到列首，勾选列会被挤到第二位。把勾选列钉在
      // 左侧（state.columnPinning），表头与所有行（含组标题行）的第一个
      // 单元格都是复选框。
      ...(groupingState ? { columnPinning: { left: ['select'] } } : {}),
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
      // 集群作用域对象的 metadata.namespace 本来就是 undefined；
      // 名字空间对象带上自己的命名空间，外部数据模式的嵌入表格
      // （clusterScope=true）也能删对目标。
      const namespace = metadata?.namespace

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
        refetch?.()
      }
    } finally {
      setIsDeleting(false)
    }
  }, [
    table,
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
          // 外部数据模式下 isError 恒为 false，这里不会走到 undefined。
          refetch={refetch ?? (() => {})}
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
        // 外部数据模式的监听由调用方负责，隐藏「监听」开关
        //（resourceType 是它唯一的显示条件）。
        resourceType={external ? undefined : resolvedResourceType}
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
        enableReorder
        emptyState={emptyState}
        hasActiveFilters={hasActiveFilters}
        filteredRowCount={filteredRowCount}
        totalRowCount={totalRowCount}
        searchQuery={searchQuery}
        pagination={pagination}
        setPagination={setPagination}
        grouping={grouping}
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
