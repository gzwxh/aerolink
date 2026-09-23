/**
 * 全局服务状态：把「请求连续失败」聚合成一个可订阅的状态，让界面**显示异常并停止自动重试**，
 * 而不是无声地一直刷。
 *
 * 三条设计约束（都是踩过的坑）：
 *   1. 连续失败达到阈值才判为不可用——单个请求偶发失败（502、连接被重置）不该惊动用户；
 *   2. 判为不可用时把 react-query 的 `onlineManager` 置为离线：所有查询（含带
 *      refetchInterval 的轮询、失败重试）都会暂停，等恢复或用户手动重试。
 *      这是「不要一直刷新」的关键，光弹提示挡不住轮询；
 *   3. 登录跳转带预算：前后端会话判定一旦不一致，首页与登录页会互相整页跳转、无限刷新
 *      （见 api-client.ts 的 redirectToLogin）。超预算就不再跳转，改为显示阻断页。
 */

import { onlineManager } from '@tanstack/react-query'

/** 状态变化事件名：供 useSyncExternalStore 订阅。 */
export const SERVICE_STATUS_EVENT = 'aerolink:service-status'

/** 不可用的原因。 */
export type ServiceUnavailableReason =
  /** 服务端返回 5xx。 */
  | 'server'
  /** 请求发不出去（断网、连接被拒、超时）。 */
  | 'network'
  /** 会话反复失效导致登录跳转成环。 */
  | 'redirectLoop'

export interface ServiceStatus {
  unavailable: boolean
  reason: ServiceUnavailableReason | null
  /** 连续失败次数，用于文案与诊断。 */
  attempts: number
}

/** 连续失败多少次判为不可用。 */
const FAILURE_THRESHOLD = 3
/** 跳转预算：窗口内最多跳这么多次，超过即认为成环。 */
const REDIRECT_BUDGET = 2
const REDIRECT_WINDOW_MS = 30_000
const REDIRECT_TIMES_KEY = 'aerolink:login-redirect-times'
/** 成环标记。必须跨整页跳转保留，所以放 sessionStorage（关掉标签页即清）。 */
const REDIRECT_LOOP_KEY = 'aerolink:login-redirect-loop'

const listeners = new Set<() => void>()

/** 是否由本模块暂停了查询（用于恢复时避免覆盖浏览器自身的离线状态）。 */
let pausedByUs = false

let status: ServiceStatus = readInitialStatus()

function readInitialStatus(): ServiceStatus {
  // 上一轮整页跳转判定成环：这次加载直接显示阻断页，不再参与跳转。
  if (readSession(REDIRECT_LOOP_KEY) === '1') {
    return { unavailable: true, reason: 'redirectLoop', attempts: 0 }
  }
  return { unavailable: false, reason: null, attempts: 0 }
}

function readSession(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key)
  } catch {
    // 隐私模式等场景下 storage 不可用：退化成「没有标记」，不影响主流程。
    return null
  }
}

function writeSession(key: string, value: string | null) {
  try {
    if (value === null) {
      window.sessionStorage.removeItem(key)
    } else {
      window.sessionStorage.setItem(key, value)
    }
  } catch {
    // 同上：写不进去只是失去跨整页跳转的记忆，不该让功能报错。
  }
}

function publish(next: ServiceStatus) {
  status = next
  listeners.forEach((listener) => listener())
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(SERVICE_STATUS_EVENT))
  }
}

/** 暂停所有查询（含轮询）：不可用时不该继续敲一个已经挂掉的服务。 */
function pauseQueries() {
  if (pausedByUs) return
  pausedByUs = true
  onlineManager.setOnline(false)
}

/** 恢复查询：用户点「重试」或服务自行恢复时调用。 */
function resumeQueries() {
  if (!pausedByUs) return
  pausedByUs = false
  onlineManager.setOnline(true)
}

export function getServiceStatus(): ServiceStatus {
  return status
}

export function subscribeServiceStatus(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 一次请求成功：清零失败计数并恢复查询。 */
export function reportApiSuccess() {
  if (status.unavailable && status.reason === 'redirectLoop') {
    // 成环阻断由用户显式操作（重新登录/重试）解除，避免自动抖动。
    return
  }
  resumeQueries()
  if (!status.unavailable && status.attempts === 0) {
    return
  }
  publish({ unavailable: false, reason: null, attempts: 0 })
}

/** 一次请求失败（5xx 或网络层）。达到阈值即标记不可用并暂停查询。 */
export function reportApiFailure(reason: Exclude<ServiceUnavailableReason, 'redirectLoop'>) {
  if (status.unavailable && status.reason === 'redirectLoop') {
    return
  }
  const attempts = status.attempts + 1
  if (attempts < FAILURE_THRESHOLD) {
    publish({ unavailable: false, reason: status.reason, attempts })
    return
  }
  if (status.unavailable && status.reason === reason && status.attempts === attempts) {
    return
  }
  pauseQueries()
  publish({ unavailable: true, reason, attempts })
}

/**
 * 申请一次「跳转登录页」的额度。
 *
 * 返回 false 表示窗口内已经跳够了（跳转成环），调用方应当改为显示阻断页而不是继续跳——
 * 整页跳转会重置所有模块级状态，只有 sessionStorage 里的时间戳能记住「刚刚跳过」。
 */
export function consumeLoginRedirectBudget(): boolean {
  const now = Date.now()
  const times = (readSession(REDIRECT_TIMES_KEY) || '')
    .split(',')
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isFinite(value) && now - value < REDIRECT_WINDOW_MS)

  if (times.length >= REDIRECT_BUDGET) {
    writeSession(REDIRECT_TIMES_KEY, times.join(','))
    return false
  }

  times.push(now)
  writeSession(REDIRECT_TIMES_KEY, times.join(','))
  return true
}

/** 标记「登录跳转成环」：本次加载显示阻断页，直到用户显式操作。 */
export function markLoginRedirectLoop() {
  writeSession(REDIRECT_LOOP_KEY, '1')
  publish({ unavailable: true, reason: 'redirectLoop', attempts: 0 })
}

/** 用户点「重试」：清掉所有异常标记并恢复查询。 */
export function retryService() {
  writeSession(REDIRECT_LOOP_KEY, null)
  writeSession(REDIRECT_TIMES_KEY, null)
  resumeQueries()
  publish({ unavailable: false, reason: null, attempts: 0 })
}

/** 测试用：重置模块状态。 */
export function resetServiceStatusForTest() {
  writeSession(REDIRECT_LOOP_KEY, null)
  writeSession(REDIRECT_TIMES_KEY, null)
  pausedByUs = false
  status = { unavailable: false, reason: null, attempts: 0 }
}
