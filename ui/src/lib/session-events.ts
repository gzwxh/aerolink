/**
 * 会话被顶下线的全局通知：单点登录（singleDeviceLogin）开启时，账号在别处登录会让
 * 旧会话的请求收到 401 session_superseded。此时不能静默刷新 + 直接跳登录页——
 * 用户看不到任何解释，因此由 api-client 派发事件、由全局弹窗给提示。
 */
export const SESSION_SUPERSEDED_EVENT = 'aerolink:session-superseded'

// 并发的失败请求会同时收到 401：只提示一次。
let notified = false

export function notifySessionSuperseded() {
  if (notified) return
  notified = true
  window.dispatchEvent(new Event(SESSION_SUPERSEDED_EVENT))
}

/** 用户确认后重置标记（下一次顶下线仍会提示）。 */
export function resetSessionSupersededNotice() {
  notified = false
}
