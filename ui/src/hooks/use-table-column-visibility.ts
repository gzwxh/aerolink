import { useEffect, useState } from 'react'
import { VisibilityState } from '@tanstack/react-table'

import { migrateLegacyKiteStorageKey } from '@/lib/storage-migration'

/**
 * 表格「显示哪些列」的偏好：与资源列表（/deployments 等）同一套交互——齿轮菜单勾选 +
 * localStorage 持久化，配合 `<TableColumnToggle table={table} />` 使用。
 *
 * storageKey 由调用方给出。设置页里的表格都是全局数据（用户、用户组、各类日志），
 * 习惯上不带集群前缀，避免切集群后偏好看起来被重置。
 */
export function useTableColumnVisibility(
  storageKey: string,
  defaults: VisibilityState = {}
) {
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(
    () => {
      try {
        // 旧产品名时期写下的 key（`kite-*`）在这里一次性搬到 `aerolink-*`。
        migrateLegacyKiteStorageKey(localStorage, storageKey)
        const stored = localStorage.getItem(storageKey)
        if (!stored) return { ...defaults }
        return { ...defaults, ...(JSON.parse(stored) as VisibilityState) }
      } catch {
        return { ...defaults }
      }
    }
  )

  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(columnVisibility))
  }, [columnVisibility, storageKey])

  return [columnVisibility, setColumnVisibility] as const
}
