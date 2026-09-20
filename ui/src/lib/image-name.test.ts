import { describe, expect, it } from 'vitest'

import { shortenImageName } from './image-name'

describe('shortenImageName', () => {
  it('省略冗长的仓库前缀，只保留镜像名与 tag', () => {
    expect(
      shortenImageName(
        '10.10.11.100:1180/l_ops/dsyy/cc-ops/activity-card-center:v2.0.27-amd64-2025082705112345'
      )
    ).toBe('…/activity-card-center:v2.0.27-amd64-2025082705112345')
  })

  it('没有路径的镜像原样返回', () => {
    expect(shortenImageName('nginx:1.21')).toBe('nginx:1.21')
    expect(shortenImageName('ubuntu')).toBe('ubuntu')
  })

  it('registry 的端口不会被误判成 tag', () => {
    expect(shortenImageName('registry.local:5000/team/app:1.0')).toBe(
      '…/app:1.0'
    )
    expect(shortenImageName('registry.local:5000/app')).toBe('…/app')
  })

  it('digest 只保留前 12 位', () => {
    const hash = 'a'.repeat(64)
    expect(shortenImageName(`repo@sha256:${hash}`)).toBe(
      'repo@sha256:aaaaaaaaaaaa…'
    )
  })

  it('空值原样返回', () => {
    expect(shortenImageName('')).toBe('')
  })
})
