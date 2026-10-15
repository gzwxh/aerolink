import React from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'

interface ColumnResizeHandleProps {
  /** 该列正处于拖动中（手柄常亮）。 */
  resizing: boolean
  /** 开始拖动（TanStack 的 getResizeHandler() 或自实现的 pointer 处理器）。 */
  onPointerDown: (event: React.MouseEvent | React.TouchEvent) => void
  onDoubleClick?: () => void
}

/**
 * 表头右缘的列宽拖拽手柄：贴右缘的窄命中区，悬停**所属表头**（group/th）
 * 时显出一条竖线，拖动中常亮。
 *
 * 对比度只走语义 token：hover 用 primary/40，拖动中 primary 外加一圈
 * `--background` 描边——深色主题、低饱和 primary 下也能与表头底色拉开。
 * draggable=false 防止在 handle 上起拖时触发同单元格的列顺序拖拽。
 */
export function ColumnResizeHandle({
  resizing,
  onPointerDown,
  onDoubleClick,
}: ColumnResizeHandleProps) {
  const { t } = useTranslation()
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      title={t('resourceTable.columnResizeHint', '拖动调整列宽，双击恢复默认')}
      draggable={false}
      onMouseDown={onPointerDown}
      onTouchStart={onPointerDown}
      onDoubleClick={onDoubleClick}
      className={cn(
        'absolute inset-y-0 right-0 z-10 w-2 cursor-col-resize touch-none select-none',
        'after:absolute after:inset-y-2 after:right-0.5 after:w-0.5 after:rounded-full after:transition-colors',
        resizing
          ? 'after:bg-primary after:shadow-[0_0_0_1px_var(--background)]'
          : 'after:bg-transparent group-hover/th:after:bg-primary/40'
      )}
    />
  )
}
