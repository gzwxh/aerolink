import { useEffect, useMemo, useState } from 'react'
import { IconFilter, IconKey } from '@tabler/icons-react'
import {
  ColumnDef,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  PaginationState,
  SortingState,
  useReactTable,
} from '@tanstack/react-table'
import { useTranslation } from 'react-i18next'

import {
  allPrivileges,
  SCOPE_LABEL_KEYS,
  type Privilege,
  type TranslateFn,
} from '@/lib/rbac-privileges'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { ResourceTableView } from '@/components/resource-table-view'
import {
  useTableColumnOrder,
  useTableColumnSizing,
} from '@/hooks/use-table-column-preferences'

/**
 * 权限一览（只读）：把控制台支持的「资源 + 操作」逐条列成权限，便于对照角色编辑器里的
 * 勾选项。本页只提供查看与搜索，没有任何写入口。
 */
export function RBACPermissionCatalog() {
  const { t } = useTranslation()

  const [search, setSearch] = useState('')
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 20,
  })
  const [sorting, setSorting] = useState<SortingState>([])

  const rows = useMemo<Privilege[]>(() => {
    const translate: TranslateFn = (key, defaultValue) =>
      t(key, { defaultValue })
    return allPrivileges(translate)
  }, [t])

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return rows
    return rows.filter((row) =>
      [
        row.id,
        row.name,
        row.permission,
        t(SCOPE_LABEL_KEYS[row.scope], { defaultValue: row.scope }),
      ]
        .join('\n')
        .toLowerCase()
        .includes(query)
    )
  }, [rows, search, t])

  useEffect(() => {
    setPagination((prev) => ({ ...prev, pageIndex: 0 }))
  }, [search, sorting])

  const columns = useMemo<ColumnDef<Privilege>[]>(
    () => [
      {
        accessorKey: 'id',
        header: t('rbac.privilegeId', 'Privilege ID'),
        cell: ({ row }) => (
          <span className="block min-w-0 truncate font-mono text-sm">
            {row.original.id}
          </span>
        ),
      },
      {
        accessorKey: 'scope',
        header: t('rbac.privilegeType', 'Type'),
        cell: ({ row }) => (
          <Badge variant="outline" className="text-xs">
            {t(SCOPE_LABEL_KEYS[row.original.scope], {
              defaultValue: row.original.scope,
            })}
          </Badge>
        ),
      },
      {
        accessorKey: 'name',
        header: t('rbac.privilegeName', 'Name'),
        cell: ({ row }) => <span className="text-sm">{row.original.name}</span>,
      },
      {
        accessorKey: 'permission',
        header: t('rbac.privilegePermission', 'Permission'),
        cell: ({ row }) => (
          <span className="font-mono text-sm text-muted-foreground">
            {row.original.permission}
          </span>
        ),
      },
    ],
    [t]
  )

  // 列宽 / 列顺序偏好：与资源列表同一套交互（拖表头右缘调宽、拖表头换位）。
  const [columnSizing, setColumnSizing] = useTableColumnSizing(
    'aerolink-rbac-privileges-columnSizing'
  )
  const [columnOrder, setColumnOrder] = useTableColumnOrder(
    'aerolink-rbac-privileges-columnOrder'
  )

  const table = useReactTable<Privilege>({
    data: filtered,
    columns,
    state: { pagination, sorting, columnSizing, columnOrder },
    onPaginationChange: setPagination,
    onSortingChange: setSorting,
    onColumnSizingChange: setColumnSizing,
    onColumnOrderChange: setColumnOrder,
    // 列宽拖拽：拖动表头右缘实时调宽（min/max 来自 defaultColumn）。
    enableColumnResizing: true,
    columnResizeMode: 'onChange',
    defaultColumn: { size: 160, minSize: 80, maxSize: 600 },
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  })

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2">
              <IconKey className="h-5 w-5" />
              {t('rbac.privilegesTitle', 'Privileges')}
            </CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {t(
                'rbac.privilegesSubtitle',
                '权限按来源加前缀：Kubernetes 资源用 k8s，控制台自身（设置族）用 aerolink，格式为 <来源>:<资源>:<操作>。本页仅支持查看与搜索。'
              )}
            </p>
          </div>
          <div className="relative">
            <IconFilter className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder={t(
                'rbac.privilegeFilterPlaceholder',
                '过滤（例如 pods）'
              )}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-64 pl-9"
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <ResourceTableView
          table={table}
          columnCount={columns.length}
          isLoading={false}
          data={filtered}
          enableReorder
          allPageSize={filtered.length}
          emptyState={null}
          hasActiveFilters={Boolean(search)}
          filteredRowCount={table.getFilteredRowModel().rows.length}
          totalRowCount={rows.length}
          searchQuery={search}
          pagination={pagination}
          setPagination={setPagination}
          maxBodyHeightClassName="max-h-[600px]"
        />
      </CardContent>
    </Card>
  )
}

export default RBACPermissionCatalog
