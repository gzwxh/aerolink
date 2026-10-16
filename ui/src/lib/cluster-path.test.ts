import { describe, expect, it } from 'vitest'

import {
  getClusterSlugFromPath,
  stripClusterPrefix,
  swapClusterSlug,
  withClusterPath,
} from '@/lib/cluster-path'

// 方案 §5「前端」：补/剥/换前缀的纯函数必须逐条钉住，其中「无前缀原样返回」
// 和「前缀必须在路径首段」两条是安全边界——写错了会把别人的集群地址当成自己的。
describe('getClusterSlugFromPath', () => {
  it('取首段 _clusters 之后的 slug', () => {
    expect(getClusterSlugFromPath('/_clusters/prod')).toBe('prod')
    expect(getClusterSlugFromPath('/_clusters/prod/')).toBe('prod')
    expect(
      getClusterSlugFromPath('/_clusters/prod/deployments/default/nginx')
    ).toBe('prod')
  })

  it('无前缀路径返回 null（登录页、初始化向导等）', () => {
    expect(getClusterSlugFromPath('/')).toBeNull()
    expect(getClusterSlugFromPath('')).toBeNull()
    expect(getClusterSlugFromPath('/login')).toBeNull()
    expect(getClusterSlugFromPath('/setup')).toBeNull()
    expect(getClusterSlugFromPath('/_clusters')).toBeNull()
    expect(getClusterSlugFromPath('/_clusters/')).toBeNull()
  })

  it('_clusters 不在首段时不算前缀', () => {
    expect(getClusterSlugFromPath('/deployments/_clusters/prod')).toBeNull()
    expect(getClusterSlugFromPath('/aerolink/_clusters/prod')).toBeNull()
  })

  it('容忍重复斜杠', () => {
    expect(getClusterSlugFromPath('//_clusters//prod//x')).toBe('prod')
  })
})

describe('stripClusterPrefix', () => {
  it('剥掉前缀后返回业务路径', () => {
    expect(stripClusterPrefix('/_clusters/prod/deployments')).toBe(
      '/deployments'
    )
    expect(
      stripClusterPrefix('/_clusters/prod/deployments/default/nginx')
    ).toBe('/deployments/default/nginx')
  })

  it('前缀后没有内容时返回根路径', () => {
    expect(stripClusterPrefix('/_clusters/prod')).toBe('/')
    expect(stripClusterPrefix('/_clusters/prod/')).toBe('/')
  })

  it('无前缀路径原样返回', () => {
    expect(stripClusterPrefix('/')).toBe('/')
    expect(stripClusterPrefix('/login')).toBe('/login')
    expect(stripClusterPrefix('/deployments')).toBe('/deployments')
    // base path 由 router 的 basename 处理，到了这里就不该再认 _clusters。
    expect(stripClusterPrefix('/aerolink/login')).toBe('/aerolink/login')
  })

  it('不误剥非首段的 _clusters', () => {
    expect(stripClusterPrefix('/deployments/_clusters/prod')).toBe(
      '/deployments/_clusters/prod'
    )
  })
})

describe('withClusterPath', () => {
  it('给业务路径补前缀', () => {
    expect(withClusterPath('/deployments', 'prod')).toBe(
      '/_clusters/prod/deployments'
    )
    expect(withClusterPath('deployments', 'prod')).toBe(
      '/_clusters/prod/deployments'
    )
    expect(withClusterPath('/deployments/default', 'prod')).toBe(
      '/_clusters/prod/deployments/default'
    )
  })

  it('根路径只补前缀段', () => {
    expect(withClusterPath('/', 'prod')).toBe('/_clusters/prod')
  })

  it('无 slug 时原样返回（登录页、初始化向导不能被套上集群前缀）', () => {
    expect(withClusterPath('/deployments')).toBe('/deployments')
    expect(withClusterPath('/deployments', null)).toBe('/deployments')
    expect(withClusterPath('/', undefined)).toBe('/')
    expect(withClusterPath('/login', '')).toBe('/login')
  })

  it('已带前缀的路径原样返回（不叠加）', () => {
    expect(withClusterPath('/_clusters/prod/deployments', 'other')).toBe(
      '/_clusters/prod/deployments'
    )
  })
})

describe('swapClusterSlug', () => {
  it('只换 slug，保留当前页面', () => {
    expect(
      swapClusterSlug('/_clusters/prod/deployments/default/nginx', 'test')
    ).toBe('/_clusters/test/deployments/default/nginx')
  })

  it('集群首页换成新集群首页', () => {
    expect(swapClusterSlug('/_clusters/prod', 'test')).toBe('/_clusters/test')
    expect(swapClusterSlug('/_clusters/prod/', 'test')).toBe('/_clusters/test')
  })

  it('根路径落到新集群首页', () => {
    expect(swapClusterSlug('/', 'test')).toBe('/_clusters/test')
  })

  it('与 strip/with 互逆', () => {
    const prefixed = withClusterPath('/deployments/default', 'prod')
    expect(swapClusterSlug(prefixed, 'prod')).toBe(prefixed)
  })
})
