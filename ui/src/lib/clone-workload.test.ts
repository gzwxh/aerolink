import { describe, expect, it } from 'vitest'

import { alignWorkloadSelector, findSelectorCollision } from './clone-workload'

interface WorkloadOptions {
  name?: string
  selectorLabels?: Record<string, string>
  templateLabels?: Record<string, string>
  matchExpressions?: Array<{ key: string; operator: string; values: string[] }>
}

const workload = ({
  name = 'nginx',
  selectorLabels = { app: 'nginx' },
  templateLabels = { app: 'nginx' },
  matchExpressions,
}: WorkloadOptions = {}) => ({
  metadata: { name },
  spec: {
    selector: {
      matchLabels: selectorLabels,
      ...(matchExpressions ? { matchExpressions } : {}),
    },
    template: { metadata: { labels: templateLabels } },
  },
})

const cloneOf = (source: ReturnType<typeof workload>) => structuredClone(source)

describe('alignWorkloadSelector', () => {
  it('把取值等于源名字的标签改写成新名字（selector 与 Pod 模板同步）', () => {
    const source = workload({ selectorLabels: { app: 'nginx' } })
    const cloned = cloneOf(source)

    alignWorkloadSelector(cloned, source, 'deployments', 'nginx', 'nginx-copy')

    expect(cloned.spec.selector.matchLabels).toEqual({ app: 'nginx-copy' })
    expect(cloned.spec.template.metadata.labels).toEqual({ app: 'nginx-copy' })
  })

  it('多个标识键一起改写，非标识键保持不动', () => {
    const source = workload({
      selectorLabels: { app: 'nginx', name: 'nginx', tier: 'web' },
      templateLabels: { app: 'nginx', name: 'nginx', tier: 'web' },
    })
    const cloned = cloneOf(source)

    alignWorkloadSelector(cloned, source, 'statefulsets', 'nginx', 'nginx-copy')

    expect(cloned.spec.selector.matchLabels).toEqual({
      app: 'nginx-copy',
      name: 'nginx-copy',
      tier: 'web',
    })
    expect(cloned.spec.template.metadata.labels).toEqual({
      app: 'nginx-copy',
      name: 'nginx-copy',
      tier: 'web',
    })
  })

  // 源 selector 里没有源名字（例如 app: web）时改写无从下手；不兜底的话克隆出来的
  // selector 与源对象完全相同，两个工作负载继续抢同一批 Pod（就是本次的 bug）。
  it('selector 与源对象完全相同时兜底改写一个键', () => {
    const source = workload({
      selectorLabels: { app: 'web' },
      templateLabels: { app: 'web' },
    })
    const cloned = cloneOf(source)

    alignWorkloadSelector(cloned, source, 'deployments', 'nginx', 'nginx-copy')

    expect(cloned.spec.selector.matchLabels).toEqual({ app: 'nginx-copy' })
    expect(cloned.spec.template.metadata.labels).toEqual({ app: 'nginx-copy' })
  })

  it('matchExpressions 里的取值同样改写', () => {
    const source = workload({
      selectorLabels: {},
      templateLabels: { app: 'nginx' },
      matchExpressions: [{ key: 'app', operator: 'In', values: ['nginx'] }],
    })
    const cloned = cloneOf(source)

    alignWorkloadSelector(cloned, source, 'daemonsets', 'nginx', 'nginx-copy')

    expect(cloned.spec.selector.matchExpressions).toEqual([
      { key: 'app', operator: 'In', values: ['nginx-copy'] },
    ])
    expect(cloned.spec.template.metadata.labels).toEqual({ app: 'nginx-copy' })
  })

  // Service 的 selector 指向 Pod 是**期望**行为（克隆一份服务定义、指向同一应用很常见），
  // 所以这里刻意不改；只有靠 selector 认领 Pod 的工作负载需要改。
  it('非工作负载类型（Service 等）不做改写', () => {
    const source = {
      metadata: { name: 'nginx' },
      spec: { selector: { app: 'nginx' } },
    }
    const cloned = structuredClone(source)

    alignWorkloadSelector(cloned, source, 'services', 'nginx', 'nginx-copy')

    expect(cloned.spec.selector).toEqual({ app: 'nginx' })
  })

  it('缺少 selector 或模板标签时安全返回', () => {
    const source = { metadata: { name: 'nginx' }, spec: {} }
    const cloned = { metadata: { name: 'nginx-copy' }, spec: {} }

    expect(() =>
      alignWorkloadSelector(
        cloned,
        source,
        'deployments',
        'nginx',
        'nginx-copy'
      )
    ).not.toThrow()
    expect(cloned.spec).toEqual({})
  })
})

describe('findSelectorCollision（克隆体的 selector 撞车检查）', () => {
  // 回归（验收台账 D-153）：alignWorkloadSelector 只在生成草稿那一刻跑一次，
  // 用户在草稿里改名不会重算 Pod 标签，于是能造出与现存负载 selector 完全相同的
  // 克隆体 —— 两边控制器争抢同一批 Pod，关联 Service 的端点也会跳负载混在一起。
  it('与现存负载逐项相同时报出对方名字', () => {
    const candidate = workload({
      name: 'my-app',
      selectorLabels: { app: 'nginx-copy' },
    })
    const existing = [
      workload({ name: 'nginx' }),
      workload({
        name: 'nginx-copy',
        selectorLabels: { app: 'nginx-copy' },
        templateLabels: { app: 'nginx-copy' },
      }),
    ]
    expect(findSelectorCollision(candidate, existing)).toBe('nginx-copy')
  })

  it('撞的是源对象自己也照样报出来（改名完全没传导的情形）', () => {
    const candidate = workload({
      name: 'nginx-copy',
      selectorLabels: { app: 'nginx' },
    })
    expect(
      findSelectorCollision(candidate, [workload({ name: 'nginx' })])
    ).toBe('nginx')
  })

  it('selector 不同就放行', () => {
    const candidate = workload({
      name: 'my-app',
      selectorLabels: { app: 'my-app' },
    })
    expect(
      findSelectorCollision(candidate, [workload({ name: 'nginx' })])
    ).toBeNull()
  })

  it('只有一半键相同（互为子集）不算撞车', () => {
    const candidate = workload({
      name: 'my-app',
      selectorLabels: { app: 'nginx-copy', tier: 'web' },
    })
    expect(
      findSelectorCollision(candidate, [
        workload({ name: 'other', selectorLabels: { app: 'nginx-copy' } }),
      ])
    ).toBeNull()
  })

  it('带 matchExpressions 时不判定，避免误拦合法克隆', () => {
    const existing = workload({ name: 'nginx' })
    const withExpressions = workload({
      name: 'my-app',
      selectorLabels: { app: 'nginx' },
      matchExpressions: [{ key: 'tier', operator: 'In', values: ['web'] }],
    })
    expect(findSelectorCollision(withExpressions, [existing])).toBeNull()
    expect(findSelectorCollision(existing, [withExpressions])).toBeNull()
  })

  it('不与同名对象比较，也不被残缺数据带崩', () => {
    const candidate = workload({ name: 'nginx' })
    expect(findSelectorCollision(candidate, [candidate])).toBeNull()
    expect(
      findSelectorCollision(candidate, [null, {}, { metadata: {} }])
    ).toBeNull()
    expect(
      findSelectorCollision({ metadata: { name: 'no-selector' } }, [candidate])
    ).toBeNull()
  })
})
