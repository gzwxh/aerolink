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
      // 与 access 是同一个地址，不重复展示。
      clusterAddress: null,
      dns: 'greptimedb.devops.svc.cluster.local.:4002',
    })
  })

  // NodePort 只是多开了节点端口，集群内依然能通过 clusterIP 与 DNS 访问。
  it('NodePort 入口同时给出集群外地址、集群内 IP 与内网域名', () => {
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
    expect(entries.map((entry) => entry.clusterAddress)).toEqual([
      null,
      '10.112.173.213:4002',
    ])
    expect(entries.map((entry) => entry.dns)).toEqual([
      'greptimedb.devops.svc.cluster.local.:4002',
      'greptimedb-nodeport.devops.svc.cluster.local.:4002',
    ])
  })

  // 回归：自定义集群域的集群按后端下发的 dnsDomain 拼内网域名，
  // 不再硬编码 cluster.local 拼出无法解析的域名。
  it('自定义集群域时按 dnsDomain 拼内网域名', () => {
    const entries = serviceEndpointEntries(
      [
        service('greptimedb', {
          type: 'NodePort',
          clusterIP: '10.112.173.213',
          ports: [{ port: 4002, protocol: 'TCP', nodePort: 30402 }],
        }),
      ],
      labels,
      'k8s.example.internal'
    )

    expect(entries).toHaveLength(1)
    expect(entries[0].dns).toBe(
      'greptimedb.devops.svc.k8s.example.internal.:4002'
    )
  })
})
