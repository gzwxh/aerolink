import * as yaml from 'js-yaml'
import { Service } from 'kubernetes-types/core/v1'
import { describe, expect, it } from 'vitest'

import {
  allowedServiceTypes,
  formFromService,
  generateServiceYaml,
  initialData,
  mergeServiceUpdate,
  resolveTargetPort,
  type ServiceFormData,
} from './service-yaml'

const form = (overrides: Partial<ServiceFormData> = {}): ServiceFormData => ({
  ...initialData,
  name: 'web',
  namespace: 'default',
  ...overrides,
})

function manifest(data: ServiceFormData): Record<string, unknown> {
  return yaml.load(generateServiceYaml(data)) as Record<string, unknown>
}

/** 一个「线上」Service：带标签/注解、已分配的 clusterIP、具名 targetPort。 */
const liveService = (): Service =>
  ({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: 'web',
      namespace: 'default',
      labels: { 'app.kubernetes.io/name': 'web' },
      annotations: { 'aerolink.internal/note': 'keep me' },
      resourceVersion: '12345',
      uid: 'uid-1',
    },
    spec: {
      type: 'ClusterIP',
      clusterIP: '10.96.0.10',
      clusterIPs: ['10.96.0.10'],
      ipFamilies: ['IPv4'],
      ipFamilyPolicy: 'SingleStack',
      internalTrafficPolicy: 'Cluster',
      sessionAffinity: 'None',
      selector: { app: 'web' },
      ports: [{ name: 'http', port: 80, targetPort: 'http', protocol: 'TCP' }],
    },
    status: { loadBalancer: {} },
  }) as unknown as Service

describe('service 表单数据层', () => {
  it('生成 YAML 时保留具名 targetPort', () => {
    const data = form({
      ports: [
        {
          name: 'http',
          port: '80',
          targetPort: 'http',
          nodePort: '',
          protocol: 'TCP',
        },
      ],
    })
    const spec = manifest(data).spec as Record<string, unknown>
    const port = (spec.ports as Array<Record<string, unknown>>)[0]
    // 名字不是数字：不能被 intOrNull 的 undefined 顶成 port 的数字。
    expect(port.targetPort).toBe('http')
  })

  it('targetPort 留空时回落到 port', () => {
    const data = form({
      ports: [
        {
          name: '',
          port: '8080',
          targetPort: '',
          nodePort: '',
          protocol: 'TCP',
        },
      ],
    })
    const spec = manifest(data).spec as Record<string, unknown>
    expect((spec.ports as Array<Record<string, unknown>>)[0].targetPort).toBe(
      8080
    )
    expect(resolveTargetPort('  ')).toBeUndefined()
    expect(resolveTargetPort(' 9090 ')).toBe(9090)
  })

  it('LoadBalancer 的 nodePort 会带回去，ClusterIP 不带', () => {
    const ports = [
      {
        name: 'http',
        port: '80',
        targetPort: '',
        nodePort: '31080',
        protocol: 'TCP' as const,
      },
    ]
    const lb = manifest(form({ serviceType: 'LoadBalancer', ports }))
    const lbPort = (lb.spec as Record<string, unknown>).ports as Array<
      Record<string, unknown>
    >
    // 表单在 LoadBalancer 下不展示 nodePort，但它是 API 分配的，丢掉等于换一批端口。
    expect(lbPort[0].nodePort).toBe(31080)

    const clusterIP = manifest(form({ serviceType: 'ClusterIP', ports }))
    const cipPort = (clusterIP.spec as Record<string, unknown>).ports as Array<
      Record<string, unknown>
    >
    expect(cipPort[0].nodePort).toBeUndefined()
  })

  it('线上对象预填回表单不丢信息', () => {
    const data = formFromService(liveService())
    expect(data.name).toBe('web')
    expect(data.serviceType).toBe('ClusterIP')
    expect(data.selector).toEqual([{ key: 'app', value: 'web' }])
    expect(data.ports[0]).toEqual({
      name: 'http',
      port: '80',
      targetPort: 'http',
      nodePort: '',
      protocol: 'TCP',
    })
    // 再生成一遍必须还是同一个 targetPort。
    const spec = manifest(data).spec as Record<string, unknown>
    expect((spec.ports as Array<Record<string, unknown>>)[0].targetPort).toBe(
      'http'
    )
  })

  it('编辑合并时保留不可变字段、标签与注解', () => {
    const existing = liveService()
    const generated = manifest(
      form({
        selector: [{ key: 'app', value: 'web-v2' }],
        ports: [
          {
            name: 'http',
            port: '8080',
            targetPort: 'http',
            nodePort: '',
            protocol: 'TCP',
          },
        ],
      })
    )
    const updated = mergeServiceUpdate(generated, existing)

    const spec = updated.spec as Record<string, unknown>
    // 表单没建模、且不可变的字段都还在。
    expect(spec.clusterIP).toBe('10.96.0.10')
    expect(spec.clusterIPs).toEqual(['10.96.0.10'])
    expect(spec.ipFamilies).toEqual(['IPv4'])
    expect(spec.ipFamilyPolicy).toBe('SingleStack')
    expect(spec.internalTrafficPolicy).toBe('Cluster')
    // 表单改到的字段用表单的值。
    expect(spec.selector).toEqual({ app: 'web-v2' })
    expect((spec.ports as Array<Record<string, unknown>>)[0].port).toBe(8080)
    // 标签/注解不是表单字段，不能被清掉。
    expect(updated.metadata?.labels).toEqual({
      'app.kubernetes.io/name': 'web',
    })
    expect(updated.metadata?.annotations).toEqual({
      'aerolink.internal/note': 'keep me',
    })
  })

  // 与工作负载不同：Service 的这几个字段「清空」就必须真的删掉，
  // 只做覆盖合并会让选择器永远删不掉。
  it('表单清空的字段在合并后真的消失', () => {
    const existing = liveService()
    const cleared = mergeServiceUpdate(
      manifest(
        form({
          selector: [],
          sessionAffinity: 'None',
        })
      ),
      existing
    )
    const spec = cleared.spec as Record<string, unknown>
    expect(spec.selector).toBeUndefined()
    expect(spec.sessionAffinity).toBeUndefined()
    expect(spec.clusterIP).toBe('10.96.0.10')

    // ExternalName 同理：切回 ClusterIP 后 externalName 不该留着。
    const external = mergeServiceUpdate(
      manifest(form({ serviceType: 'ClusterIP' })),
      {
        ...liveService(),
        spec: { ...liveService().spec, externalName: 'db.internal' },
      } as Service
    )
    expect(
      (external.spec as Record<string, unknown>).externalName
    ).toBeUndefined()
  })

  it('ExternalName 的类型在编辑时被锁定', () => {
    expect(allowedServiceTypes('ExternalName')).toEqual(['ExternalName'])
    expect(allowedServiceTypes('ClusterIP')).toEqual([
      'ClusterIP',
      'NodePort',
      'LoadBalancer',
    ])
  })
})
