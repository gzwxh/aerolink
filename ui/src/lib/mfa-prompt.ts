/**
 * API 客户端（在敏感请求上遇到 `mfa_verification_required`）与
 * 应用外壳渲染的 MFA 提示对话框之间的桥梁。
 */
export const MFA_PROMPT_EVENT = 'kite:mfa-prompt'

/**
 * 请求打开用户信息页的「安全」页签（由应用壳里的 UserMenu 监听并跳转）。
 * 目前用于超级管理员的 MFA 引导：提示横幅点「立即绑定」时触发。
 */
export const MFA_SETUP_REQUEST_EVENT = 'kite:mfa-setup-request'

export function requestMFASetup() {
  window.dispatchEvent(new Event(MFA_SETUP_REQUEST_EVENT))
}

type Resolver = (verified: boolean) => void

let pendingResolver: Resolver | null = null

/** 用户验证通过后 resolve 为 `true`，被关闭时为 `false`。 */
export function requestMFAVerification(): Promise<boolean> {
  return new Promise((resolve) => {
    pendingResolver = resolve
    window.dispatchEvent(new Event(MFA_PROMPT_EVENT))
  })
}

export function resolveMFAVerification(verified: boolean) {
  pendingResolver?.(verified)
  pendingResolver = null
}
