/* eslint-disable react-refresh/only-export-components */
import { useState } from 'react'
import { IconServer } from '@tabler/icons-react'

import { withSubPath } from '@/lib/subpath'
import { cn } from '@/lib/utils'

/** 集群徽章的展示字段，`Cluster` 与之结构兼容。 */
export interface ClusterBadgeSource {
  badgeEnabled?: boolean
  badgeText?: string
  /** 说明文本的字号档位，空值等同 `md`（历史数据没有这个字段）。 */
  badgeTextSize?: string
  /** 说明文本是否加粗。 */
  badgeBold?: boolean
  badgeColor?: string
  /** 说明文本颜色（`#RRGGBB`），空值 = 按背景色自动取黑/白字。 */
  badgeTextColor?: string
  badgeIconEnabled?: boolean
  badgeIconText?: string
  /** 图标文本字号档位，空值 = 按展示位置自适应。 */
  badgeIconTextSize?: string
  /** 图标文本颜色（`#RRGGBB`），空值 = 按底色自动取黑/白字。 */
  badgeIconTextColor?: string
  /** 图标文本底色（`#RRGGBB`），空值 = 用徽章背景色。 */
  badgeIconTextBackground?: string
  badgeIconBold?: boolean
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

/**
 * 「自定义说明」的预设字号档位。默认 `md`（与历史数据的空值等价）。
 * 除了这三个档位，`badgeTextSize` 还可以存 10~24 的像素值（自定义字号），
 * 取值同样由服务端 validateClusterBadge 收口（见 pkg/cluster/cluster_handler.go）。
 */
export type ClusterBadgeTextSize = 'sm' | 'md' | 'lg'

/** 字号档位按「小 → 大」排列，配置弹窗直接照这个顺序渲染。 */
export const CLUSTER_BADGE_TEXT_SIZES: readonly ClusterBadgeTextSize[] = [
  'sm',
  'md',
  'lg',
]

// 内边距与行高跟着字号一起调：徽章按整段展示、不截断，只放大字号会让文字
// 顶出圆角边缘（py-0.5 容纳不下 text-sm 的行高）。
const CLUSTER_BADGE_TEXT_SIZE_CLASS: Record<ClusterBadgeTextSize, string> = {
  sm: 'px-1.5 py-px text-[10px] leading-3',
  md: 'px-2 py-0.5 text-xs leading-4',
  lg: 'px-2.5 py-1 text-sm leading-5',
}

/** 空值或库里的历史未知值一律按默认档渲染，不让脏数据影响排版。 */
export function resolveClusterBadgeTextSize(
  size?: string
): ClusterBadgeTextSize {
  return size === 'sm' || size === 'lg' ? size : 'md'
}

/** 说明字号的自定义像素范围，与服务端的校验口径一致。 */
export const CLUSTER_BADGE_TEXT_SIZE_MIN_PX = 10
export const CLUSTER_BADGE_TEXT_SIZE_MAX_PX = 24

const BADGE_TEXT_SIZE_PX: Record<ClusterBadgeTextSize, number> = {
  sm: 10,
  md: 12,
  lg: 14,
}

/** 自定义字号（十进制像素、落在范围内）才返回数字；其余情况返回 null 表示走预设档。 */
export function resolveCustomClusterBadgeTextSize(
  size?: string
): number | null {
  const value = (size || '').trim()
  if (!/^[0-9]+$/.test(value)) {
    return null
  }
  const px = Number(value)
  return px >= CLUSTER_BADGE_TEXT_SIZE_MIN_PX &&
    px <= CLUSTER_BADGE_TEXT_SIZE_MAX_PX
    ? px
    : null
}

/** 换算成像素值，供配置弹窗回填输入框。 */
export function resolveClusterBadgeTextPx(size?: string): number {
  return (
    resolveCustomClusterBadgeTextSize(size) ??
    BADGE_TEXT_SIZE_PX[resolveClusterBadgeTextSize(size)]
  )
}

/** 底色上更清晰的前景字色，及其对底色的 WCAG 对比度（1~21）。 */
export interface ClusterBadgeForeground {
  color: string
  contrast: number
}

/**
 * 按自选底色挑前景字色。
 *
 * 底色是管理员填的任意 `#RRGGBB`，写死白字在浅色底上不可读（遗留清单：
 * 语义状态色 token §7.3）。按 WCAG 相对亮度算黑/白两字对该底的对比度取大者，
 * 显示端与配置弹窗的预览走同一函数，所见即所得。
 */
export function resolveClusterBadgeForeground(
  color?: string
): ClusterBadgeForeground {
  const hex = resolveClusterBadgeColor(color).slice(1)
  // sRGB 通道线性化后再按 WCAG 加权（0.03928 是 8 位精度的分界）。
  const channel = (i: number) => {
    const raw = parseInt(hex.slice(i, i + 2), 16) / 255
    return raw <= 0.03928 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4
  }
  const luminance =
    0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
  const black = (luminance + 0.05) / 0.05
  const white = 1.05 / (luminance + 0.05)
  return black > white
    ? { color: '#000000', contrast: black }
    : { color: '#ffffff', contrast: white }
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
 *
 * 字号、加粗与字色是管理员在配置弹窗里选的展示偏好：字号走三档固定值而不是内联
 * font-size，避免把任意数值带进样式；未知档位回落默认档。字色留空时按背景色
 * 自动取黑/白（见 resolveClusterBadgeForeground），保证默认配置一定可读。
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
  const foreground = resolveClusterBadgeForeground(cluster.badgeColor)
  // 管理员填的字色直接进内联样式：非法值（历史数据 / 手工写库）回落自动黑白。
  const customTextColor = cluster.badgeTextColor?.trim()
  const textColor =
    customTextColor && isValidClusterBadgeColor(customTextColor)
      ? customTextColor
      : foreground.color
  const customPx = resolveCustomClusterBadgeTextSize(cluster.badgeTextSize)
  const sizeClass = customPx
    ? 'px-2 py-0.5'
    : CLUSTER_BADGE_TEXT_SIZE_CLASS[
        resolveClusterBadgeTextSize(cluster.badgeTextSize)
      ]

  return (
    <span
      title={text}
      style={{
        backgroundColor: resolveClusterBadgeColor(cluster.badgeColor),
        color: textColor,
        // 自定义字号才走内联样式：值已被限定在 10~24 的整数，不会把任意字符串带进样式。
        ...(customPx
          ? {
              fontSize: `${customPx}px`,
              lineHeight: `${Math.round(customPx * 1.25)}px`,
            }
          : {}),
      }}
      className={cn(
        'inline-flex shrink-0 items-center rounded-full whitespace-nowrap',
        sizeClass,
        cluster.badgeBold ? 'font-bold' : 'font-medium',
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
 * 图标文本显式选定的字号档位。空值表示「自动」——沿用上面按位置自适应的
 * 8/9/11px，这样老集群不选档位时外观不变。
 */
const ICON_TEXT_SIZE_CLASS: Record<ClusterBadgeTextSize, string> = {
  sm: 'h-4 min-w-4 px-1 text-[10px]',
  md: 'h-5 min-w-5 px-1.5 text-xs',
  lg: 'h-6 min-w-6 px-2 text-sm',
}

/** 空值 / 未知值都按「自动」处理。 */
export function resolveClusterBadgeIconTextSize(
  size?: string
): ClusterBadgeTextSize | '' {
  return size === 'sm' || size === 'md' || size === 'lg' ? size : ''
}

/**
 * 集群图标：启用了自定义图标时显示上传的图片，其次是图标文本（带徽章底色的短标签，
 * 最多 6 个汉字，整段显示不截断），都没有时用默认的集群图标。
 *
 * 只认 `badgeIconEnabled`，不要求集群徽章也启用：图标是集群自己的标识，
 * 只换图标不显示说明的集群同样要能看到它（否则上传完界面上毫无变化）。
 * 反过来，开关关着时整块不渲染——默认图标只在开启后才作为「还没选图标」的占位出现。
 *
 * 图标文本的排版与「自定义说明」相互独立：字号不读 `badgeTextSize`，而是自己的
 * `badgeIconTextSize`（空值 = 按传入的 `size` 位置档位自适应）；字重看
 * `badgeIconBold`，底色看 `badgeIconTextBackground`（空值 = 徽章背景色），
 * 字色看 `badgeIconTextColor`（空值/非法值 = 按实际底色自动取黑/白）。
 * 两处都是管理员各自单独设置的。
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
  // 记住加载失败的地址而不是一个布尔值：地址变了（重新上传过）就重试一次，
  // 不会因为上一次 404 而一直显示默认图标。
  const [failedSrc, setFailedSrc] = useState<string | null>(null)

  if (!cluster?.badgeIconEnabled) {
    return null
  }

  const iconSrc = resolveClusterBadgeIconSrc(cluster.badgeIconUrl)
  const iconText = cluster.badgeIconText?.trim()

  if (iconSrc && iconSrc !== failedSrc) {
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

  if (!iconText) {
    return <IconServer className={cn(classes.square, 'shrink-0', className)} />
  }

  const iconTextSize = resolveClusterBadgeIconTextSize(
    cluster.badgeIconTextSize
  )
  // 管理员填写的颜色会直接进内联样式，非法值（历史数据 / 手工写库）回落自动配色。
  const customBackground = cluster.badgeIconTextBackground?.trim()
  // 底色留空时沿用徽章背景色；自动字色要按**实际**底色算，否则换了底色后自动黑白会选错。
  const backgroundColor =
    customBackground && isValidClusterBadgeColor(customBackground)
      ? customBackground
      : resolveClusterBadgeColor(cluster.badgeColor)
  const customTextColor = cluster.badgeIconTextColor?.trim()
  const textColor =
    customTextColor && isValidClusterBadgeColor(customTextColor)
      ? customTextColor
      : resolveClusterBadgeForeground(backgroundColor).color

  return (
    <span
      title={iconText}
      style={{
        backgroundColor,
        color: textColor,
      }}
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded leading-none whitespace-nowrap',
        iconTextSize ? ICON_TEXT_SIZE_CLASS[iconTextSize] : classes.text,
        cluster.badgeIconBold ? 'font-bold' : 'font-medium',
        className
      )}
    >
      {iconText}
    </span>
  )
}
