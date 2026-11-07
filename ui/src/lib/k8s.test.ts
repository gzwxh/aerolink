import type { Node, Pod, Service } from 'kubernetes-types/core/v1'
import type { ObjectMeta } from 'kubernetes-types/meta/v1'
import { describe, expect, it } from 'vitest'

import type { CustomResource } from '@/types/api'

import {
  getNodeStatus,
  getOwnerInfo,
  getPrinterColumnValue,
  groupPodsByNamespace,
  servicesForWorkload,
  sumPodRestarts,
} from './k8s'

describe('sumPodRestarts', () => {
  const pod = (
    name: string,
    namespace: string,
    labels: Record<string, string>,
    restarts: number[]
  ) =>
    ({
      metadata: { name, namespace, labels },
      status: {
        phase: 'Running',
        containerStatuses: restarts.map((restartCount, index) => ({
          name: `c${index}`,
          ready: true,
          restartCount,
          state: { running: { startedAt: '2024-01-01T00:00:00Z' } },
        })),
      },
    }) as Pod

  const pods = groupPodsByNamespace([
    pod('web-1', 'default', { app: 'web' }, [1, 2]),
    pod('web-2', 'default', { app: 'web' }, [0]),
    pod('web-1', 'other', { app: 'web' }, [5]),
    pod('api-1', 'default', { app: 'api' }, [3]),
  ])

  it('按 selector 匹配同一命名空间的 Pod 并累加容器重启次数', () => {
    expect(sumPodRestarts(pods, 'default', { app: 'web' })).toBe(3)
    expect(sumPodRestarts(pods, 'default', { app: 'api' })).toBe(3)
  })

  it('selector 为空或命名空间未知时不猜 Pod', () => {
    expect(sumPodRestarts(pods, 'default', undefined)).toBe(0)
    expect(sumPodRestarts(pods, 'default', {})).toBe(0)
    expect(sumPodRestarts(pods, undefined, { app: 'web' })).toBe(0)
  })

  it('selector 只命中部分标签时不算数', () => {
    expect(sumPodRestarts(pods, 'default', { app: 'web', tier: 'fe' })).toBe(0)
  })
})

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

describe('getNodeStatus', () => {
  const NOW = new Date('2026-10-16T08:00:00Z').getTime()

  const node = (
    ready: string,
    options: {
      heartbeatAgoMs?: number
      taints?: string[]
      unschedulable?: boolean
      conditions?: { type: string; status: string }[]
    } = {}
  ) =>
    ({
      metadata: { name: 'k8s-node101' },
      spec: {
        unschedulable: options.unschedulable,
        taints: (options.taints || []).map((key) => ({
          key,
          effect: 'NoSchedule',
        })),
      },
      status: {
        conditions: [
          {
            type: 'Ready',
            status: ready,
            ...(options.heartbeatAgoMs === undefined
              ? {}
              : {
                  lastHeartbeatTime: new Date(
                    NOW - options.heartbeatAgoMs
                  ).toISOString(),
                }),
          },
          ...(options.conditions || []),
        ],
      },
    }) as Node

  it('就绪且心跳新鲜时是 Ready', () => {
    const status = getNodeStatus(node('True', { heartbeatAgoMs: 5000 }), NOW)

    expect(status.kind).toBe('Ready')
    expect(status.unreachable).toBe(false)
  })

  it('Ready=Unknown 且心跳停了算失联（node-controller 就是这么写的）', () => {
    const status = getNodeStatus(
      node('Unknown', { heartbeatAgoMs: 5 * 60_000 }),
      NOW
    )

    expect(status.kind).toBe('Unreachable')
    expect(status.unreachable).toBe(true)
  })

  it('带着 unreachable 污点算失联', () => {
    const status = getNodeStatus(
      node('False', { taints: ['node.kubernetes.io/unreachable'] }),
      NOW
    )

    expect(status.kind).toBe('Unreachable')
  })

  // 回归：健康节点状态不变时 kubelet 默认 5 分钟才补报一次 Node.status，
  // 不能把这段间隔当成「心跳已停」——Ready=True 的节点只要没有失联污点就仍是就绪。
  it('Ready=True 但 lastHeartbeatTime 超过 5 分钟未更新：不提示、不判失联', () => {
    const status = getNodeStatus(
      node('True', { heartbeatAgoMs: 6 * 60_000 }),
      NOW
    )

    expect(status.kind).toBe('Ready')
    expect(status.unreachable).toBe(false)
  })

  it('Ready=True 但有压力条件：kind 仍是 Ready，压力单独输出', () => {
    const status = getNodeStatus(
      node('True', {
        heartbeatAgoMs: 5000,
        conditions: [{ type: 'DiskPressure', status: 'True' }],
      }),
      NOW
    )

    expect(status.kind).toBe('Ready')
    expect(status.pressures).toEqual(['DiskPressure'])
  })

  it('未就绪与压力的组合不丢：kind 用压力名，pressures 全量列出', () => {
    const status = getNodeStatus(
      node('False', {
        conditions: [
          { type: 'MemoryPressure', status: 'True' },
          { type: 'PIDPressure', status: 'True' },
        ],
      }),
      NOW
    )

    expect(status.kind).toBe('MemoryPressure')
    expect(status.pressures).toEqual(['MemoryPressure', 'PIDPressure'])
  })

  it('刚加入、还没上报过心跳的节点不算失联', () => {
    const status = getNodeStatus(node('Unknown'), NOW)

    expect(status.kind).toBe('Unknown')
    expect(status.unreachable).toBe(false)
  })

  it('Ready=False 且心跳新鲜：节点自报未就绪，提示 NotReady', () => {
    const status = getNodeStatus(node('False', { heartbeatAgoMs: 5000 }), NOW)

    expect(status.kind).toBe('NotReady')
    expect(status.unreachable).toBe(false)
  })

  it('停止调度时给出 SchedulingDisabled 字面量', () => {
    const status = getNodeStatus(
      node('True', { heartbeatAgoMs: 1000, unschedulable: true }),
      NOW
    )

    expect(status.kind).toBe('Ready,SchedulingDisabled')
    expect(status.cordoned).toBe(true)
  })

  it('未就绪时按压力类条件给出原因', () => {
    const pressured = {
      metadata: { name: 'k8s-node101' },
      status: {
        conditions: [
          { type: 'Ready', status: 'False' },
          { type: 'DiskPressure', status: 'True' },
        ],
      },
    } as Node

    expect(getNodeStatus(pressured, NOW).kind).toBe('DiskPressure')
  })
})
