import { describe, expect, it } from 'vitest'

import {
  defaultAuditTimeRange,
  formatAuditTime,
  monthGridDays,
  parseAuditTime,
  presetTimeRange,
  toAuditQueryTimeRange,
} from './audit-time-range'

describe('parseAuditTime / formatAuditTime', () => {
  it('本地时间字符串往返不变', () => {
    const parsed = parseAuditTime('2026-09-13 15:15:49')

    expect(parsed).toBeInstanceOf(Date)
    expect(formatAuditTime(parsed as Date)).toBe('2026-09-13 15:15:49')
  })

  it('只给日期的值按当天 0 点解析', () => {
    expect(formatAuditTime(parseAuditTime('2026-09-13') as Date)).toBe(
      '2026-09-13 00:00:00'
    )
  })

  it('空值与解析不了的值返回 undefined', () => {
    expect(parseAuditTime(undefined)).toBeUndefined()
    expect(parseAuditTime('')).toBeUndefined()
    expect(parseAuditTime('2026/09/13 15:15:49')).toBeUndefined()
  })
})

describe('toAuditQueryTimeRange', () => {
  it('转成带时区偏移的 RFC3339', () => {
    const query = toAuditQueryTimeRange({ from: '2026-09-13 15:15:49' })

    expect(query.from).toMatch(/^2026-09-13T15:15:49[+-]\d{2}:\d{2}$/)
  })

  // 后端按半开区间 [from, to) 查询，结束时间要下发到下一秒，否则用户选中的
  // 23:59:59 这一整秒里写入的审计记录会被漏掉。
  it('结束时间按下一秒下发（闭区间语义）', () => {
    const query = toAuditQueryTimeRange({ to: '2026-09-21 23:59:59' })

    expect(query.to).toMatch(/^2026-09-22T00:00:00[+-]\d{2}:\d{2}$/)
  })

  it('只给日期的旧值原样下发，仍由后端按含当天处理', () => {
    expect(
      toAuditQueryTimeRange({ from: '2026-09-13', to: '2026-09-21' })
    ).toEqual({ from: '2026-09-13', to: '2026-09-21' })
  })

  it('未设置的端点不下发', () => {
    expect(toAuditQueryTimeRange({})).toEqual({})
  })
})

describe('monthGridDays', () => {
  it('固定 6 周 42 格，首格是所在周的周日', () => {
    // 2026-09-01 是周二，所以网格从 2026-08-30（周日）开始。
    const days = monthGridDays(new Date(2026, 8, 1))

    expect(days).toHaveLength(42)
    expect(days[0].getDay()).toBe(0)
    expect(days[0]).toEqual(new Date(2026, 7, 30))
    expect(days[41]).toEqual(new Date(2026, 9, 10))
  })
})

describe('presetTimeRange', () => {
  const now = new Date(2026, 8, 21, 15, 15, 49)

  it('起点按当前时刻前推，终点取当天最后一秒', () => {
    expect(presetTimeRange('day', now)).toEqual({
      from: '2026-09-20 15:15:49',
      to: '2026-09-21 23:59:59',
    })
    expect(presetTimeRange('week', now).from).toBe('2026-09-14 15:15:49')
  })

  it('月以上的范围按月份回退', () => {
    expect(presetTimeRange('month', now).from).toBe('2026-08-21 15:15:49')
    expect(presetTimeRange('quarter', now).from).toBe('2026-06-21 15:15:49')
    expect(presetTimeRange('halfYear', now).from).toBe('2026-03-21 15:15:49')
    expect(presetTimeRange('year', now).from).toBe('2025-09-21 15:15:49')
  })
})

describe('defaultAuditTimeRange', () => {
  // 日志页一进来就要显示具体区间（最近一周），而不是灰字占位。
  it('默认取最近一周', () => {
    expect(defaultAuditTimeRange(new Date(2026, 8, 21, 15, 15, 49))).toEqual({
      from: '2026-09-14 15:15:49',
      to: '2026-09-21 23:59:59',
    })
  })
})
