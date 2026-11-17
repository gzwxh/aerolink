import React from 'react'
import { ColumnDef, Table } from '@tanstack/react-table'
import {
  ChevronDown,
  Download,
  Plus,
  Search,
  Trash2,
  XCircle,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { ResourceType } from '@/types/api'
import type { TableExportFormat } from '@/lib/table-export'
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
import { RefreshIntervalSelect } from './refresh-interval-select'
import { NamespaceSelector } from './selector/namespace-selector'
import { TableColumnToggle } from './table-column-toggle'

/** 导出范围：当前勾选的行，或当前筛选后的全部行。 */
export type ResourceTableExportScope = 'selected' | 'all'

const EXPORT_FORMAT_LABEL_KEYS: Record<TableExportFormat, string> = {
  csv: 'resourceTable.exportFormats.csv',
  json: 'resourceTable.exportFormats.json',
  yaml: 'resourceTable.exportFormats.yaml',
}

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
  /** 下载数据；不传就不显示按钮。 */
  onExport?: (
    scope: ResourceTableExportScope,
    format: TableExportFormat
  ) => void
  /** 菜单里提供的格式（顺序即展示顺序）。 */
  exportFormats: TableExportFormat[]
  /** 当前筛选后的行数（「全部」的范围），为 0 时置灰。 */
  exportableRowCount?: number
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
  onExport,
  exportFormats,
  exportableRowCount = 0,
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
  // 不得在批量按钮里重新出现。
  const visibleBatchActions = batchActions.filter((action) => !action.hidden)
  const hasBatchActions = visibleBatchActions.length > 0 || showBatchDelete
  const selectedRangeLabel = t('resourceTable.downloadSelected', {
    count: selectedRowCount,
  })
  const allRangeLabel = t('resourceTable.downloadAll', {
    count: exportableRowCount,
  })

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
                  useSSE && isConnected && 'bg-success',
                  useSSE && !isConnected && 'bg-destructive'
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
          <RefreshIntervalSelect
            value={refreshInterval}
            onChange={onRefreshIntervalChange}
            disabled={useSSE}
          />
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
              hasBatchActions && (
                <>
                  {visibleBatchActions.map((action) => (
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
            {showCreateButton && onCreateClick && (
              <Button onClick={onCreateClick} className="gap-1">
                <Plus className="h-4 w-4" />
                {t('common.actions.create', '创建')}
              </Button>
            )}

            {onExport && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    disabled={exportableRowCount === 0}
                    className="gap-2"
                  >
                    <Download className="size-4" />
                    {t('resourceTable.download')}
                    <ChevronDown className="size-3.5 opacity-60" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {/* 两个范围各一组，菜单项文字只有格式名；aria-label 补上
                      范围，避免读屏时出现两组同名项。 */}
                  <DropdownMenuLabel>{selectedRangeLabel}</DropdownMenuLabel>
                  {exportFormats.map((format) => (
                    <DropdownMenuItem
                      key={`selected-${format}`}
                      disabled={selectedRowCount === 0}
                      aria-label={`${selectedRangeLabel} · ${t(EXPORT_FORMAT_LABEL_KEYS[format])}`}
                      onSelect={() => onExport('selected', format)}
                    >
                      {t(EXPORT_FORMAT_LABEL_KEYS[format])}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>{allRangeLabel}</DropdownMenuLabel>
                  {exportFormats.map((format) => (
                    <DropdownMenuItem
                      key={`all-${format}`}
                      disabled={exportableRowCount === 0}
                      aria-label={`${allRangeLabel} · ${t(EXPORT_FORMAT_LABEL_KEYS[format])}`}
                      onSelect={() => onExport('all', format)}
                    >
                      {t(EXPORT_FORMAT_LABEL_KEYS[format])}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            <TableColumnToggle table={table} />
          </div>
        </div>
      </div>
    </div>
  )
}
