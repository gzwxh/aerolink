/**
 * 标签页级会话票据。
 *
 * 登录态存在 HttpOnly Cookie 里，是整个浏览器共享的：关掉某一个标签页不会让它失效，
 * 后端也就无从区分「同一次使用的另一个标签」和「关了页面重新进来」。
 * sessionStorage 的生命周期正好是「标签页」——刷新、复制标签、从本页打开的同源新标签
 * 都带着它，标签页一关就没了；所以票据只回答一句话：
 * 「这个标签页在本次存活期间已经过认证」。
 *
 * 票据缺失时再问一句「同浏览器里还有别的标签在用吗」：有就补一张票据
 * （复制链接到新标签、在别的标签里继续操作都算同一次使用），一个都没有才要求重新登录
 * ——也就是「所有页面都关掉之后」。闸门本身在 contexts/auth-context.tsx。
 */

const TICKET_KEY = 'aerolink_tab_session'
const CHANNEL_NAME = 'aerolink-tab-session'

/** 等其它标签回应的上限：太短会把慢标签误判成「已经关了」，太长会拖慢首屏。 */
export const TAB_PROBE_TIMEOUT_MS = 250

interface TabMessage {
  type: 'ping' | 'pong'
  source: string
  to?: string
}

/** 本标签的身份，只用来区分「自己的 ping」与「别人的 pong」。 */
const tabId = createTabId()

function createTabId(): string {
  try {
    if (
      typeof crypto !== 'undefined' &&
      typeof crypto.randomUUID === 'function'
    ) {
      return crypto.randomUUID()
    }
  } catch {
    // 忽略：没有 randomUUID 时用下面这行兜底
  }
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** 本标签是否已经过认证。 */
export function hasTabSession(): boolean {
  try {
    return sessionStorage.getItem(TICKET_KEY) === '1'
  } catch {
    // 存储不可用（隐私策略、被禁用）时当作没有票据，宁可多要一次登录。
    return false
  }
}

/** 记下「本标签已经过认证」。 */
export function markTabSession(): void {
  try {
    sessionStorage.setItem(TICKET_KEY, '1')
  } catch {
    // 记不下时只剩 Cookie 可用；不抛错打断登录流程。
  }
}

/** 登出时清掉本标签的票据。 */
export function clearTabSession(): void {
  try {
    sessionStorage.removeItem(TICKET_KEY)
  } catch {
    // 同上
  }
}

/**
 * 票据缺失时使用：向同浏览器的其它标签广播一次 ping，等有人回 pong。
 * 返回 true 表示至少还有一个标签自称「仍在使用」。
 *
 * 没有 BroadcastChannel（不在浏览器基线内的老浏览器）时直接返回 false：
 * 没有票据又没有旁证，就按需要重新登录处理。
 */
export function probeLiveTabs(
  timeoutMs = TAB_PROBE_TIMEOUT_MS
): Promise<boolean> {
  if (
    typeof window === 'undefined' ||
    typeof BroadcastChannel === 'undefined'
  ) {
    return Promise.resolve(false)
  }
  const channel = new BroadcastChannel(CHANNEL_NAME)
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (live: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      channel.close()
      resolve(live)
    }
    // 只能由异步回调结束探测，所以这里引用尚未初始化的 timer 是安全的。
    const timer = setTimeout(() => finish(false), timeoutMs)
    channel.addEventListener('message', (event: MessageEvent<TabMessage>) => {
      const message = event.data
      if (message?.type === 'pong' && message.to === tabId) finish(true)
    })
    channel.postMessage({ type: 'ping', source: tabId })
  })
}

/**
 * 回应其它标签的 ping。只有仍持有票据的标签才回答：登录页或刚登出的标签保持沉默，
 * 否则一个已经退出的标签就能把别人的新标签「续」上。
 *
 * 返回的函数用于停止回应。
 */
export function startTabSessionResponder(): () => void {
  if (
    typeof window === 'undefined' ||
    typeof BroadcastChannel === 'undefined'
  ) {
    return () => {}
  }
  const channel = new BroadcastChannel(CHANNEL_NAME)
  const onMessage = (event: MessageEvent<TabMessage>) => {
    const message = event.data
    if (!message || message.type !== 'ping' || !message.source) return
    if (message.source === tabId || !hasTabSession()) return
    channel.postMessage({ type: 'pong', source: tabId, to: message.source })
  }
  channel.addEventListener('message', onMessage)
  return () => {
    channel.removeEventListener('message', onMessage)
    channel.close()
  }
}

/**
 * 没有票据时是否必须重新登录：既没有票据，也没有别的活标签。
 * 登录页由调用方单独短路（否则会整页跳转成环），不放进这里。
 */
export function shouldRequireLogin(options: {
  hasTicket: boolean
  hasLivePeer: boolean
}): boolean {
  return !options.hasTicket && !options.hasLivePeer
}
