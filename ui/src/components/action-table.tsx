import { useMemo } from 'react'
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'

import { ColumnResizeHandle } from './column-resize-handle'
import { Button } from './ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './ui/table'

interface ActionTableProps<T> {
  data: T[]
  columns: ColumnDef<T>[]
  actions: Action<T>[]
}

/** 操作列固定像素宽：按 size 占比分摊的话，宽屏下这列会被等比放大。 */
const ACTIONS_COLUMN_WIDTH = 56
/** 第一数据列（名称）没写 size 时的默认宽度，与 resource-table.tsx 的取值一致。 */
const FIRST_COLUMN_DEFAULT_SIZE = 240
const DEFAULT_COLUMN_SIZE = 160
const MIN_COLUMN_SIZE = 80
const MAX_COLUMN_SIZE = 600

export interface Action<T> {
  label: string | React.ReactNode
  dynamicLabel?: (item: T) => string | React.ReactNode
  /** 展示在标签旁的简短说明，例如某个操作为何被禁用。 */
  hint?: (item: T) => string | undefined
  onClick: (item: T) => void
  shouldDisable?: (item: T) => boolean
}

export function ActionTable<T>({
  data,
  columns,
  actions,
}: ActionTableProps<T>) {
  const { t } = useTranslation()
  const hasActions = actions.length > 0
  const tableColumns = useMemo(() => {
    // 第一列通常是名称：没写 size 时给宽一点，免得长名称一上来就折成好几行。
    const sizedColumns = columns.map((column, index) =>
      index === 0 && column.size === undefined
        ? { ...column, size: FIRST_COLUMN_DEFAULT_SIZE }
        : column
    )
    if (hasActions) {
      const actionColumn: ColumnDef<T> = {
        id: 'actions',
        header: t('common.fields.actions'),
        size: ACTIONS_COLUMN_WIDTH,
        // 操作列宽度固定，不给拖拽手柄。
        enableResizing: false,
        cell: ({ row }) => (
          <div className="text-right">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t('common.fields.actions', 'Actions')}
                >
                  •••
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {actions.map((action, index) => (
                  <DropdownMenuItem
                    key={index}
                    disabled={action.shouldDisable?.(row.original)}
                    onClick={() => action.onClick(row.original)}
                    className="gap-2"
                  >
                    {action.dynamicLabel
                      ? action.dynamicLabel(row.original)
                      : action.label}
                    {action.hint?.(row.original) && (
                      <span className="text-xs font-normal text-muted-foreground">
                        {action.hint(row.original)}
                      </span>
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
      }
      return [...sizedColumns, actionColumn]
    }
    return sizedColumns
  }, [actions, columns, hasActions, t])

  const table = useReactTable<T>({
    data,
    columns: tableColumns,
    defaultColumn: {
      size: DEFAULT_COLUMN_SIZE,
      minSize: MIN_COLUMN_SIZE,
      maxSize: MAX_COLUMN_SIZE,
    },
    getCoreRowModel: getCoreRowModel(),
    enableColumnResizing: true,
    columnResizeMode: 'onChange',
  })

  // 列宽按各列 size 的占比分摊到容器宽度（表宽恒 100%，不产生横向滚动）。
  // 与 ResourceTableView 同一套模型：需要固定的列（这里是操作列）按像素
  // 参与，其余列从「容器宽 - 固定宽」里按原占比分摊。
  const totalColumnSize = table.getTotalSize() || 1
  const fixedActionsWidth = hasActions ? ACTIONS_COLUMN_WIDTH : 0
  const restColumnSize = totalColumnSize - fixedActionsWidth || 1
  const restColumnCount = Math.max(
    table.getVisibleLeafColumns().length - (hasActions ? 1 : 0),
    1
  )
  // 第一数据列（名称列）：操作列永远排在最后，所以第一列就是第一个非操作列。
  const firstDataColumnId = table
    .getVisibleLeafColumns()
    .find((column) => column.id !== 'actions')?.id

  return (
    <div className="rounded-md border">
      <Table className="table-fixed">
        <TableHeader className="bg-muted sticky top-0 z-10">
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead
                  key={header.id}
                  className={cn(
                    // 命名 group/th：列宽拖拽手柄只在悬停本表头时显形。
                    'group/th relative',
                    header.column.id === 'actions' && 'text-right'
                  )}
                  style={{
                    width:
                      header.column.id === 'actions'
                        ? `${fixedActionsWidth}px`
                        : fixedActionsWidth
                          ? `calc(${((header.getSize() || 1) / restColumnSize) * 100}% - ${(fixedActionsWidth / restColumnCount).toFixed(2)}px)`
                          : `${((header.getSize() || 1) / totalColumnSize) * 100}%`,
                  }}
                >
                  {header.isPlaceholder
                    ? null
                    : (header.column.columnDef.header as React.ReactNode)}
                  {/* 列宽拖拽手柄：与 ResourceTableView 同一套交互与视觉（共享组件）。 */}
                  {header.column.getCanResize() && (
                    <ColumnResizeHandle
                      resizing={header.column.getIsResizing()}
                      onPointerDown={header.getResizeHandler()}
                      onDoubleClick={() => header.column.resetSize()}
                    />
                  )}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow
              key={row.id}
              data-state={row.getIsSelected() && 'selected'}
            >
              {row.getVisibleCells().map((cell) => (
                <TableCell
                  key={cell.id}
                  className={cn(
                    cell.column.id === 'actions' && 'text-right',
                    // 第一列（名称）完整显示：单元格原语与名称列内部普遍带
                    // truncate（nowrap + 省略号），长名称会被截掉；这里改回自动
                    // 换行，超长名称在列内折行显示完整内容（与 ResourceTableView
                    // 第一列同一套做法），列宽仍可拖拽调整。
                    cell.column.id === firstDataColumnId &&
                      'whitespace-normal break-all [&_.truncate]:whitespace-normal [&_.truncate]:break-all'
                  )}
                >
                  {cell.column.columnDef.cell
                    ? flexRender(cell.column.columnDef.cell, cell.getContext())
                    : String(cell.getValue() || '-')}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
