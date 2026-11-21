import { describe, expect, it } from 'vitest'

import {
  checkScaleDraft,
  SCALE_CONFIRM_AT,
  scaleBlockedForSubmission,
} from './scale-guard'

// 回归（缺陷 D-70）：扩缩容框原先 `parseInt(v) || 0`，非数字与空都静默变成 0，
// 点一下就真的把服务缩到 0，负数则发给 apiserver 换一句 500 英文原文。
describe('checkScaleDraft', () => {
  it('空值与非整数一律拦住，不再当成 0', () => {
    for (const input of ['abc', '1.5', '-1', '1e3', '  1 2 ']) {
      const check = checkScaleDraft({ input, current: 2 })
      expect(check.kind).toBe('invalid')
      if (check.kind === 'invalid') {
        expect(check.messageKey).toBe('detail.scale.notInteger')
      }
    }
    // 空串与纯空格同档：都是「还没填」，提示要说该填什么
    for (const input of ['', '   ']) {
      const empty = checkScaleDraft({ input, current: 2 })
      expect(empty.kind).toBe('invalid')
      if (empty.kind === 'invalid') {
        expect(empty.messageKey).toBe('detail.scale.empty')
      }
    }
  })

  it('大到超出安全整数的写法也拦住（避免静默变成奇怪数字）', () => {
    expect(
      checkScaleDraft({ input: '999999999999999999999', current: 2 }).kind
    ).toBe('invalid')
  })

  it('从有到无必须显式确认', () => {
    const check = checkScaleDraft({ input: '0', current: 2 })
    expect(check.kind).toBe('needsConfirm')
    if (check.kind === 'needsConfirm') {
      expect(check.messageKey).toBe('detail.scale.confirmZero')
      expect(check.replicas).toBe(0)
    }
  })

  it('本来就是 0 时再次提交 0 不需要确认（不拦重复保存）', () => {
    expect(checkScaleDraft({ input: '0', current: 0 })).toEqual({
      kind: 'ready',
      replicas: 0,
    })
  })

  it('一次放大到很多副本也要确认', () => {
    const check = checkScaleDraft({
      input: String(SCALE_CONFIRM_AT),
      current: 2,
    })
    expect(check.kind).toBe('needsConfirm')
    if (check.kind === 'needsConfirm') {
      expect(check.messageKey).toBe('detail.scale.confirmLarge')
    }
    expect(
      checkScaleDraft({ input: String(SCALE_CONFIRM_AT - 1), current: 2 })
    ).toEqual({ kind: 'ready', replicas: SCALE_CONFIRM_AT - 1 })
  })

  it('普通改副本直接放行', () => {
    expect(checkScaleDraft({ input: '3', current: 2 })).toEqual({
      kind: 'ready',
      replicas: 3,
    })
  })
})

// 回归：上一版按钮的 disabled 与 handler 的守卫各写一套判据，
// 勾选确认后按钮解禁了但 handler 仍 return，缩到 0 成了「可点但无反应」。
// 两处必须共用 scaleBlockedForSubmission。
describe('scaleBlockedForSubmission', () => {
  it('非法值无论有没有勾选都拦住', () => {
    const check = checkScaleDraft({ input: 'abc', current: 2 })
    expect(scaleBlockedForSubmission(check, false)).toBe(true)
    expect(scaleBlockedForSubmission(check, true)).toBe(true)
  })

  it('危险值：未勾选拦住，勾选后就该放行', () => {
    for (const input of ['0', String(SCALE_CONFIRM_AT)]) {
      const check = checkScaleDraft({ input, current: 2 })
      expect(check.kind).toBe('needsConfirm')
      expect(scaleBlockedForSubmission(check, false)).toBe(true)
      expect(scaleBlockedForSubmission(check, true)).toBe(false)
    }
  })

  it('普通值不需要勾选', () => {
    expect(
      scaleBlockedForSubmission(
        checkScaleDraft({ input: '3', current: 2 }),
        false
      )
    ).toBe(false)
  })
})
