import { describe, expect, it } from 'vitest'

import type { AuthUser } from '@/lib/api'

import {
  canSelfEnrollMFA,
  isMFAReauthRequired,
  mfaEnrollmentNeedsPassword,
} from './mfa-enrollment'

const authUser = (provider: string): AuthUser => ({
  id: '1',
  username: 'alice',
  name: 'Alice',
  avatar_url: '',
  provider,
})

// 与后端 model.(*User).CanSelfEnrollMFA / pkg/users/handler.go 的口径对齐：
// 能自助绑定的只有本地密码账号（含 provider 为空的历史账号）与 LDAP 账号。
describe('自助绑定动态码的账号范围', () => {
  it('本地密码账号可以自助绑定', () => {
    expect(canSelfEnrollMFA(authUser('password'))).toBe(true)
    expect(canSelfEnrollMFA(authUser(''))).toBe(true)
    expect(canSelfEnrollMFA(null)).toBe(true)
  })

  it('LDAP 账号可以自助绑定', () => {
    expect(canSelfEnrollMFA(authUser('ldap'))).toBe(true)
  })

  it('OIDC 等外部身份源不能自助绑定', () => {
    expect(canSelfEnrollMFA(authUser('oidc'))).toBe(false)
    expect(canSelfEnrollMFA(authUser('mockidp'))).toBe(false)
  })
})

describe('绑定的再认证方式', () => {
  it('只有 LDAP 账号不用提交本地密码', () => {
    expect(mfaEnrollmentNeedsPassword(authUser('ldap'))).toBe(false)
    expect(mfaEnrollmentNeedsPassword(authUser('password'))).toBe(true)
    expect(mfaEnrollmentNeedsPassword(authUser(''))).toBe(true)
    expect(mfaEnrollmentNeedsPassword(null)).toBe(true)
  })
})

describe('重新登录错误码识别', () => {
  it('只认 mfa_reauth_required', () => {
    expect(isMFAReauthRequired({ code: 'mfa_reauth_required' })).toBe(true)
    expect(isMFAReauthRequired({ code: 'mfa_pending_invalid' })).toBe(false)
    expect(isMFAReauthRequired(new Error('boom'))).toBe(false)
    expect(isMFAReauthRequired(null)).toBe(false)
  })
})
