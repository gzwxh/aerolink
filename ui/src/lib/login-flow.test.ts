import { describe, expect, it } from 'vitest'

import { shouldLeaveLoginPage } from './login-flow'

const loggedIn = {
  hasUser: true,
  isLoading: false,
  forcedLogin: false,
  pendingMfaTicket: '',
}

describe('shouldLeaveLoginPage', () => {
  it('已登录时直接跳走', () => {
    expect(shouldLeaveLoginPage(loggedIn)).toBe(true)
  })

  it('登录态还没读出来时不跳走', () => {
    expect(shouldLeaveLoginPage({ ...loggedIn, isLoading: true })).toBe(false)
  })

  it('未登录时不跳走', () => {
    expect(shouldLeaveLoginPage({ ...loggedIn, hasUser: false })).toBe(false)
  })

  it('被顶下线强制回登录页时不跳走', () => {
    expect(shouldLeaveLoginPage({ ...loggedIn, forcedLogin: true })).toBe(false)
  })

  it('带着第三方登录的待验证票据时不跳走，即使浏览器里还留着旧登录态', () => {
    expect(
      shouldLeaveLoginPage({ ...loggedIn, pendingMfaTicket: 'some-ticket' })
    ).toBe(false)
  })
})
