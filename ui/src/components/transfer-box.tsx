import type { ReactNode } from 'react'
import {
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
} from '@tabler/icons-react'

import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/** 穿梭框条目：左右两侧列表共用，id 稳定用于选中态与 React key。 */
export interface TransferItem {
  id: string
  label: string
  /** 行尾等宽大写徽标（WILDCARD / SETTINGS / CLUSTER / NAMESPACED），与截图一致。 */
  badge?: string
  /** 次要说明，显示在标签下方。 */
  note?: string
  /**
   * 备注列（如角色描述）。留空串表示「这一列存在但没填」，用于让同一列表里的行
   * 保持对齐；完全不传则不占用这一列（用户 / 用户组、命名空间等列表仍是一列）。
   */
  description?: string
}

/** 穿梭框一侧的列表：单击选中（再用中间按钮搬运），双击直接搬运。 */
export function TransferList({
  items,
  selectedId,
  emptyText,
  onSelect,
  onActivate,
  className = 'h-72',
}: {
  items: TransferItem[]
  selectedId?: string
  emptyText: string
  onSelect: (id: string) => void
  onActivate: (id: string) => void
  /** 列表高度：同行两列必须一致，页面里成组排列时按可用高度调小。 */
  className?: string
}) {
  if (items.length === 0) {
    return (
      <div
        className={cn(
          'flex items-center justify-center rounded-md border px-3 text-center text-sm text-muted-foreground',
          className
        )}
      >
        {emptyText}
      </div>
    )
  }
  return (
    <div
      className={cn('divide-y overflow-y-auto rounded-md border', className)}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={cn(
            'flex w-full items-center gap-3 px-3 py-1.5 text-left text-sm hover:bg-accent',
            selectedId === item.id && 'bg-primary/10 hover:bg-primary/10'
          )}
          // 备注常常比名称长，截断后靠 title 看全文。
          title={
            item.description
              ? `${item.label} · ${item.description}`
              : item.label
          }
          onClick={() => onSelect(item.id)}
          onDoubleClick={() => onActivate(item.id)}
        >
          {/* 列：名称 / 备注 / 权限 ID / 范围徽标，行与行对齐。 */}
          <span
            className={cn(
              'truncate',
              // 有备注列时名称固定占比，否则整行留给名称。
              item.description === undefined
                ? 'min-w-0 flex-1'
                : 'w-2/5 shrink-0'
            )}
          >
            {item.label}
          </span>
          {item.description !== undefined && (
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {item.description || '-'}
            </span>
          )}
          {item.note && (
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {item.note}
            </span>
          )}
          {item.badge && (
            <span className="w-20 shrink-0 text-right font-mono text-[10px] uppercase leading-none text-muted-foreground">
              {item.badge}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}

export interface TransferMoveLabels {
  grantAll: string
  grantSelected: string
  revokeSelected: string
  revokeAll: string
}

/**
 * 分离式穿梭框（对齐截图）：左侧「可用」带过滤框，右侧「已赋予」不带，
 * 中间是 `» > < «` 四个搬运按钮。
 */
export function TransferBox({
  title,
  hint,
  availableLabel,
  includedLabel,
  available,
  included,
  filterValue,
  onFilterChange,
  filterPlaceholder,
  availableEmptyText,
  includedEmptyText,
  selectedAvailableId,
  selectedIncludedId,
  onSelect,
  onGrant,
  onRevoke,
  onGrantAll,
  onRevokeAll,
  moveLabels,
  listClassName,
  availableFilterAddon,
}: {
  title: string
  hint?: string
  availableLabel: string
  includedLabel: string
  available: TransferItem[]
  included: TransferItem[]
  filterValue: string
  onFilterChange: (value: string) => void
  filterPlaceholder: string
  availableEmptyText: string
  includedEmptyText: string
  selectedAvailableId?: string
  selectedIncludedId?: string
  onSelect: (side: 'available' | 'included', id: string) => void
  /** 把某条从「可用」搬到右侧；双击与 `>` 按钮都走它，避免依赖选中态。 */
  onGrant: (id: string) => void
  /** 把某条从右侧搬回「可用」。 */
  onRevoke: (id: string) => void
  /** 全选搬运：带上过滤词时只搬当前可见的条目，参数即要搬运的 id 列表。 */
  onGrantAll: (ids: string[]) => void
  onRevokeAll: () => void
  moveLabels: TransferMoveLabels
  listClassName?: string
  /** 过滤框左侧的附加控件（例如「用户 / 用户组」切换）。 */
  availableFilterAddon?: ReactNode
}) {
  const q = filterValue.trim().toLowerCase()
  const matches = (item: TransferItem) =>
    !q ||
    item.label.toLowerCase().includes(q) ||
    item.id.toLowerCase().includes(q) ||
    (item.description ?? '').toLowerCase().includes(q) ||
    (item.badge ?? '').toLowerCase().includes(q)
  // 过滤词只作用于「可用」一侧（右侧没有过滤框，计数也始终按全集显示）。
  const shownAvailable = available.filter(matches)

  const moves: {
    key: string
    icon: typeof IconChevronRight
    label: string
    disabled: boolean
    run: () => void
  }[] = [
    {
      key: 'grant-all',
      icon: IconChevronsRight,
      label: moveLabels.grantAll,
      disabled: shownAvailable.length === 0,
      run: () => onGrantAll(shownAvailable.map((item) => item.id)),
    },
    {
      key: 'grant-selected',
      icon: IconChevronRight,
      label: moveLabels.grantSelected,
      disabled: !selectedAvailableId,
      run: () => selectedAvailableId && onGrant(selectedAvailableId),
    },
    {
      key: 'revoke-selected',
      icon: IconChevronLeft,
      label: moveLabels.revokeSelected,
      disabled: !selectedIncludedId,
      run: () => selectedIncludedId && onRevoke(selectedIncludedId),
    },
    {
      key: 'revoke-all',
      icon: IconChevronsLeft,
      label: moveLabels.revokeAll,
      disabled: included.length === 0,
      run: onRevokeAll,
    },
  ]

  return (
    <div className="space-y-2">
      <div className="font-medium">{title}</div>
      {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{availableLabel}</span>
          <Badge variant="secondary">{available.length}</Badge>
        </div>
        <div />
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{includedLabel}</span>
          <Badge variant="secondary">{included.length}</Badge>
        </div>
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            {availableFilterAddon}
            <Input
              value={filterValue}
              onChange={(e) => onFilterChange(e.target.value)}
              placeholder={filterPlaceholder}
              className="h-8 min-w-0 flex-1 text-sm"
            />
          </div>
          <TransferList
            items={shownAvailable}
            selectedId={selectedAvailableId}
            emptyText={availableEmptyText}
            onSelect={(id) => onSelect('available', id)}
            onActivate={onGrant}
            className={listClassName}
          />
        </div>
        <div className="flex flex-col items-center justify-center gap-1.5">
          {moves.map((move) => (
            <Button
              key={move.key}
              type="button"
              variant="outline"
              size="sm"
              className="h-7 w-7 p-0"
              title={move.label}
              aria-label={move.label}
              disabled={move.disabled}
              onClick={move.run}
            >
              <move.icon className="h-3.5 w-3.5" />
            </Button>
          ))}
        </div>
        <div className="space-y-2">
          <div className="h-8" aria-hidden />
          <TransferList
            items={included}
            selectedId={selectedIncludedId}
            emptyText={includedEmptyText}
            onSelect={(id) => onSelect('included', id)}
            onActivate={onRevoke}
            className={listClassName}
          />
        </div>
      </div>
    </div>
  )
}
