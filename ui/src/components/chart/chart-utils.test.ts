import { describe, expect, it } from 'vitest'

import { formatBytes } from './chart-utils'

// 回归（缺陷 D-39）：0 < bytes < 1 时 Math.floor(log) 会得到 -1，
// 不夹取下标就取到 sizes[-1]（undefined），Y 轴刻度上直接印出 "NaN"。
describe('chart formatBytes', () => {
  it('formats sub-byte rates without producing NaN', () => {
    expect(formatBytes(0.5)).toBe('0.5B/s')
    expect(formatBytes(0.01)).toBe('0.0B/s')
  })

  it('keeps the usual ranges', () => {
    expect(formatBytes(0)).toBe('0')
    expect(formatBytes(1)).toBe('1.0B/s')
    expect(formatBytes(1536)).toBe('1.5KB/s')
    expect(formatBytes(20 * 1024 * 1024)).toBe('20MB/s')
  })

  it('clamps the index instead of running off the unit table', () => {
    // 1 TiB/s：越界时会拿到 sizes[4]（undefined），同样会印出 undefined 后缀。
    expect(formatBytes(1024 ** 4)).toBe('1024GB/s')
  })
})
