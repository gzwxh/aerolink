import { describe, expect, it } from 'vitest'

import {
  rewriteServiceSelector,
  serviceCloneName,
  serviceSelectsPodLabels,
} from './clone-service'

const service = (
  selector: Record<string, string> | undefined,
  name = 'nginx'
) => ({
  metadata: { name },
  spec: selector ? { selector } : {},
})

describe('serviceSelectsPodLabels', () => {
  it('selector 是 Pod 标签的子集时算关联', () => {
    expect(
      serviceSelectsPodLabels(service({ app: 'nginx' }), {
        app: 'nginx',
        tier: 'web',
      })
    ).toBe(true)
  })

  it('取值对不上就不算关联', () => {
    expect(
      serviceSelectsPodLabels(service({ app: 'other' }), { app: 'nginx' })
    ).toBe(false)
  })

  it('selector 多要求一个 Pod 没有的键时不算关联', () => {
    expect(
      serviceSelectsPodLabels(service({ app: 'nginx', tier: 'web' }), {
        app: 'nginx',
      })
    ).toBe(false)
  })

  it('没有 selector 的 Service（ExternalName 等）不参与', () => {
    expect(serviceSelectsPodLabels(service(undefined), { app: 'nginx' })).toBe(
      false
    )
    expect(serviceSelectsPodLabels(service({}), { app: 'nginx' })).toBe(false)
  })
})

describe('serviceCloneName', () => {
  // 最常见的部署形态：Service 与工作负载同名，克隆后也同名才不会撞。
  it('与源工作负载同名时直接用克隆体的名字', () => {
    expect(serviceCloneName('nginx', 'nginx', 'nginx-copy')).toBe('nginx-copy')
  })

  it('名字无关时加 -copy 后缀', () => {
    expect(serviceCloneName('nginx-svc', 'nginx', 'nginx-copy')).toBe(
      'nginx-svc-copy'
    )
  })
})

describe('rewriteServiceSelector', () => {
  it('把指向源名字的取值改成新名字', () => {
    const cloned = service({ app: 'nginx' })
    rewriteServiceSelector(cloned, 'nginx', 'nginx-copy')
    expect(cloned.spec.selector).toEqual({ app: 'nginx-copy' })
  })

  it('未命中源名字的键保持不动', () => {
    const cloned = service({ app: 'nginx', tier: 'web' })
    rewriteServiceSelector(cloned, 'nginx', 'nginx-copy')
    expect(cloned.spec.selector).toEqual({ app: 'nginx-copy', tier: 'web' })
  })

  it('没有 selector 时安全返回', () => {
    const cloned = service(undefined)
    expect(() =>
      rewriteServiceSelector(cloned, 'nginx', 'nginx-copy')
    ).not.toThrow()
    expect(cloned.spec).toEqual({})
  })
})
