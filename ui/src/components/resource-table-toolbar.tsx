import React from 'react'
import { ColumnDef, Table } from '@tanstack/react-table'
import {
  ChevronDown,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  XCircle,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { ResourceType } from '@/types/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Toggle } from '@/components/ui/toggle'

import { RefreshButton } from './refresh-button'
import { NamespaceSelector } from './selector/namespace-selector'
import { TableColumnToggle } from './table-column-toggle'

export interface ResourceTableBatchAction<T> {
  id: string
  label: string
  icon?: React.ReactNode
  onSelect: (rows: T[]) => void
  /** 会被渲染但置灰（例如不适用于当前选择）。 */
  disabled?: boolean
  /** 完全不渲染（例如只对某些行出现的操作）。 */
  hidden?: boolean
}

interface ResourceTableToolbarProps<T> {
  table: Table<T>
  resourceName: string
  resourceType?: ResourceType
  clusterScope: boolean
  extraToolbars: React.ReactNode[]
  showCreateButton: boolean
  onCreateClick?: () => void
  searchQuery: string
  setSearchQuery: (value: string) => void
  selectedNamespace?: string
  handleNamespaceChange: (value: string) => void
  useSSE: boolean
  isConnected: boolean
  refreshInterval: number
  onUseSSEChange: (pressed: boolean) => void
  onRefreshIntervalChange: (value: number) => void
  /** 立刻刷新；不传就不显示刷新按钮。 */
  onRefresh?: () => void
  selectedRowCount: number
  onOpenDeleteDialog: () => void
  batchActions: ResourceTableBatchAction<T>[]
  /** 即使没有任何选中项，也保持批量按钮可见（禁用态）。 */
  alwaysShowBatchActions?: boolean
  /** 渲染内置的批量删除按钮。 */
  showBatchDelete?: boolean
}

export function ResourceTableToolbar<T>({
  table,
  resourceName,
  resourceType,
  clusterScope,
  extraToolbars,
  showCreateButton,
  onCreateClick,
  searchQuery,
  setSearchQuery,
  selectedNamespace,
  handleNamespaceChange,
  useSSE,
  isConnected,
  refreshInterval,
  onUseSSEChange,
  onRefreshIntervalChange,
  onRefresh,
  selectedRowCount,
  onOpenDeleteDialog,
  batchActions,
  alwaysShowBatchActions = false,
  showBatchDelete = true,
}: ResourceTableToolbarProps<T>) {
  const { t } = useTranslation()

  const filterableColumns = table.getAllColumns().filter((column) => {
    const columnDef = column.columnDef as ColumnDef<T> & {
      enableColumnFilter?: boolean
    }
    return columnDef.enableColumnFilter && column.getCanFilter()
  })

  const getSelectedRows = () =>
    table.getSelectedRowModel().rows.map((row) => row.original)
  // 调用方显式隐藏的操作（例如调用方没有权限）
  // 不得在溢出菜单里重新出现。
  const visibleBatchActions = batchActions.filter((action) => !action.hidden)
  const hasBatchActions = visibleBatchActions.length > 0 || showBatchDelete
  const showBatchActionsInline =
    alwaysShowBatchActions ||
    visibleBatchActions.length + (showBatchDelete ? 1 : 0) <= 2

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          {extraToolbars.map((toolbar, index) => (
            <React.Fragment key={index}>{toolbar}</React.Fragment>
          ))}
          {resourceType === 'pods' && (
            <Toggle
              pressed={useSSE}
              variant="outline"
              className="px-3 text-muted-foreground data-[state=on]:text-foreground"
              aria-label={t('resourceTable.watch')}
              onPressedChange={onUseSSEChange}
            >
              <span
                className={cn(
                  'bg-muted-foreground/25 size-2 rounded-full',
                  useSSE && isConnected && 'bg-emerald-500',
                  useSSE && !isConnected && 'bg-red-500'
                )}
              />
              <span>{t('resourceTable.watch')}</span>
            </Toggle>
          )}
          {onRefresh ? (
            <RefreshButton
              onClick={onRefresh}
              // 监听模式下不是「再拉一次」，而是重连后重新拉取。
              label={
                useSSE
                  ? t('resourceTable.refreshWatch', 'Reconnect and fetch')
                  : t('common.actions.refresh', 'Refresh')
              }
            />
          ) : null}
          <Select
            value={refreshInterval.toString()}
            onValueChange={(value) => onRefreshIntervalChange(Number(value))}
            disabled={useSSE}
          >
            <SelectTrigger className="w-full sm:w-[120px]">
              <div className="flex items-center gap-2">
                <RefreshCw className="h-4 w-4" />
                <SelectValue />
              </div>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">Off</SelectItem>
              <SelectItem value="1000">1s</SelectItem>
              <SelectItem value="5000">5s</SelectItem>
              <SelectItem value="10000">10s</SelectItem>
              <SelectItem value="30000">30s</SelectItem>
            </SelectContent>
          </Select>
          {!clusterScope && (
            <NamespaceSelector
              selectedNamespace={selectedNamespace}
              handleNamespaceChange={handleNamespaceChange}
              showAll={true}
              multiple={true}
            />
          )}
          {filterableColumns.map((column) => {
            const columnDef = column.columnDef as ColumnDef<T> & {
              enableColumnFilter?: boolean
            }
            const uniqueValues = column.getFacetedUniqueValues()
            const filterValue = column.getFilterValue() as string
            const optionValues = Array.from(uniqueValues.keys()).filter(Boolean)
            if (
              filterValue &&
              !optionValues.some((value) => String(value) === filterValue)
            ) {
              optionValues.push(filterValue)
            }

            return (
              <Select
                key={column.id}
                value={filterValue || ''}
                onValueChange={(value) =>
                  column.setFilterValue(value === 'all' ? '' : value)
                }
              >
                <SelectTrigger className="w-full sm:w-auto sm:min-w-[8.5rem] sm:max-w-[12rem]">
                  <SelectValue
                    placeholder={`Filter ${typeof columnDef.header === 'string' ? columnDef.header : 'Column'}`}
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    All{' '}
                    {typeof columnDef.header === 'string'
                      ? columnDef.header
                      : 'Values'}
                  </SelectItem>
                  {optionValues
                    .sort((a, b) => String(a).localeCompare(String(b)))
                    .map((value) => (
                      <SelectItem key={String(value)} value={String(value)}>
                        {String(value)} ({uniqueValues.get(value) || 0})
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            )
          })}
        </div>

        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:justify-end">
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <div className="relative min-w-0 flex-1 sm:w-[280px]">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder={`Search ${resourceName} or app=nginx...`}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-4"
              />
            </div>
            {searchQuery && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setSearchQuery('')}
                className="h-9 w-9"
                aria-label="Clear search"
              >
                <XCircle className="h-4 w-4" />
              </Button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            {(selectedRowCount > 0 || alwaysShowBatchActions) &&
              showBatchActionsInline && (
                <>
                  {batchActions
                    .filter((action) => !action.hidden)
                    .map((action) => (
                      <Button
                        key={action.id}
                        variant="outline"
                        disabled={selectedRowCount === 0 || action.disabled}
                        onClick={() => action.onSelect(getSelectedRows())}
                        className="gap-2 tabular-nums"
                      >
                        {action.icon}
                        {action.label}
                        {!alwaysShowBatchActions && ` (${selectedRowCount})`}
                      </Button>
                    ))}
                  {showBatchDelete && (
                    <Button
                      variant="destructive"
                      disabled={selectedRowCount === 0}
                      onClick={onOpenDeleteDialog}
                      className="gap-2 tabular-nums"
                    >
                      <Trash2 className="size-4" />
                      {alwaysShowBatchActions
                        ? t('common.actions.delete')
                        : t('resourceTable.deleteSelected', {
                            count: selectedRowCount,
                          })}
                    </Button>
                  )}
                  {selectedRowCount > 0 && (
                    <span className="text-sm text-muted-foreground">
                      {t('resourceTable.selectedCount', {
                        count: selectedRowCount,
                      })}
                    </span>
                  )}
                </>
              )}
            {selectedRowCount > 0 &&
              !showBatchActionsInline &&
              !alwaysShowBatchActions &&
              hasBatchActions && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" className="gap-2">
                      {t('resourceTable.bulkActions')}
                      <ChevronDown className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuLabel>
                      {t('resourceTable.selectedCount', {
                        count: selectedRowCount,
                      })}
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {visibleBatchActions.map((action) => (
                      <DropdownMenuItem
                        key={action.id}
                        onSelect={() => action.onSelect(getSelectedRows())}
                      >
                        {action.icon}
                        {action.label}
                      </DropdownMenuItem>
                    ))}
                    {visibleBatchActions.length > 0 && showBatchDelete && (
                      <DropdownMenuSeparator />
                    )}
                    {showBatchDelete && (
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={onOpenDeleteDialog}
                      >
                        <Trash2 className="size-4" />
                        {t('common.actions.delete')}
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            {showCreateButton && onCreateClick && (
              <Button onClick={onCreateClick} className="gap-1">
                <Plus className="h-4 w-4" />
                {t('common.actions.create', '创建')}
              </Button>
            )}

            <TableColumnToggle table={table} />
          </div>
        </div>
      </div>
    </div>
  )
}
