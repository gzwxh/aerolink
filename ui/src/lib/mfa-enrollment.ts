import type { AuthUser } from '@/lib/api'

/**
 * 账号能否在 AeroLink 里自助绑定动态码（MFA）。
 *
 * 与后端 `model.(*User).CanSelfEnrollMFA` 保持一致：只有本地密码账号与 LDAP 账号
 * 在绑定的第一步能做再认证。OIDC 等外部身份源的二次验证由 IdP 负责，AeroLink 既不提供
 * 绑定入口，也不把它们算进「必须绑定」的范围（否则用户会卡在走不完的向导里）。
 */
export function canSelfEnrollMFA(user?: AuthUser | null): boolean {
  const provider = user?.provider
  return !provider || provider === 'password' || provider === 'ldap'
}

/**
 * 绑定的再认证方式：本地密码账号提交当前密码；
 * LDAP 账号在 AeroLink 侧没有口令，改用「最近重新登录过」（后端据此回 `mfa_reauth_required`）。
 */
export function mfaEnrollmentNeedsPassword(user?: AuthUser | null): boolean {
  return (user?.provider ?? '') !== 'ldap'
}

/** 后端要求「先退出并重新登录再绑定」时的错误码（见 pkg/users/handler.go）。 */
export function isMFAReauthRequired(error: unknown): boolean {
  return (
    (error as { code?: string } | null | undefined)?.code ===
    'mfa_reauth_required'
  )
}
