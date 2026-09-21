import { describe, expect, it } from 'vitest'

import {
  dayKey,
  formatDateTimeShort,
  fromRFC3339,
  monthGridDays,
  parseDateTime,
  toRFC3339,
} from './date-time'

describe('parseDateTime / formatDateTimeShort', () => {
  it('按本地时间解析，展示时去掉秒', () => {
    const parsed = parseDateTime('2026-09-21 22:30:15')
    expect(parsed).toBeInstanceOf(Date)
    expect(parsed?.getHours()).toBe(22)
    expect(formatDateTimeShort('2026-09-21 22:30:15')).toBe('2026-09-21 22:30')
  })

  it('空值与不合法的值都返回空', () => {
    expect(parseDateTime('')).toBeUndefined()
    expect(parseDateTime(undefined)).toBeUndefined()
    expect(parseDateTime('明天')).toBeUndefined()
    expect(formatDateTimeShort('')).toBe('')
  })
})

describe('toRFC3339 / fromRFC3339', () => {
  // 提交给服务端的是带偏移的 RFC3339：服务端与浏览器时区不一致也不会存错时刻。
  it('本地时间转成带偏移的 RFC3339', () => {
    expect(toRFC3339('2026-09-21 22:30:15')).toBe(
      '2026-09-21T22:30:15+08:00'.replace('+08:00', offset())
    )
  })

  it('空值不产生取值', () => {
    expect(toRFC3339('')).toBeUndefined()
    expect(fromRFC3339(undefined)).toBe('')
  })

  it('与服务端取值往返一致', () => {
    const local = '2026-09-21 22:30:15'
    const rfc = toRFC3339(local)
    expect(rfc).toBeDefined()
    expect(fromRFC3339(rfc)).toBe(local)
  })

  it('解析不了的取值返回空串，不抛错', () => {
    expect(fromRFC3339('not-a-date')).toBe('')
  })
})

describe('monthGridDays / dayKey', () => {
  it('固定 6 周 42 格，首格是所在周的周日', () => {
    // 2026-09-01 是周二，所以网格从 2026-08-30（周日）开始。
    const days = monthGridDays(new Date(2026, 8, 1))

    expect(days).toHaveLength(42)
    expect(days[0].getDay()).toBe(0)
    expect(dayKey(days[0])).toBe('2026-08-30')
    expect(dayKey(days[41])).toBe('2026-10-10')
  })
})

/** 当前时区的偏移，形如 `+08:00`；用来避免断言把测试绑死在某个时区上。 */
function offset(): string {
  const minutes = -new Date().getTimezoneOffset()
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}
