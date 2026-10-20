import type { Service } from 'kubernetes-types/core/v1'
import { describe, expect, it, vi } from 'vitest'

import { serviceEndpointEntries } from './deployment-overview'

// 只测入口条目的计算，挡掉 api 模块避免拉起真实请求层。
vi.mock('@/lib/api', () => ({
  useRelatedResources: () => ({ data: [], isLoading: false }),
}))

const labels = {
  lbPending: '外部 IP 待分配',
  anyNode: '任意节点',
  headless: 'Headless',
}

const service = (name: string, spec: Partial<Service['spec']>): Service =>
  ({
    metadata: { name, namespace: 'devops' },
    spec,
  }) as Service

describe('serviceEndpointEntries', () => {
  it('ClusterIP 入口展示地址与内网域名', () => {
    const entries = serviceEndpointEntries(
      [
        service('greptimedb', {
          type: 'ClusterIP',
          clusterIP: '10.112.59.5',
          ports: [{ port: 4002, protocol: 'TCP' }],
        }),
      ],
      labels
    )

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      access: '10.112.59.5:4002',
      dns: 'greptimedb.devops.svc.cluster.local.:4002',
    })
  })

  // NodePort 入口是给集群外用的，行要保留，但内网域名对它没意义。
  it('NodePort 入口保留，但不带内网域名', () => {
    const entries = serviceEndpointEntries(
      [
        service('greptimedb', {
          type: 'ClusterIP',
          clusterIP: '10.112.59.5',
          ports: [{ port: 4002, protocol: 'TCP' }],
        }),
        service('greptimedb-nodeport', {
          type: 'NodePort',
          clusterIP: '10.112.173.213',
          ports: [{ port: 4002, protocol: 'TCP', nodePort: 30402 }],
        }),
      ],
      labels
    )

    expect(entries.map((entry) => entry.access)).toEqual([
      '10.112.59.5:4002',
      '任意节点:30402',
    ])
    expect(entries.map((entry) => entry.dns)).toEqual([
      'greptimedb.devops.svc.cluster.local.:4002',
      null,
    ])
  })
})
