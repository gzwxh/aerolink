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
    // Storage unavailable — dedup simply does not apply.
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
    // Cap the queue so a long offline period cannot grow it without bound.
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-MAX_QUEUE)))
  } catch {
    // Storage unavailable (private mode etc.) — drop the report silently.
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
    // Deliver in order; stop at the first failure so ordering is preserved.
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
 * transient popup: the report is stored server side for the current user and
 * shows up in the notification bell. When the server cannot be reached (the
 * failure being reported often means exactly that), the report is queued in
 * localStorage and flushed on the next call. Success feedback intentionally
 * stays as an instant toast per the agreed UX design.
 *
 * Identical failures (same page + title + detail) within the dedup window are
 * collapsed into one message, so retries never flood the inbox.
 *
 * Fire-and-forget by design: callers must not await it.
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
