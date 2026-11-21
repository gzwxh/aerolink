// 流式日志的缓冲治理。tailLines 只在建立连接那一刻生效，实时流会一直往下追加，
// 不设上限的话长时间会话把整个标签页的内存吃光（缺陷 D-16）。
export const MAX_LOG_LINES = 20000

/**
 * 丢弃最早的行，把缓冲压回上限内。
 * 原地裁剪（与传入的数组共用），返回被丢弃的行数。
 */
export function trimLogBuffer<T>(
  lines: T[],
  max: number = MAX_LOG_LINES
): number {
  const overflow = lines.length - max
  if (overflow <= 0) {
    return 0
  }
  lines.splice(0, overflow)
  return overflow
}

/**
 * 编辑器模型在超过这个行数时裁掉最前面多出来的部分。
 * 留一点余量，避免每来一行都触发一次删除编辑。
 */
export function modelOverflowLines(
  lineCount: number,
  max: number = MAX_LOG_LINES,
  margin: number = 1000
): number {
  return Math.max(0, lineCount - max - margin)
}

/**
 * Monaco 的默认行尾跟随平台，在 Windows 上是 \r\n，于是「下载日志」出来的文件
 * 每行都带 CR、整体是 CRLF（缺陷 D-17）。日志正文本身是 LF，出口统一一次。
 */
export function normalizeLogEol(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

// kubelet 取不到上一次容器的日志时，把这句错误当作**日志正文**返回（缺陷 D-18）：
// 它和真实日志走同一个 type=log 帧，界面看不出任何异常。原文仍然保留（有取证价值），
// 但必须额外给一条明确的告警，而不是让人以为容器真的打了这行。
const LOG_UNAVAILABLE_PATTERN = /unable to retrieve container logs/i

export function isLogUnavailableLine(text: string): boolean {
  return LOG_UNAVAILABLE_PATTERN.test(text)
}

/**
 * 过滤 0 命中时的提示判断（缺陷 D-26）：缓冲区里有内容但一条都没命中，
 * 与「日志本来就是空的」是两件不同的事，界面必须分开说。
 */
export function filterMissedEverything(
  filterTerm: string,
  matches: number,
  bufferedLines: number
): boolean {
  return filterTerm.trim().length > 0 && matches === 0 && bufferedLines > 0
}

// 日志流 error 帧的分类（缺陷 D-53）：以前这些消息只进 console，
// 界面就是一个没任何说明的空白面板。
export type LogStreamNoticeKind = 'limit' | 'previousNotFound' | 'streamError'

export function classifyLogStreamError(
  message: string,
  code?: string
): LogStreamNoticeKind {
  if (code === 'stream_limit_exceeded') {
    return 'limit'
  }
  // 容器从未重启过时勾「上一个容器」，kubelet 会回这句（它不走日志正文那条路）。
  if (/previous terminated container/i.test(message)) {
    return 'previousNotFound'
  }
  return 'streamError'
}
