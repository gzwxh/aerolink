import { describe, expect, it } from 'vitest'

import {
  formatCpuShort,
  formatMemoryShort,
  getPodConsumptions,
  parseCpuCores,
  parseMemoryMi,
  quotaBarColor,
  quotaTextColor,
  quotaUsagePercent,
} from './quota'

// 命名空间详情页的「配额使用」区块依赖这几个纯函数：
// ResourceQuota 的 spec.hard / status.used 是 K8s 资源量字符串，
// 单位写法不统一（2000m / 2 / 128Gi / 512Mi / 裸字节），比较前必须归一。
// 回归背景：此前详情页只展示 hard 限额，看不到 used，排查配额 403
// （exceeded quota）时只能去 kubectl 里翻 ResourceQuota。

describe('K8s 资源量解析', () => {
  it('CPU 归一为核数', () => {
    expect(parseCpuCores('2000m')).toBe(2)
    expect(parseCpuCores('500m')).toBe(0.5)
    expect(parseCpuCores('2')).toBe(2)
    expect(parseCpuCores(undefined)).toBe(0)
    expect(parseCpuCores('')).toBe(0)
    expect(parseCpuCores('abc')).toBe(0)
  })

  it('内存归一为 Mi', () => {
    expect(parseMemoryMi('128Gi')).toBe(131072)
    expect(parseMemoryMi('512Mi')).toBe(512)
    expect(parseMemoryMi('1Ti')).toBe(1048576)
    expect(parseMemoryMi(`${1024 * 1024 * 1024}`)).toBe(1024)
    expect(parseMemoryMi(undefined)).toBe(0)
    expect(parseMemoryMi('xyz')).toBe(0)
  })

  it('紧凑格式化：整数不带小数、小于 1 核显示 m', () => {
    expect(formatCpuShort(2)).toBe('2')
    expect(formatCpuShort(0.5)).toBe('500m')
    expect(formatCpuShort(0)).toBe('0')
    expect(formatMemoryShort(16 * 1024)).toBe('16Gi')
    expect(formatMemoryShort(1536)).toBe('1.5Gi')
    expect(formatMemoryShort(512)).toBe('512Mi')
    expect(formatMemoryShort(0)).toBe('0')
  })
})

describe('配额使用率', () => {
  it('used/hard 换算百分比', () => {
    expect(quotaUsagePercent(116, 128)).toBe(91)
    expect(quotaUsagePercent(64, 128)).toBe(50)
    expect(quotaUsagePercent(128, 128)).toBe(100)
  })

  it('hard 为 0 或未配置时不产生除零/误报', () => {
    expect(quotaUsagePercent(0, 0)).toBe(0)
    expect(quotaUsagePercent(5, 0)).toBe(0)
  })

  it('颜色阈值：≥90 红、≥70 黄、其余绿（进度条与文字同口径）', () => {
    expect(quotaBarColor(90)).toBe('bg-destructive')
    expect(quotaBarColor(89)).toBe('bg-warning')
    expect(quotaBarColor(70)).toBe('bg-warning')
    expect(quotaBarColor(69)).toBe('bg-success')
    expect(quotaTextColor(95)).toBe('text-destructive')
    expect(quotaTextColor(75)).toBe('text-warning')
    expect(quotaTextColor(20)).toBe('text-success')
  })
})

describe('Pod 资源占用汇总', () => {
  it('按 container[].resources.requests 求和', () => {
    const rows = getPodConsumptions([
      {
        metadata: { name: 'flink-jm' },
        spec: {
          containers: [
            { resources: { requests: { cpu: '2', memory: '4Gi' } } },
          ],
        },
      },
      {
        metadata: { name: 'flink-tm-1' },
        spec: {
          containers: [
            { resources: { requests: { cpu: '1000m', memory: '8Gi' } } },
            { resources: { requests: { cpu: '1', memory: '8Gi' } } },
          ],
        },
      },
    ])

    expect(rows).toEqual([
      { name: 'flink-jm', cpuRequest: 2, memoryRequest: 4096 },
      { name: 'flink-tm-1', cpuRequest: 2, memoryRequest: 16384 },
    ])
  })

  it('未声明 requests 的 Pod 按 0 计（留给页面过滤掉）', () => {
    const rows = getPodConsumptions([
      { metadata: { name: 'bare-pod' }, spec: { containers: [{}] } },
    ])
    expect(rows).toEqual([
      { name: 'bare-pod', cpuRequest: 0, memoryRequest: 0 },
    ])
  })
})
