import {
  addSeconds,
  endOfDay,
  format,
  isValid,
  parse,
  subDays,
  subMonths,
} from 'date-fns'

// 月历网格与通知栏的日期选择器共用（见 lib/date-time.ts）：两个面板必须同一套口径，
// 这里再导出让既有引用（包括单测）不变。
export { monthGridDays } from './date-time'

/**
 * 审计日志时间范围的取值格式：本地时间字符串 `YYYY-MM-DD HH:mm:ss`。
 *
 * 界面上日期框与时间框把这一串拆开编辑（`2026-09-13` + `15:15:49`），
 * 只有拼查询参数时才转成带时区的 RFC3339——后端同时接受 RFC3339 与
 * `YYYY-MM-DD`，前者能表达到秒，后者表示「含当天」。
 */
export const AUDIT_TIME_FORMAT = 'yyyy-MM-dd HH:mm:ss'

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export function isAuditDateOnly(value?: string): value is string {
  return Boolean(value && DATE_ONLY_PATTERN.test(value))
}

/** 解析取值；历史上只存日期的值按当地 0 点解析。解析不出来返回 undefined。 */
export function parseAuditTime(value?: string): Date | undefined {
  if (!value) {
    return undefined
  }
  const parsed = parse(
    isAuditDateOnly(value) ? `${value} 00:00:00` : value,
    AUDIT_TIME_FORMAT,
    new Date()
  )
  return isValid(parsed) ? parsed : undefined
}

export function formatAuditTime(date: Date): string {
  return format(date, AUDIT_TIME_FORMAT)
}

function toRFC3339(date: Date): string {
  return format(date, "yyyy-MM-dd'T'HH:mm:ssxxx")
}

export interface AuditQueryTimeRange {
  from?: string
  to?: string
}

/**
 * 把界面上的取值转成请求参数；空值表示该端不限制。
 *
 * 后端的查询区间是半开的 `[from, to)`，所以「结束时间」按下一秒下发——与传
 * `YYYY-MM-DD` 时后端按次日 0 点处理是同一套口径。否则用户选中的 `23:59:59`
 * 这一整秒里写入的记录会被漏掉。
 */
export function toAuditQueryTimeRange(range: {
  from?: string
  to?: string
}): AuditQueryTimeRange {
  const query: AuditQueryTimeRange = {}
  for (const end of ['from', 'to'] as const) {
    const raw = range[end]
    if (!raw) {
      continue
    }
    const parsed = parseAuditTime(raw)
    // 只给日期的旧值（以及解析不了的值）原样下发：前者由后端按「含当天」处理，
    // 后者交给后端按同一套规则报错。
    if (!parsed || isAuditDateOnly(raw)) {
      query[end] = raw
      continue
    }
    query[end] = toRFC3339(end === 'to' ? addSeconds(parsed, 1) : parsed)
  }
  return query
}

/** 单个月份面板的 42 个格子（6 周 × 7 天，周日起）。见 lib/date-time.ts 的实现。 */

export const AUDIT_TIME_PRESETS = [
  'day',
  'week',
  'month',
  'quarter',
  'halfYear',
  'year',
] as const

export type AuditTimePreset = (typeof AUDIT_TIME_PRESETS)[number]

/**
 * 快捷范围的取值：起点按当前时刻往前推，终点取当天 23:59:59，
 * 这样「最近一周」这类说法包含今天。
 */
export function presetTimeRange(
  preset: AuditTimePreset,
  now = new Date()
): { from: string; to: string } {
  const start =
    preset === 'day'
      ? subDays(now, 1)
      : preset === 'week'
        ? subDays(now, 7)
        : preset === 'month'
          ? subMonths(now, 1)
          : preset === 'quarter'
            ? subMonths(now, 3)
            : preset === 'halfYear'
              ? subMonths(now, 6)
              : subMonths(now, 12)
  return { from: formatAuditTime(start), to: formatAuditTime(endOfDay(now)) }
}

/**
 * 日志页的默认时间范围：最近一周。
 *
 * 界面上一进来就要显示具体区间（而不是「请选择时间范围」的占位），列表与导出也
 * 按同一个值过滤——只看不查会让显示与实际查询对不上。
 */
export function defaultAuditTimeRange(now = new Date()): {
  from: string
  to: string
} {
  return presetTimeRange('week', now)
}
