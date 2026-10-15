import React, {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import {
  flexRender,
  PaginationState,
  Table as TableInstance,
} from '@tanstack/react-table'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'
import { ColumnResizeHandle } from './column-resize-handle'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

interface ResourceTableViewProps<T> {
  table: TableInstance<T>
  columnCount: number
  isLoading: boolean
  data?: T[]
  allPageSize?: number
  maxBodyHeightClassName?: string
  containerClassName?: string
  fitViewportHeight?: boolean
  /**
   * 启用表头列顺序拖拽（HTML5 DnD，拖动 th 换位）。配合 TanStack 的
   * columnOrder 状态使用；勾选列（select）与操作列（actions）固定在两端。
   */
  enableReorder?: boolean
  emptyState: React.ReactNode
  hasActiveFilters: boolean
  filteredRowCount: number
  totalRowCount: number
  searchQuery: string
  pagination: PaginationState
  setPagination: React.Dispatch<React.SetStateAction<PaginationState>>
  shrinkFirstColumn?: boolean
  /**
   * 按列定义里的 `size` 固定列宽（`table-fixed`）：列宽稳定、长内容靠截断显示，
   * 而不是由最长的那个单元格把整张表撑宽。配合单元格里的 `truncate` 使用。
   */
  /**
   * 固定列宽（`table-fixed` + 按列的 size 分配，见 resource-table.tsx 的 defaultColumn）。
   * 默认开：内容长短与排序都不该让列宽跳动；个别页面想恢复自动布局可显式传 false。
   */
  columnSizing?: boolean
  showAllPageSize?: boolean
  pageSizeOptions?: number[]
  /** 可选的全宽详情，渲染在每一行数据下方的一行里。 */
  renderRowDetails?: (row: T) => React.ReactNode
  /**
   * 行分组配置（见 ResourceTableProps.grouping）：每个分组行渲染成
   * 一条全宽的组标题行，标题内容由 renderGroupHeader 提供。
   */
  grouping?: {
    columnId: string
    renderGroupHeader: (value: string, rowCount: number) => React.ReactNode
  }
}

export function ResourceTableView<T>({
  table,
  columnCount,
  isLoading,
  data,
  allPageSize,
  maxBodyHeightClassName = 'max-h-[calc(100dvh-210px)]',
  containerClassName = 'flex flex-col gap-3',
  fitViewportHeight = false,
  enableReorder = false,
  emptyState,
  hasActiveFilters,
  filteredRowCount,
  totalRowCount,
  searchQuery,
  pagination,
  setPagination,
  shrinkFirstColumn = true,
  columnSizing = true,
  showAllPageSize = true,
  pageSizeOptions = [10, 20, 50, 100],
  renderRowDetails,
  grouping,
}: ResourceTableViewProps<T>) {
  const { t } = useTranslation()
  // 可见列 size 之和：下面把每列宽度换算成它的占比（总宽恒为 100%）。
  // 这样列数再多、内容再长，表格都待在容器里，不会出现横向滚动。
  const totalColumnSize = table.getTotalSize() || 1
  // 复选框列固定像素宽：若按 size 占比分配，宽屏下这一列会被等比放大，
  // 复选框和第一数据列之间出现大片空白（参照资源管理器，两者应紧邻）。
  // 其余列用 calc 从「容器宽 - 固定宽」里按原占比分摊，总宽仍恒为 100%。
  const SELECT_COLUMN_WIDTH = 32
  const selectLeafColumn = table
    .getVisibleLeafColumns()
    .find((column) => column.id === 'select')
  const fixedSelectWidth =
    columnSizing && selectLeafColumn ? SELECT_COLUMN_WIDTH : 0
  // 带勾选列（select）= 资源列表页：用自动布局按内容排布（紧凑 + 名称完整）。
  // 不带勾选列的自定义表（审计日志等）保留 table-fixed 比例分配，避免长内容撑宽。
  const isSelectionTable = Boolean(selectLeafColumn)
  const firstDataColumn =
    table.getVisibleLeafColumns().find((column) => column.id !== 'select') ??
    null
  const firstDataColumnId = firstDataColumn?.id
  const manualColumnSizing = table.getState().columnSizing
  const restColumnSize =
    totalColumnSize - (selectLeafColumn?.getSize() ?? 0) || 1
  const restColumnCount = Math.max(
    table.getVisibleLeafColumns().length - (selectLeafColumn ? 1 : 0),
    1
  )

  // 列顺序拖拽（HTML5 DnD）：拖动表头到目标列的左/右半边换位。
  // 勾选列（select）与操作列（actions）是结构列，不可拖也不可作落点。
  const dragColumnIdRef = useRef<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{
    id: string
    after: boolean
  } | null>(null)
  const clearDragState = useCallback(() => {
    dragColumnIdRef.current = null
    setDropTarget(null)
  }, [])
  const canReorderColumn = useCallback(
    (columnId: string) =>
      enableReorder && columnId !== 'select' && columnId !== 'actions',
    [enableReorder]
  )
  const applyColumnOrder = useCallback(
    (fromId: string, targetId: string, after: boolean) => {
      const order = table.getVisibleLeafColumns().map((column) => column.id)
      const fromIndex = order.indexOf(fromId)
      const targetIndex = order.indexOf(targetId)
      if (fromIndex < 0 || targetIndex < 0) {
        return
      }
      order.splice(fromIndex, 1)
      const adjustedTargetIndex = order.indexOf(targetId)
      order.splice(after ? adjustedTargetIndex + 1 : adjustedTargetIndex, 0, fromId)
      // 结构列强制归位：勾选列最左、操作列最右。
      const selectIndex = order.indexOf('select')
      if (selectIndex > 0) {
        order.splice(selectIndex, 1)
        order.unshift('select')
      }
      const actionsIndex = order.indexOf('actions')
      if (actionsIndex >= 0 && actionsIndex !== order.length - 1) {
        order.splice(actionsIndex, 1)
        order.push('actions')
      }
      table.setColumnOrder(order)
    },
    [table]
  )
  const makeReorderProps = (columnId: string) => {
    if (!canReorderColumn(columnId)) {
      return {}
    }
    return {
      draggable: true as const,
      onDragStart: (event: React.DragEvent) => {
        dragColumnIdRef.current = columnId
        event.dataTransfer.effectAllowed = 'move'
        // Firefox 需要 setData 才会真正进入拖拽。
        event.dataTransfer.setData('text/plain', columnId)
      },
      onDragOver: (event: React.DragEvent) => {
        const fromId = dragColumnIdRef.current
        if (!fromId || fromId === columnId) {
          return
        }
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        const rect = event.currentTarget.getBoundingClientRect()
        setDropTarget({
          id: columnId,
          after: event.clientX > rect.left + rect.width / 2,
        })
      },
      onDrop: (event: React.DragEvent) => {
        event.preventDefault()
        const fromId = dragColumnIdRef.current
        clearDragState()
        if (!fromId || fromId === columnId) {
          return
        }
        // 落点在 drop 时现算，不依赖 dragOver 先行写入的 state
        //（真实浏览器里 dragOver 必先触发，但直接读 event 更可靠）。
        const rect = event.currentTarget.getBoundingClientRect()
        const after = event.clientX > rect.left + rect.width / 2
        applyColumnOrder(fromId, columnId, after)
      },
      onDragEnd: clearDragState,
    }
  }

  const renderRows = () => {
    const rows = table.getRowModel().rows

    if (rows.length === 0) {
      return (
        <TableRow>
          <TableCell colSpan={columnCount} className="h-24 text-center">
            {t('resourceTable.noResults', 'No results.')}
          </TableCell>
        </TableRow>
      )
    }

    return rows.map((row) => {
      // 组标题行：第一格是与数据行对齐的组级复选框（勾选/取消整组资源行），
      // 其余列合并放组名。用原生 td 渲染，避开「首列宽度收缩为 0」
      // 的规则（与下面的详情行同样的处理）。
      if (grouping && row.getIsGrouped()) {
        const leafRows = row.subRows
        const allSelected =
          leafRows.length > 0 && leafRows.every((leaf) => leaf.getIsSelected())
        const someSelected = leafRows.some((leaf) => leaf.getIsSelected())
        return (
          <TableRow
            key={row.id}
            className="group bg-muted/60 hover:bg-muted/60"
          >
            {/* 组级复选框与组名同格紧邻（参照资源管理器的分组头），不再分列；
                左内边距与数据行复选框一致（p-2），保证上下对齐 */}
            <td colSpan={columnCount} className="py-2 pl-2 pr-4 text-left">
              <div className="flex items-center gap-2">
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
                  aria-label={t('resourceTable.selectGroupRows')}
                  className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 data-[state=checked]:opacity-100 data-[state=indeterminate]:opacity-100"
                />
                {grouping.renderGroupHeader(
                  String(row.getValue(grouping.columnId) ?? ''),
                  row.subRows.length
                )}
              </div>
            </td>
          </TableRow>
        )
      }
      const details = renderRowDetails?.(row.original)
      return (
        <React.Fragment key={row.id}>
          <TableRow
            data-state={row.getIsSelected() && 'selected'}
            className={cn('group', details && 'border-b-0')}
          >
            {row.getVisibleCells().map((cell, index) => {
              const isNameColumn =
                isSelectionTable && cell.column.id === firstDataColumnId
              return (
                <TableCell
                  key={cell.id}
                  className={`align-middle ${index <= 1 ? 'text-left' : 'text-center'}${
                    isNameColumn
                      ? // 名称列：覆盖列定义里 Link 的 truncate，超长名称换行而非截断。
                        ' [&_*]:!whitespace-normal'
                      : ''
                  }`}
                  style={
                    isNameColumn
                      ? { maxWidth: '400px', overflowWrap: 'break-word' }
                      : undefined
                  }
                >
                  {cell.column.columnDef.cell
                    ? flexRender(cell.column.columnDef.cell, cell.getContext())
                    : String(cell.getValue() || '-')}
                </TableCell>
              )
            })}
          </TableRow>
          {details ? (
            <TableRow className="bg-muted/20 hover:bg-muted/20">
              {/* Raw td so the table-cell first-column shrink rule does not apply. */}
              <td
                colSpan={columnCount}
                className="whitespace-normal px-4 py-2 text-left align-top"
              >
                {details}
              </td>
            </TableRow>
          ) : null}
        </React.Fragment>
      )
    })
  }

  const dataLength = data?.length ?? 0
  const resolvedAllPageSize = allPageSize ?? dataLength
  const rootRef = useRef<HTMLDivElement>(null)
  const tableShellRef = useRef<HTMLDivElement>(null)
  const footerRef = useRef<HTMLDivElement>(null)
  const [tableHeight, setTableHeight] = useState<number | null>(null)

  useLayoutEffect(() => {
    if (!fitViewportHeight || !tableShellRef.current) {
      return
    }

    let frameId = 0
    const resizeObserver = new ResizeObserver(() => {
      scheduleUpdate()
    })

    const updateHeight = () => {
      if (!tableShellRef.current) {
        return
      }

      const tableTop = tableShellRef.current.getBoundingClientRect().top
      const footerHeight =
        footerRef.current?.getBoundingClientRect().height ?? 0
      const footerGap = dataLength > 0 ? 12 : 0
      const nextHeight = Math.max(
        240,
        Math.floor(window.innerHeight - tableTop - footerHeight - footerGap)
      )

      setTableHeight((currentHeight) =>
        currentHeight === nextHeight ? currentHeight : nextHeight
      )
    }

    const scheduleUpdate = () => {
      window.cancelAnimationFrame(frameId)
      frameId = window.requestAnimationFrame(updateHeight)
    }

    scheduleUpdate()
    window.addEventListener('resize', scheduleUpdate)
    resizeObserver.observe(tableShellRef.current)
    if (footerRef.current) {
      resizeObserver.observe(footerRef.current)
    }
    if (rootRef.current?.parentElement) {
      resizeObserver.observe(rootRef.current.parentElement)
    }

    return () => {
      window.cancelAnimationFrame(frameId)
      window.removeEventListener('resize', scheduleUpdate)
      resizeObserver.disconnect()
    }
  }, [dataLength, fitViewportHeight])

  return (
    <div ref={rootRef} className={containerClassName}>
      <div ref={tableShellRef} className="rounded-lg border overflow-hidden">
        <div
          className={`transition-opacity duration-200 ${
            isLoading && dataLength > 0 ? 'opacity-75' : 'opacity-100'
          }`}
        >
          {emptyState || (
            <div
              className={cn(
                'relative overflow-auto scrollbar-hide',
                // Table 原语自带 `overflow-x-auto` 的外壳，浏览器会把「最近滚动容器」算成它，
                // 表头的 sticky 于是挂在那个永不纵向滚动的盒子上、吸不住。这里把它压平，
                // 横向与纵向都由本容器负责（原语本身不动）。
                '[&_[data-slot=table-container]]:overflow-visible',
                fitViewportHeight ? 'min-h-[240px]' : maxBodyHeightClassName
              )}
              style={
                fitViewportHeight && tableHeight
                  ? { height: `${tableHeight}px` }
                  : undefined
              }
            >
              <Table
                className={
                  columnSizing && !isSelectionTable ? 'table-fixed' : undefined
                }
              >
                {/* 表头吸顶：列表滚动后仍能对上列名（见上面滚动容器处的注释）。
                    分隔线用 inset 阴影而不是 border：表格是 border-collapse: collapse，
                    行边框不跟着 sticky 元素走，滚动后会留在原处。 */}
                <TableHeader className="bg-muted sticky top-0 z-10 shadow-[0_1px_0_0_var(--border)]">
                  {table.getHeaderGroups().map((headerGroup) => (
                    <TableRow key={headerGroup.id}>
                      {headerGroup.headers.map((header, index) => (
                        <TableHead
                          key={header.id}
                          className={cn(
                            // group/th：列宽手柄在悬停整个表头时显形。
                            'group/th relative',
                            index <= 1 ? 'text-left' : 'text-center',
                            // 列序拖拽落点指示：落在目标列的左/右半边。
                            dropTarget?.id === header.column.id &&
                              (dropTarget.after
                                ? 'shadow-[inset_-2px_0_0_0_var(--primary)]'
                                : 'shadow-[inset_2px_0_0_0_var(--primary)]')
                          )}
                          {...makeReorderProps(header.column.id)}
                          style={
                            !columnSizing
                              ? undefined
                              : header.column.id === 'select'
                                ? { width: `${fixedSelectWidth || SELECT_COLUMN_WIDTH}px` }
                                : isSelectionTable
                                  ? // 自动布局：只有手动拖过的列才写死像素，其余按内容自适应。
                                    manualColumnSizing[header.column.id] !==
                                    undefined
                                    ? { width: `${manualColumnSizing[header.column.id]}px` }
                                    : undefined
                                  : // 固定布局：按 size 比例分配（写死会让总宽超过容器，列一多就横向滚动）。
                                    {
                                      width: fixedSelectWidth
                                        ? `calc(${((header.getSize() || 1) / restColumnSize) * 100}% - ${(fixedSelectWidth / restColumnCount).toFixed(2)}px)`
                                        : `${((header.getSize() || 1) / totalColumnSize) * 100}%`,
                                    }
                          }
                        >
                          {header.isPlaceholder ? null : header.column.getCanSort() ? (
                            <Button
                              variant="ghost"
                              onClick={header.column.getToggleSortingHandler()}
                              className={
                                header.column.getIsSorted()
                                  ? 'text-primary'
                                  : ''
                              }
                            >
                              {flexRender(
                                header.column.columnDef.header,
                                header.getContext()
                              )}
                              {header.column.getIsSorted() && (
                                <span className="ml-2">
                                  {header.column.getIsSorted() === 'asc'
                                    ? '↑'
                                    : '↓'}
                                </span>
                              )}
                            </Button>
                          ) : (
                            flexRender(
                              header.column.columnDef.header,
                              header.getContext()
                            )
                          )}
                          {/* 列宽拖拽手柄：贴右缘的窄条，悬停表头显形，拖动中常亮。
                              双击恢复该列的默认宽度。视觉统一走共享组件。 */}
                          {columnSizing && header.column.getCanResize() && (
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
                <TableBody
                  className={cn(
                    // w-0 只在固定布局下用来收紧勾选列；自动布局由表头 32px 固定。
                    shrinkFirstColumn &&
                      !isSelectionTable &&
                      '**:data-[slot=table-cell]:first:w-0'
                  )}
                >
                  {renderRows()}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </div>

      {dataLength > 0 && (
        <div
          ref={footerRef}
          className="flex flex-col gap-3 px-2 py-1 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="text-muted-foreground hidden flex-1 text-sm lg:flex">
            {hasActiveFilters ? (
              <>
                {t(
                  'resourceTable.rowsFiltered',
                  '显示 {{shown}} / {{total}} 行',
                  { shown: filteredRowCount, total: totalRowCount }
                )}
                {searchQuery && (
                  <span className="ml-1">
                    {t('resourceTable.filteredBy', '（筛选：“{{query}}”）', {
                      query: searchQuery,
                    })}
                  </span>
                )}
              </>
            ) : (
              t('resourceTable.rowsTotal', '共 {{count}} 行', {
                count: totalRowCount,
              })
            )}
          </div>
          <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:gap-4 lg:w-fit">
            <div className="flex items-center justify-between gap-2 sm:justify-start">
              <span className="text-sm text-muted-foreground">
                {t('resourceTable.rowsPerPage', '每页行数')}:
              </span>
              <Select
                value={pagination.pageSize.toString()}
                onValueChange={(value) => {
                  setPagination((prev) => ({
                    ...prev,
                    pageSize: Number(value),
                    pageIndex: 0,
                  }))
                }}
              >
                <SelectTrigger size="sm" className="w-20" id="rows-per-page">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {pageSizeOptions.map((pageSize) => (
                    <SelectItem key={pageSize} value={`${pageSize}`}>
                      {pageSize}
                    </SelectItem>
                  ))}
                  {showAllPageSize && resolvedAllPageSize > 0 && (
                    <SelectItem value={`${resolvedAllPageSize}`}>
                      {t('resourceTable.allOption', 'All')}
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-center text-sm font-medium">
              {t('common.pagination.page', 'Page {{current}} of {{total}}', {
                current: pagination.pageIndex + 1,
                total: table.getPageCount() || 1,
              })}
            </div>
            <div className="flex items-center justify-end gap-2 sm:justify-start lg:ml-0">
              <Button
                variant="outline"
                className="size-8"
                size="icon"
                onClick={() => table.previousPage()}
                disabled={!table.getCanPreviousPage()}
              >
                <span className="sr-only">
                  {t('common.pagination.previous', 'Previous page')}
                </span>
                ←
              </Button>
              <Button
                variant="outline"
                className="size-8"
                size="icon"
                onClick={() => table.nextPage()}
                disabled={!table.getCanNextPage()}
              >
                <span className="sr-only">
                  {t('common.pagination.next', 'Next page')}
                </span>
                →
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
