import { describe, expect, it } from 'vitest'

import { resolveLogStreamPod } from './log-stream'

describe('resolveLogStreamPod', () => {
  it('点名 Pod 时原样使用', () => {
    expect(resolveLogStreamPod('api-0', 'app=api')).toBe('api-0')
  })

  it('没有 Pod 名但有 labelSelector 时退回聚合通配符', () => {
    expect(resolveLogStreamPod(undefined, 'app=api')).toBe('_all')
    expect(resolveLogStreamPod('', 'app=api')).toBe('_all')
  })

  it('两者都没有时不建立连接', () => {
    expect(resolveLogStreamPod(undefined, undefined)).toBe('')
    expect(resolveLogStreamPod(undefined, '')).toBe('')
  })
})
