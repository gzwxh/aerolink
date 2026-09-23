import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  consumeLoginRedirectBudget,
  getServiceStatus,
  markLoginRedirectLoop,
  reportApiFailure,
  reportApiSuccess,
  resetServiceStatusForTest,
  retryService,
} from './service-status'

describe('service-status', () => {
  beforeEach(() => {
    resetServiceStatusForTest()
    vi.useRealTimers()
  })

  it('连续失败达到阈值才判为不可用', () => {
    reportApiFailure('server')
    reportApiFailure('server')
    // 偶发失败不该惊动用户：只有连续失败才标记。
    expect(getServiceStatus().unavailable).toBe(false)

    reportApiFailure('server')
    expect(getServiceStatus()).toMatchObject({
      unavailable: true,
      reason: 'server',
      attempts: 3,
    })
  })

  it('一次成功即清零并恢复', () => {
    for (let i = 0; i < 3; i += 1) {
      reportApiFailure('network')
    }
    expect(getServiceStatus().unavailable).toBe(true)

    reportApiSuccess()
    expect(getServiceStatus()).toEqual({
      unavailable: false,
      reason: null,
      attempts: 0,
    })
  })

  // 这条是「不要一直刷新」的核心防线：整页跳转会重置所有模块级状态，
  // 只有 sessionStorage 里的时间戳能记住刚刚跳过。
  it('跳转预算：窗口内跳两次后拒绝第三次', () => {
    expect(consumeLoginRedirectBudget()).toBe(true)
    expect(consumeLoginRedirectBudget()).toBe(true)
    expect(consumeLoginRedirectBudget()).toBe(false)
  })

  it('窗口过去后额度恢复', () => {
    vi.useFakeTimers()
    expect(consumeLoginRedirectBudget()).toBe(true)
    expect(consumeLoginRedirectBudget()).toBe(true)
    expect(consumeLoginRedirectBudget()).toBe(false)

    vi.advanceTimersByTime(31_000)
    expect(consumeLoginRedirectBudget()).toBe(true)
  })

  it('成环标记写进 sessionStorage，用户显式重试后清除', () => {
    markLoginRedirectLoop()
    expect(window.sessionStorage.getItem('aerolink:login-redirect-loop')).toBe(
      '1'
    )
    expect(getServiceStatus().reason).toBe('redirectLoop')

    retryService()
    expect(
      window.sessionStorage.getItem('aerolink:login-redirect-loop')
    ).toBeNull()
    expect(getServiceStatus().unavailable).toBe(false)
  })

  it('成环后不因单次成功而解除阻断（需用户显式操作）', () => {
    markLoginRedirectLoop()
    reportApiSuccess()
    expect(getServiceStatus().reason).toBe('redirectLoop')
  })
})
