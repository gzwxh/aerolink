import React, { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  flexRender,
  PaginationState,
  Table as TableInstance,
} from '@tanstack/react-table'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
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
}: ResourceTableViewProps<T>) {
  const { t } = useTranslation()
  // 可见列 size 之和：下面把每列宽度换算成它的占比（总宽恒为 100%）。
  // 这样列数再多、内容再长，表格都待在容器里，不会出现横向滚动。
  const totalColumnSize = table.getTotalSize() || 1

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
      const details = renderRowDetails?.(row.original)
      return (
        <React.Fragment key={row.id}>
          <TableRow
            data-state={row.getIsSelected() && 'selected'}
            className={details ? 'border-b-0' : undefined}
          >
            {row.getVisibleCells().map((cell, index) => (
              <TableCell
                key={cell.id}
                className={`align-middle ${index <= 1 ? 'text-left' : 'text-center'}`}
              >
                {cell.column.columnDef.cell
                  ? flexRender(cell.column.columnDef.cell, cell.getContext())
                  : String(cell.getValue() || '-')}
              </TableCell>
            ))}
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
                fitViewportHeight ? 'min-h-[240px]' : maxBodyHeightClassName
              )}
              style={
                fitViewportHeight && tableHeight
                  ? { height: `${tableHeight}px` }
                  : undefined
              }
            >
              <Table className={columnSizing ? 'table-fixed' : undefined}>
                <TableHeader className="bg-muted">
                  {table.getHeaderGroups().map((headerGroup) => (
                    <TableRow key={headerGroup.id}>
                      {headerGroup.headers.map((header, index) => (
                        <TableHead
                          key={header.id}
                          className={index <= 1 ? 'text-left' : 'text-center'}
                          style={
                            columnSizing
                              ? // 按 size 的**比例**分配，而不是写死像素：写死会让总宽超过
                                // 容器，列一多就逼出横向滚动条（用户反馈的就是这个）。
                                {
                                  width: `${((header.getSize() || 1) / totalColumnSize) * 100}%`,
                                }
                              : undefined
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
                        </TableHead>
                      ))}
                    </TableRow>
                  ))}
                </TableHeader>
                <TableBody
                  className={cn(
                    shrinkFirstColumn && '**:data-[slot=table-cell]:first:w-0'
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
