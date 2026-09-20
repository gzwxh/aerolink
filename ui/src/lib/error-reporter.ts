import i18n from '@/i18n'

import { API_BASE_URL } from './api-client'
import { queryClient } from './query-provider'
import { withSubPath } from './subpath'

const QUEUE_KEY = 'kite_pending_error_reports'
const LAST_FINGERPRINT_KEY = 'kite_last_error_report'
const MAX_QUEUE = 20
// 相同指纹（标题+详情+页面）在该时间窗内只记一条站内信，避免用户反复重试
// 或中央/组件两处同时上报造成消息刷屏。
const DEDUP_WINDOW_MS = 5 * 60 * 1000

interface ClientErrorReport {
  title: string
  detail: string
  path: string
}

function fingerprint(report: ClientErrorReport): string {
  return `${report.path}\n${report.title}\n${report.detail}`
}

function isDuplicate(report: ClientErrorReport): boolean {
  try {
    const raw = localStorage.getItem(LAST_FINGERPRINT_KEY)
    if (!raw) return false
    const last = JSON.parse(raw) as { fp: string; ts: number }
    return (
      last.fp === fingerprint(report) && Date.now() - last.ts < DEDUP_WINDOW_MS
    )
  } catch {
    return false
  }
}

function markReported(report: ClientErrorReport) {
  try {
    localStorage.setItem(
      LAST_FINGERPRINT_KEY,
      JSON.stringify({ fp: fingerprint(report), ts: Date.now() })
    )
  } catch {
    // 存储不可用——去重直接不生效。
  }
}

function readQueue(): ClientErrorReport[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeQueue(queue: ClientErrorReport[]) {
  try {
    // 限制队列长度，避免长时间离线时无限增长。
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-MAX_QUEUE)))
  } catch {
    // 存储不可用（隐私模式等）——静默丢弃该上报。
  }
}

async function postReport(report: ClientErrorReport): Promise<boolean> {
  try {
    const response = await fetch(
      withSubPath(`${API_BASE_URL}/notifications/client-events`),
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(report),
      }
    )
    return response.ok
  } catch {
    return false
  }
}

function refreshInbox() {
  queryClient.invalidateQueries({ queryKey: ['notifications-unread-count'] })
  queryClient.invalidateQueries({ queryKey: ['notifications'] })
}

async function flushQueue() {
  const queue = readQueue()
  if (queue.length === 0) return
  const remaining: ClientErrorReport[] = []
  for (const report of queue) {
    // 按顺序投递；遇到第一个失败就停止，以保持顺序。
    if (!(await postReport(report))) {
      remaining.push(report)
      remaining.push(...queue.slice(queue.indexOf(report) + 1))
      break
    }
    markReported(report)
  }
  writeQueue(remaining)
  if (remaining.length < queue.length) refreshInbox()
}

/**
 * Turn an operation failure into an in-app message (站内信) instead of a
 * 短暂的弹窗提示：上报会保存在服务端并归属当前用户，
 * 随后出现在通知铃铛里。当服务端不可达时（被上报的失败
 * 往往正是这种情况），上报会先进入 localStorage 队列，
 * 并在下次调用时冲刷出去。按照既定的交互设计，成功反馈
 * 有意保持为一次瞬时 toast。
 *
 * 去重窗口内完全相同的失败（相同页面 + 标题 + 详情）会被
 * 合并为一条消息，因此重试不会冲垮收件箱。
 *
 * 设计为即发即忘：调用方不要 await 它。
 */
export function reportOperationFailure(detail: string) {
  const report: ClientErrorReport = {
    title: i18n.t('notifications.operationFailed', '操作失败'),
    detail,
    path: `${window.location.pathname}${window.location.search}`,
  }
  if (isDuplicate(report)) return
  markReported(report)
  void (async () => {
    await flushQueue()
    if (await postReport(report)) {
      refreshInbox()
    } else {
      const queue = readQueue()
      queue.push(report)
      writeQueue(queue)
    }
  })()
}
