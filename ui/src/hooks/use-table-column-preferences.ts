import { useEffect, useState } from 'react'
import { ColumnSizingState } from '@tanstack/react-table'

/**
 * 列宽的偏好 hook：与 use-table-column-visibility（显示哪些列）
 * 同一套 localStorage 模式，供「自带 useReactTable 的表格」使用（设置页
 * 各表格）。资源列表页的对应状态在 use-resource-table-state 里管理。
 *
 * storageKey 由调用方给出。设置页里的表格都是全局数据（用户、各类日志），
 * 习惯上不带集群前缀，避免切集群后偏好看起来被重置。
 */

function readStoredJSON<T>(storageKey: string, fallback: T): T {
  try {
    const stored = localStorage.getItem(storageKey)
    if (!stored) {
      return fallback
    }
    return JSON.parse(stored) as T
  } catch {
    return fallback
  }
}

/** 列宽偏好：只存用户手动调整过的列（columnId -> 像素宽），读入时过滤非法值。 */
export function useTableColumnSizing(storageKey: string) {
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>(() => {
    const stored = readStoredJSON<Record<string, unknown> | null>(
      storageKey,
      null
    )
    if (!stored) {
      return {}
    }
    return Object.fromEntries(
      Object.entries(stored).filter(([, size]) => Number.isFinite(size))
    ) as ColumnSizingState
  })

  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(columnSizing))
  }, [columnSizing, storageKey])

  return [columnSizing, setColumnSizing] as const
}
