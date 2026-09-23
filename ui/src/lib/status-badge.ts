/**
 * 状态徽标的统一口径。
 *
 * 规则（见 AGENTS.md「状态色一律用语义 token」）：
 *   - 软底 + 语义色描边，跟随配色主题，也落在 theme-contrast 的对比度口径内；
 *   - **不要**再用 `variant="default"`（品牌色不是状态色，换主题就飘）或
 *     `variant="destructive"`（实心红底白字，密集列表里会盖过内容本身）。
 *
 * 用法：
 *   const badge = statusBadge('success')
 *   <Badge variant={badge.variant} className={badge.className}>{...}</Badge>
 */

export type BadgeTone =
  /** 成功 / 正常 / 已启用。 */
  | 'success'
  /** 失败 / 错误 / 拒绝 / 待删除。 */
  | 'failure'
  /** 进行中 / 新增（信息）。 */
  | 'info'
  /** 需留意（未失败）。 */
  | 'warning'
  /** 过渡态（Terminating、暂停等）。 */
  | 'attention'

export interface StatusBadgeStyle {
  variant: 'outline' | 'secondary'
  className: string
}

const TONE_CLASS: Record<BadgeTone, string> = {
  success: 'bg-success/10 text-success border-success/25',
  failure: 'bg-destructive/10 text-destructive border-destructive/25',
  info: 'bg-info/10 text-info border-info/25',
  warning: 'bg-warning/10 text-warning border-warning/25',
  attention: 'bg-attention/10 text-attention border-attention/25',
}

const TONE_TEXT: Record<BadgeTone, string> = {
  success: 'text-success',
  failure: 'text-destructive',
  info: 'text-info',
  warning: 'text-warning',
  attention: 'text-attention',
}

/**
 * 纯文字状态色：只上色，不带徽标的底色与描边。
 *
 * 用于「结果」这类以文字为主的状态列——一列徽标框在密集的日志表里显得很重。
 */
export function statusText(tone: BadgeTone): string {
  return TONE_TEXT[tone]
}

/** 布尔型结果的纯文字色：成功 / 失败。 */
export function outcomeText(success: boolean): string {
  return statusText(success ? 'success' : 'failure')
}

/** 中性徽标：只描边、不带状态色（来源、类型、数量这类非状态信息）。 */
export function neutralBadge(): StatusBadgeStyle {
  return { variant: 'outline', className: '' }
}

/** 按语义取一个状态徽标样式。 */
export function statusBadge(tone: BadgeTone): StatusBadgeStyle {
  return { variant: 'outline', className: TONE_CLASS[tone] }
}

/** 布尔型结果（审计状态列、资源历史的执行结果）：成功 / 失败。 */
export function outcomeBadge(success: boolean): StatusBadgeStyle {
  return statusBadge(success ? 'success' : 'failure')
}

/**
 * K8s 写操作类型的徽标。
 *
 * 只有「新增」与「删除」带语义色，修改与查询保持中性——一行里堆四五种颜色反而看不出重点。
 */
export function operationTypeBadge(operationType: string): StatusBadgeStyle {
  switch (operationType.toLowerCase()) {
    case 'create':
      return statusBadge('info')
    case 'delete':
      return statusBadge('failure')
    default:
      return neutralBadge()
  }
}
