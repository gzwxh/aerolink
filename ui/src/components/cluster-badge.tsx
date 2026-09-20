/* eslint-disable react-refresh/only-export-components */
import { useState } from 'react'
import { IconServer } from '@tabler/icons-react'

import { withSubPath } from '@/lib/subpath'
import { cn } from '@/lib/utils'

/** 集群徽章的展示字段，`Cluster` 与之结构兼容。 */
export interface ClusterBadgeSource {
  badgeEnabled?: boolean
  badgeText?: string
  badgeColor?: string
  badgeIconEnabled?: boolean
  badgeIconText?: string
  /** 管理员上传的图标地址，由服务端写入（见 `pkg/cluster/cluster_badge_icon.go`）。 */
  badgeIconUrl?: string
}

/** 集群没设颜色时用的默认背景色。 */
export const DEFAULT_CLUSTER_BADGE_COLOR = '#0011ff'

/**
 * 「自定义说明」的长度上限，按字符计，与服务端的 `maxBadgeTextRunes` 一致
 * （`pkg/cluster/cluster_handler.go`）。徽章按整段展示、不截断，所以这个长度也是
 * 徽章位预留的宽度上限。超长后端会 400，不静默截断。
 */
export const CLUSTER_BADGE_TEXT_MAX_LENGTH = 16

// 后端只收 #RRGGBB，但颜色会进内联样式，这里再兜一层：
// 历史数据或手工写库拿到非法值时回落默认色，而不是把它塞进 style。
const CLUSTER_BADGE_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/

export function isValidClusterBadgeColor(color: string): boolean {
  return CLUSTER_BADGE_COLOR_PATTERN.test(color.trim())
}

export function resolveClusterBadgeColor(color?: string): string {
  return color && isValidClusterBadgeColor(color)
    ? color.trim()
    : DEFAULT_CLUSTER_BADGE_COLOR
}

/** 徽章是否该出现：启用了徽章并且有说明文案，否则连占位都不要。 */
export function hasClusterBadge(
  cluster?: ClusterBadgeSource | null
): cluster is ClusterBadgeSource & { badgeText: string } {
  return Boolean(cluster?.badgeEnabled && cluster.badgeText?.trim())
}

/**
 * 上传的图标地址由服务端写入（`/api/v1/clusters/<id>/badge-icon?v=<hash>`，
 * 不带 base path），子路径部署时要补上前缀，否则请求会打到域名根上。
 */
export function resolveClusterBadgeIconSrc(url?: string): string | undefined {
  const value = (url || '').trim()
  if (!value) {
    return undefined
  }
  return value.startsWith('/api/') ? withSubPath(value) : value
}

/**
 * 集群说明徽章（如「测试环境」）。
 *
 * 文案上限是 `CLUSTER_BADGE_TEXT_MAX_LENGTH`（16 个字符），所以整段展示、不截断：
 * 徽章位就是按这个长度留的宽度，加 `truncate` 只会把末尾几个字吃掉。
 * 完整文案另外放在 title 上，鼠标悬停可见。
 */
export function ClusterBadge({
  cluster,
  className,
}: {
  cluster?: ClusterBadgeSource | null
  className?: string
}) {
  if (!hasClusterBadge(cluster)) {
    return null
  }
  const text = cluster.badgeText.trim()

  return (
    <span
      title={text}
      style={{ backgroundColor: resolveClusterBadgeColor(cluster.badgeColor) }}
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium leading-4 whitespace-nowrap text-white',
        className
      )}
    >
      {text}
    </span>
  )
}

/** 图标位的三档尺寸：`sm` 用于下拉项，`md` 是默认，`lg` 用于弹窗预览。 */
export type ClusterBadgeIconSize = 'sm' | 'md' | 'lg'

// 默认图标与上传的图片都是正方形，尺寸靠 h/w 锁死；图标文本是按字数撑开的
// 横条（6 个汉字要完整显示，固定宽度会把它们切掉），所以只锁高度、宽度自适应。
const ICON_SIZE_CLASS: Record<
  ClusterBadgeIconSize,
  { square: string; text: string }
> = {
  sm: { square: 'h-3.5 w-3.5', text: 'h-3.5 min-w-3.5 px-0.5 text-[8px]' },
  md: { square: 'h-4 w-4', text: 'h-4 min-w-4 px-1 text-[9px]' },
  lg: { square: 'h-5 w-5', text: 'h-5 min-w-5 px-1 text-[11px]' },
}

/**
 * 集群图标：启用了自定义图标时显示上传的图片，其次是图标文本（带徽章底色的短标签，
 * 最多 6 个汉字，整段显示不截断），否则沿用默认的集群图标。
 *
 * 只认 `badgeIconEnabled`，不要求集群徽章也启用：图标是集群自己的标识，
 * 只换图标不显示说明的集群同样要能看到它（否则上传完界面上毫无变化）。
 */
export function ClusterBadgeIcon({
  cluster,
  size = 'md',
  className,
}: {
  cluster?: ClusterBadgeSource | null
  size?: ClusterBadgeIconSize
  className?: string
}) {
  const classes = ICON_SIZE_CLASS[size]
  const iconSrc = resolveClusterBadgeIconSrc(cluster?.badgeIconUrl)
  // 记住加载失败的地址而不是一个布尔值：地址变了（重新上传过）就重试一次，
  // 不会因为上一次 404 而一直显示默认图标。
  const [failedSrc, setFailedSrc] = useState<string | null>(null)

  const iconText = cluster?.badgeIconText?.trim()
  const showCustom = Boolean(cluster?.badgeIconEnabled)
  const showImage = showCustom && iconSrc && iconSrc !== failedSrc
  const showText = showCustom && !showImage && Boolean(iconText)

  if (showImage) {
    return (
      <img
        src={iconSrc}
        // 纯装饰：集群名就在旁边，读屏重复念一遍图标没有意义。
        alt=""
        className={cn(
          classes.square,
          'shrink-0 rounded object-cover',
          className
        )}
        onError={() => setFailedSrc(iconSrc)}
      />
    )
  }

  if (!showText) {
    return <IconServer className={cn(classes.square, 'shrink-0', className)} />
  }

  return (
    <span
      title={iconText}
      style={{ backgroundColor: resolveClusterBadgeColor(cluster?.badgeColor) }}
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded font-medium leading-none text-white',
        classes.text,
        className
      )}
    >
      {/* 不截断：图标文本最多 6 个字，宽度就是按这个长度留的。 */}
      <span className="whitespace-nowrap">{iconText}</span>
    </span>
  )
}
