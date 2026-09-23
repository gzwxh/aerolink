import { describe, expect, it } from 'vitest'

import {
  isLoginSuccess,
  LOGIN_RESULT_SUCCESS,
  outcomeText,
  statusText,
} from './status-badge'

describe('isLoginSuccess', () => {
  it('后端的成功值判为成功', () => {
    expect(isLoginSuccess(LOGIN_RESULT_SUCCESS)).toBe(true)
    // 大小写不敏感：历史写入出现过大小写漂移，不该因此染成失败色。
    expect(isLoginSuccess('SUCCESS')).toBe(true)
  })

  it('空/缺失判为成功：result 是后加的列，历史记录为空', () => {
    expect(isLoginSuccess(null)).toBe(true)
    expect(isLoginSuccess(undefined)).toBe(true)
    expect(isLoginSuccess('')).toBe(true)
  })

  it('失败码判为失败', () => {
    for (const code of [
      'invalid_credentials',
      'mfa_invalid',
      'ip_denied',
      'too_many_attempts',
      'no_permission',
    ]) {
      expect(isLoginSuccess(code)).toBe(false)
    }
  })
})

describe('状态色口径', () => {
  it('成功走 success、失败走 destructive 语义色', () => {
    expect(statusText('success')).toContain('text-success')
    expect(statusText('failure')).toContain('text-destructive')
    expect(outcomeText(true)).toBe(statusText('success'))
    expect(outcomeText(false)).toBe(statusText('failure'))
  })
})
