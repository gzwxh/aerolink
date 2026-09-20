/**
 * 登录页开头那段判断：什么时候可以「直接跳走」。
 *
 * 平时只要浏览器里已经有登录态就跳走——用户已经登录，没必要再看登录页。
 * 两种情况必须留下来：
 *
 * - `forcedLogin`：被顶下线后点「重新登录」，带着 `forced=1` 回到登录页；
 * - `pendingMfaTicket`：第三方登录（OIDC）的回调只发了「待验证」票据、**没有**发登录态，
 *   必须留在登录页补验动态码。若此时浏览器里还留着旧会话就跳走，这次登录会被旧登录态
 *   静默跳过，用户看到的现象是「我点了登录，却没让我输验证码」。
 */
export function shouldLeaveLoginPage(options: {
  hasUser: boolean
  isLoading: boolean
  forcedLogin: boolean
  pendingMfaTicket: string
}): boolean {
  if (options.isLoading || !options.hasUser) {
    return false
  }
  if (options.forcedLogin || options.pendingMfaTicket) {
    return false
  }
  return true
}
