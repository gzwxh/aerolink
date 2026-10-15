import type { Service } from 'kubernetes-types/core/v1'
import type { ObjectMeta } from 'kubernetes-types/meta/v1'
import { describe, expect, it } from 'vitest'

import type { CustomResource } from '@/types/api'

import { getOwnerInfo, getPrinterColumnValue, servicesForWorkload } from './k8s'

describe('getOwnerInfo', () => {
  it('uses the catalog route name for irregular plural kinds', () => {
    const info = getOwnerInfo({
      name: 'web',
      namespace: 'default',
      ownerReferences: [
        {
          apiVersion: 'networking.k8s.io/v1',
          kind: 'Ingress',
          name: 'web',
          controller: true,
        },
      ],
    } as ObjectMeta)
    expect(info?.path).toBe('/ingresses/default/web')
    expect(info?.controller).toBe(true)
  })

  it('links cluster-scoped owners without a namespace segment', () => {
    const info = getOwnerInfo({
      name: 'pod',
      namespace: 'default',
      ownerReferences: [
        { apiVersion: 'v1', kind: 'Node', name: 'control-plane-1' },
      ],
    } as ObjectMeta)
    expect(info?.path).toBe('/nodes/control-plane-1')
  })

  it('links namespaced custom owners by CRD name', () => {
    const info = getOwnerInfo({
      name: 'job',
      namespace: 'default',
      ownerReferences: [
        { apiVersion: 'example.com/v1', kind: 'Widget', name: 'target' },
      ],
    } as ObjectMeta)
    expect(info?.path).toBe('/crds/widgets.example.com/default/target')
  })

  it('links cluster-scoped custom owners without a namespace segment', () => {
    const info = getOwnerInfo({
      name: 'plugin',
      ownerReferences: [
        { apiVersion: 'example.com/v1', kind: 'Widget', name: 'target' },
      ],
    } as ObjectMeta)
    expect(info?.path).toBe('/crds/widgets.example.com/target')
  })

  it('returns null without owner references', () => {
    expect(getOwnerInfo({ name: 'pod' } as ObjectMeta)).toBeNull()
  })
})

const resource = {
  apiVersion: 'example.io/v1',
  kind: 'Widget',
  metadata: {
    name: 'example-widget',
    namespace: 'default',
  },
  spec: {
    http: [
      { match: { hosts: ['a.example', 'b.example'] } },
      { match: { hosts: ['c.example'] } },
    ],
  },
  status: {
    phase: 'Running',
    conditions: [
      { type: 'Synced', status: 'True' },
      { type: 'Ready', status: 'False' },
      { type: '[]', status: 'Empty Brackets' },
      { type: '[*]', status: 'Wildcard' },
    ],
    addresses: [
      { value: '10.0.0.1' },
      { value: null },
      {},
      { value: '10.0.0.2' },
    ],
  },
} as CustomResource

describe('getPrinterColumnValue', () => {
  it.each(['.status.phase', 'status.phase', '$.status.phase'])(
    'reads simple additionalPrinterColumns JSONPath values for %s',
    (jsonPath) => {
      expect(getPrinterColumnValue(resource, jsonPath)).toBe('Running')
    }
  )

  it('reads filtered conditions from additionalPrinterColumns JSONPath', () => {
    expect(
      getPrinterColumnValue(
        resource,
        ".status.conditions[?(@.type=='Synced')].status"
      )
    ).toBe('True')

    expect(
      getPrinterColumnValue(
        resource,
        ".status.conditions[?(@.type=='Ready')].status"
      )
    ).toBe('False')
  })

  it('does not normalize empty brackets inside filter strings', () => {
    expect(
      getPrinterColumnValue(
        resource,
        ".status.conditions[?(@.type=='[]')].status"
      )
    ).toBe('Empty Brackets')
  })

  it('returns undefined when the JSONPath does not match any value', () => {
    expect(
      getPrinterColumnValue(
        resource,
        ".status.conditions[?(@.type=='Healthy')].status"
      )
    ).toBeUndefined()
  })

  it('joins multiple values and skips nullish matches', () => {
    expect(getPrinterColumnValue(resource, '.status.addresses[*].value')).toBe(
      '10.0.0.1, 10.0.0.2'
    )
  })

  it('treats Kubernetes-style empty brackets as the first array item', () => {
    expect(getPrinterColumnValue(resource, '.status.addresses[].value')).toBe(
      '10.0.0.1'
    )
  })

  it('formats nested array values as JSON', () => {
    expect(getPrinterColumnValue(resource, '.spec.http[].match.hosts')).toBe(
      '["a.example","b.example"]'
    )
  })

  it('returns undefined instead of throwing for unparsable JSONPath', () => {
    expect(
      getPrinterColumnValue(resource, '.status.conditions[')
    ).toBeUndefined()
  })
})

// 工作负载页只读展示「关联的 Service」：关联规则必须与 Service 自己的选择器语义一致
// （谁选中这些 Pod 标签，谁就是关联对象），并兼容控制台过去按名字生成的习惯。
describe('servicesForWorkload', () => {
  const service = (
    name: string,
    selector?: Record<string, string>
  ): Service => ({
    metadata: { name, namespace: 'default' },
    spec: selector ? { selector } : {},
  })

  const services = [
    service('web', { app: 'web' }),
    service('web-canary', { app: 'web-canary' }),
    service('other', { app: 'api' }),
    service('no-selector'),
    service('external-name', {}),
  ]

  it('选择器被工作负载标签覆盖的 Service 算关联', () => {
    const matched = servicesForWorkload(services, {
      name: 'unrelated',
      labels: { app: 'web' },
    })
    expect(matched.map((s) => s.metadata?.name)).toEqual(['web'])
  })

  it('名字前缀只对无 selector 的 Service 兜底，不能凌驾于 selector 之上', () => {
    // 克隆负载的 Service（nginx-clone）名字同样以 web- 风格前缀开头，
    // 但 selector 指向别的 Pod —— 不该出现在本负载的关联信息里。
    const matched = servicesForWorkload(services, {
      name: 'web',
      labels: { app: 'nothing-matches' },
    })
    expect(matched.map((s) => s.metadata?.name)).toEqual([])
  })

  it('无 selector 的 Service 按名字兜底关联（控制台过去的命名习惯）', () => {
    const matched = servicesForWorkload(
      [service('web-legacy'), service('web-clone', { app: 'clone' })],
      { name: 'web', labels: { app: 'web' } }
    )
    expect(matched.map((s) => s.metadata?.name)).toEqual(['web-legacy'])
  })

  it('空选择器（ExternalName 之类）不算关联', () => {
    const matched = servicesForWorkload([service('external-name', {})], {
      name: 'external-name-other',
      labels: { app: 'web' },
    })
    expect(matched).toEqual([])
  })
})
