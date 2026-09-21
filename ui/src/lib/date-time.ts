import {
  addDays,
  format,
  isValid,
  parse,
  startOfMonth,
  startOfWeek,
} from 'date-fns'

/**
 * 日期时间取值与格式转换。
 *
 * 界面里编辑的是**本地时间字符串**（与审计页的时间筛选同一口径）：`YYYY-MM-DD HH:mm:ss`，
 * 空串表示未设置。提交给服务端时转成带时区偏移的 RFC3339，读回来时再转回本地字符串，
 * 这样浏览器与服务端时区不一致也不会把时间存错。
 */
export const DATE_TIME_FORMAT = 'yyyy-MM-dd HH:mm:ss'

const DATE_ONLY_FORMAT = 'yyyy-MM-dd'

/** 本地时间字符串 → 展示用（去掉秒，界面上秒没有意义）。 */
export function formatDateTimeShort(localValue?: string): string {
  const parsed = parseDateTime(localValue)
  return parsed ? format(parsed, 'yyyy-MM-dd HH:mm') : ''
}

export function formatDateTime(date: Date): string {
  return format(date, DATE_TIME_FORMAT)
}

export function parseDateTime(value?: string): Date | undefined {
  if (!value) {
    return undefined
  }
  const parsed = parse(value, DATE_TIME_FORMAT, new Date())
  return isValid(parsed) ? parsed : undefined
}

/** 本地时间字符串 → RFC3339（带偏移）；空或无法解析时返回 undefined。 */
export function toRFC3339(localValue?: string): string | undefined {
  const parsed = parseDateTime(localValue)
  return parsed ? format(parsed, "yyyy-MM-dd'T'HH:mm:ssxxx") : undefined
}

/** 服务端返回的 RFC3339 时刻 → 本地可编辑字符串；解析不了时返回空串。 */
export function fromRFC3339(value?: string): string {
  if (!value) {
    return ''
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? '' : formatDateTime(parsed)
}

export function dayKey(value: Date): string {
  return format(value, DATE_ONLY_FORMAT)
}

/**
 * 月历网格：固定 6 周 42 格，首格是所在周的周日。
 * 与审计页的时间范围选择器（lib/audit-time-range.ts 从这里再导出）共用同一套口径。
 */
export function monthGridDays(month: Date): Date[] {
  const first = startOfWeek(startOfMonth(month), { weekStartsOn: 0 })
  return Array.from({ length: 42 }, (_, index) => addDays(first, index))
}
