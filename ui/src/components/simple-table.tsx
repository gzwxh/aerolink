import React, { useEffect, useMemo, useRef, useState } from 'react'

import { cn } from '@/lib/utils'

import { ColumnResizeHandle } from './column-resize-handle'
import { Button } from './ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './ui/table'

/** 拖宽的下限，与 ResourceTable 的 defaultColumn.minSize 一致。 */
const MIN_COLUMN_WIDTH = 80

interface Column<T> {
  header: string
  accessor: (item: T) => unknown
  cell: (value: unknown) => React.ReactNode
  align?: 'left' | 'center' | 'right'
}

interface SimpleTableProps<T> {
  data: T[]
  columns: Column<T>[]
  emptyMessage?: string
  /**
   * 传入 localStorage key 即启用表头列宽拖拽并持久化（SimpleTable 不是
   * TanStack 表格，列没有稳定 id，按列下标存储）；不传则行为不变。
   */
  storageKey?: string
  pagination?: {
    enabled: boolean
    pageSize?: number
    showPageInfo?: boolean
    currentPage?: number
    onPageChange?: (page: number) => void
  }
}

export function SimpleTable<T>({
  data,
  columns,
  emptyMessage = 'No data available',
  storageKey,
  pagination,
}: SimpleTableProps<T>) {
  // 列宽拖拽（按列下标记录像素宽）：被拖过的列写死 width + minWidth，
  // 其余列继续按内容自适应（table-auto），与资源列表的自动布局同一模型。
  const [columnWidths, setColumnWidths] = useState<Record<number, number>>(
    () => {
      if (!storageKey) {
        return {}
      }
      try {
        const stored = localStorage.getItem(storageKey)
        if (!stored) {
          return {}
        }
        const parsed = JSON.parse(stored) as Record<string, unknown>
        const widths: Record<number, number> = {}
        for (const [index, width] of Object.entries(parsed)) {
          const columnIndex = Number(index)
          if (
            Number.isInteger(columnIndex) &&
            columnIndex >= 0 &&
            typeof width === 'number' &&
            Number.isFinite(width)
          ) {
            widths[columnIndex] = width
          }
        }
        return widths
      } catch {
        return {}
      }
    }
  )
  useEffect(() => {
    if (!storageKey) {
      return
    }
    localStorage.setItem(storageKey, JSON.stringify(columnWidths))
  }, [columnWidths, storageKey])

  const resizeStateRef = useRef<{
    index: number
    startX: number
    startWidth: number
  } | null>(null)
  const [resizingIndex, setResizingIndex] = useState<number | null>(null)

  const handleResizeStart = (
    index: number,
    event: React.MouseEvent | React.TouchEvent
  ) => {
    const th = (event.currentTarget as HTMLElement).closest('th')
    if (!th) {
      return
    }
    event.preventDefault()
    const point = 'touches' in event ? event.touches[0] : event
    resizeStateRef.current = {
      index,
      startX: point.clientX,
      startWidth: th.getBoundingClientRect().width,
    }
    setResizingIndex(index)
  }

  useEffect(() => {
    if (resizingIndex === null) {
      return
    }
    const handleMove = (event: MouseEvent | TouchEvent) => {
      const state = resizeStateRef.current
      if (!state) {
        return
      }
      const point = 'touches' in event ? event.touches[0] : event
      if (!point) {
        return
      }
      const width = Math.max(
        MIN_COLUMN_WIDTH,
        Math.round(state.startWidth + point.clientX - state.startX)
      )
      setColumnWidths((prev) =>
        prev[state.index] === width ? prev : { ...prev, [state.index]: width }
      )
    }
    const handleEnd = () => {
      resizeStateRef.current = null
      setResizingIndex(null)
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleEnd)
    // 手柄上 touch-action:none 挡住了滚动，这里被动监听即可。
    window.addEventListener('touchmove', handleMove, { passive: true })
    window.addEventListener('touchend', handleEnd)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleEnd)
      window.removeEventListener('touchmove', handleMove)
      window.removeEventListener('touchend', handleEnd)
    }
  }, [resizingIndex])

  const isControlled =
    pagination &&
    typeof pagination.currentPage === 'number' &&
    typeof pagination.onPageChange === 'function'
  const [uncontrolledPage, setUncontrolledPage] = useState(1)
  const currentPage = isControlled ? pagination!.currentPage! : uncontrolledPage
  const setCurrentPage = isControlled
    ? pagination!.onPageChange!
    : setUncontrolledPage

  const paginationConfig = useMemo(
    () => ({
      enabled: pagination?.enabled ?? false,
      pageSize: pagination?.pageSize ?? 10,
      showPageInfo: pagination?.showPageInfo ?? true,
    }),
    [pagination]
  )

  const { paginatedData, totalPages, startIndex, endIndex } = useMemo(() => {
    if (!paginationConfig.enabled) {
      return {
        paginatedData: data,
        totalPages: 1,
        startIndex: 1,
        endIndex: data.length,
      }
    }

    const { pageSize } = paginationConfig
    const totalPages = Math.ceil(data.length / pageSize)
    const startIndex = (currentPage - 1) * pageSize
    const endIndex = Math.min(startIndex + pageSize, data.length)
    const paginatedData = data.slice(startIndex, endIndex)

    return {
      paginatedData,
      totalPages,
      startIndex: startIndex + 1,
      endIndex,
    }
  }, [data, currentPage, paginationConfig])

  const handlePreviousPage = () => {
    if (isControlled) {
      setCurrentPage(Math.max(currentPage - 1, 1))
    } else {
      setUncontrolledPage(Math.max(currentPage - 1, 1))
    }
  }

  const handleNextPage = () => {
    if (isControlled) {
      setCurrentPage(Math.min(currentPage + 1, totalPages))
    } else {
      setUncontrolledPage(Math.min(currentPage + 1, totalPages))
    }
  }

  const handlePageChange = (page: number) => {
    setCurrentPage(page)
  }
  return (
    <div className="space-y-4">
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((column, index) => (
              <TableHead
                key={index}
                className={cn(
                  'group/th relative',
                  column.align === 'left'
                    ? 'text-left'
                    : column.align === 'right'
                      ? 'text-right'
                      : 'text-center'
                )}
                style={
                  columnWidths[index]
                    ? {
                        width: `${columnWidths[index]}px`,
                        minWidth: `${columnWidths[index]}px`,
                      }
                    : undefined
                }
              >
                {column.header}
                {storageKey && (
                  <ColumnResizeHandle
                    resizing={resizingIndex === index}
                    onPointerDown={(event) => handleResizeStart(index, event)}
                  />
                )}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {paginatedData.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={columns.length}
                className="text-center text-muted-foreground"
              >
                {emptyMessage}
              </TableCell>
            </TableRow>
          ) : (
            paginatedData.map((item, rowIndex) => (
              <TableRow key={rowIndex}>
                {columns.map((column, colIndex) => (
                  <TableCell
                    key={colIndex}
                    className={
                      column.align === 'left'
                        ? 'text-left'
                        : column.align === 'right'
                          ? 'text-right'
                          : 'text-center'
                    }
                  >
                    {column.cell(column.accessor(item))}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {paginationConfig.enabled && data.length > 0 && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {paginationConfig.showPageInfo && (
            <div className="text-sm text-muted-foreground">
              Showing {startIndex} - {endIndex} of {data.length} entries
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handlePreviousPage}
              disabled={currentPage === 1}
            >
              Previous
            </Button>

            <div className="flex flex-wrap items-center gap-1">
              {Array.from({ length: totalPages }, (_, i) => i + 1)
                .filter((page) => {
                  // 展示当前页 ±2 页，加上首页与末页
                  return (
                    page === 1 ||
                    page === totalPages ||
                    (page >= currentPage - 2 && page <= currentPage + 2)
                  )
                })
                .map((page, index, array) => {
                  const prevPage = array[index - 1]
                  const showEllipsis = prevPage && page - prevPage > 1

                  return (
                    <React.Fragment key={page}>
                      {showEllipsis && (
                        <span className="px-2 text-muted-foreground">...</span>
                      )}
                      <Button
                        variant={currentPage === page ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => handlePageChange(page)}
                        className="min-w-[32px]"
                      >
                        {page}
                      </Button>
                    </React.Fragment>
                  )
                })}
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={handleNextPage}
              disabled={currentPage === totalPages}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

export type { Column }
