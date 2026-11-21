import { describe, expect, it } from 'vitest'

import {
  classifyLogStreamError,
  filterMissedEverything,
  isLogUnavailableLine,
  MAX_LOG_LINES,
  modelOverflowLines,
  normalizeLogEol,
  trimLogBuffer,
} from './log-buffer'

describe('trimLogBuffer', () => {
  // 回归（缺陷 D-16）：tailLines 只在连接时生效，实时流一直追加，
  // 不设上限就会把整个标签页的内存吃光。
  it('drops the oldest lines and reports how many were dropped', () => {
    const lines = Array.from({ length: 12 }, (_, index) => index)

    expect(trimLogBuffer(lines, 10)).toBe(2)
    expect(lines).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  })

  it('leaves a buffer under the limit untouched', () => {
    const lines = ['a', 'b']

    expect(trimLogBuffer(lines, 10)).toBe(0)
    expect(lines).toEqual(['a', 'b'])
  })

  it('defaults to the shared cap', () => {
    const lines = Array.from({ length: MAX_LOG_LINES + 5 }, (_, index) => index)

    expect(trimLogBuffer(lines)).toBe(5)
    expect(lines).toHaveLength(MAX_LOG_LINES)
  })
})

describe('modelOverflowLines', () => {
  it('keeps a margin so not every incoming line triggers a delete', () => {
    expect(modelOverflowLines(MAX_LOG_LINES, MAX_LOG_LINES, 1000)).toBe(0)
    expect(modelOverflowLines(MAX_LOG_LINES + 999, MAX_LOG_LINES, 1000)).toBe(0)
    expect(modelOverflowLines(MAX_LOG_LINES + 1000, MAX_LOG_LINES, 1000)).toBe(
      0
    )
    expect(modelOverflowLines(MAX_LOG_LINES + 1001, MAX_LOG_LINES, 1000)).toBe(
      1
    )
  })
})

describe('normalizeLogEol', () => {
  // 回归（缺陷 D-17）：Windows 上 Monaco 默认行尾是 \r\n，下载到的日志
  // 每行都带 CR、整体是 CRLF。
  it('turns CRLF back into LF', () => {
    expect(normalizeLogEol('a\r\nb\r\n')).toBe('a\nb\n')
  })

  it('keeps lone CR (progress bars) untouched', () => {
    expect(normalizeLogEol('50%\r100%\n')).toBe('50%\r100%\n')
  })
})

describe('isLogUnavailableLine', () => {
  // 回归（缺陷 D-18）：kubelet 的错误是以普通日志帧送过来的，
  // 界面上看起来就像容器真的打了这一行。
  it('recognises the kubelet "no previous logs" error', () => {
    expect(
      isLogUnavailableLine(
        'unable to retrieve container logs for containerd://823d2d78f4'
      )
    ).toBe(true)
  })

  it('does not flag ordinary output', () => {
    expect(isLogUnavailableLine('AEROLINK_CRASH attempt=12:00:00')).toBe(false)
  })
})

describe('filterMissedEverything', () => {
  // 回归（缺陷 D-26）：过滤 0 命中时整片空白，看不出是「缓冲区里没有」
  // 还是「本来就没日志」。
  it('only explains a miss when there actually was content', () => {
    expect(filterMissedEverything('seq=42', 0, 50)).toBe(true)
    expect(filterMissedEverything('seq=42', 3, 50)).toBe(false)
    expect(filterMissedEverything('seq=42', 0, 0)).toBe(false)
    expect(filterMissedEverything('   ', 0, 50)).toBe(false)
  })
})

// 回归（缺陷 D-53）：服务端的 error 帧以前只进 console，界面就是一个没说明的空白面板。
describe('classifyLogStreamError', () => {
  it('maps the limit code to its own notice', () => {
    expect(
      classifyLogStreamError('已达单用户并发上限', 'stream_limit_exceeded')
    ).toBe('limit')
  })

  it('explains "no previous container" separately', () => {
    expect(
      classifyLogStreamError(
        'Failed to get pod logs for web-1: previous terminated container "main" in pod "web-1" not found'
      )
    ).toBe('previousNotFound')
  })

  it('falls back to a generic failure notice carrying the reason', () => {
    expect(classifyLogStreamError('connection reset by peer')).toBe(
      'streamError'
    )
    expect(classifyLogStreamError('')).toBe('streamError')
  })
})
