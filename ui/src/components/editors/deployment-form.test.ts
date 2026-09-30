import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

import {
  applyEditedManifest,
  generateWorkloadYaml,
  initialFormData,
  mergeEditedManifest,
  parseYamlToFormData,
  type DeploymentFormData,
  type VolumeForm,
} from './deployment-form'

/** 生成出来的 YAML 文档；测试只读这几个字段，需要往下钻的字段在断言里收窄。 */
type GeneratedDoc = {
  kind: string
  metadata: { name?: string }
  spec: Record<string, unknown>
}

/** 一个带端口行的 Deployment 表单：用来断言 Service 文档的生成、反解与合并。 */
function formWithPorts(
  ports: DeploymentFormData['containers'][number]['ports']
): DeploymentFormData {
  return {
    ...initialFormData,
    name: 'web',
    namespace: 'default',
    labels: [{ key: 'app', value: 'web' }],
    containers: [
      {
        ...initialFormData.containers[0],
        name: 'app',
        image: 'nginx:1.25',
        ports,
      },
    ],
  }
}

/**
 * 表单编辑线上对象的合并规则。
 *
 * 背景：编辑页保存前会把「表单生成的 manifest」叠加到线上对象上，因为可视化表单只建模
 * 了部分字段。这条规则出问题的表现是「什么都没改也保存不了」——尤其是 Pod 模板不可变的
 * Job，任何被固定值改写的模板字段都会被 API 以 `field is immutable` 拒绝。
 */
describe('mergeEditedManifest', () => {
  it('保留表单未建模的字段，并恢复不可变的 selector 与模板标签', () => {
    const original = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: 'web',
        namespace: 'default',
        managedFields: [{ manager: 'x' }],
      },
      spec: {
        selector: { matchLabels: { app: 'web', 'pod-template-hash': 'abc' } },
        template: {
          metadata: { labels: { app: 'web' } },
          spec: {
            serviceAccountName: 'web-sa',
            containers: [{ name: 'app', image: 'old' }],
          },
        },
      },
      status: { replicas: 1 },
    }
    const generated = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'web', namespace: 'default' },
      spec: {
        replicas: 3,
        selector: { matchLabels: { app: 'web' } },
        template: {
          metadata: { labels: { app: 'web' } },
          spec: { containers: [{ name: 'app', image: 'new' }] },
        },
      },
    }

    const merged = mergeEditedManifest(generated, original)
    const spec = merged.spec as Record<string, unknown>
    const template = spec.template as {
      metadata: { labels: Record<string, string> }
      spec: Record<string, unknown>
    }

    // 表单里改到的字段生效。
    expect(spec.replicas).toBe(3)
    expect(template.spec.containers).toEqual([{ name: 'app', image: 'new' }])
    // 表单没建模的字段来自线上对象；selector 不可变，必须原样恢复。
    expect(template.spec.serviceAccountName).toBe('web-sa')
    expect(spec.selector).toEqual({
      matchLabels: { app: 'web', 'pod-template-hash': 'abc' },
    })
    expect(template.metadata.labels).toEqual({
      app: 'web',
      'pod-template-hash': 'abc',
    })
    // Status 与 managedFields 不回写。
    expect(merged.status).toBeUndefined()
    expect(
      (merged.metadata as Record<string, unknown>).managedFields
    ).toBeUndefined()
  })

  it('Job 的 Pod 模板 restartPolicy 按线上对象恢复', () => {
    const original = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: 'job', namespace: 'default' },
      spec: {
        backoffLimit: 1,
        selector: { matchLabels: { 'job-name': 'job' } },
        template: {
          metadata: { labels: { 'job-name': 'job' } },
          spec: {
            restartPolicy: 'Never',
            containers: [{ name: 'app', image: 'old' }],
          },
        },
      },
    }
    // 表单生成 batch 模板时固定写 OnFailure（API 不接受 Always）。
    const generated = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: 'job', namespace: 'default' },
      spec: {
        template: {
          metadata: { labels: {} },
          spec: {
            restartPolicy: 'OnFailure',
            containers: [{ name: 'app', image: 'new' }],
          },
        },
      },
    }

    const merged = mergeEditedManifest(generated, original)
    const template = (merged.spec as Record<string, unknown>).template as {
      spec: Record<string, unknown>
    }
    expect(template.spec.restartPolicy).toBe('Never')
  })

  it('CronJob 的模板在 jobTemplate 里，同样恢复 restartPolicy 而不影响改过的调度周期', () => {
    const original = {
      apiVersion: 'batch/v1',
      kind: 'CronJob',
      metadata: { name: 'cron', namespace: 'default' },
      spec: {
        schedule: '0 0 31 2 *',
        jobTemplate: {
          spec: {
            template: {
              spec: {
                restartPolicy: 'Never',
                containers: [{ name: 'app', image: 'old' }],
              },
            },
          },
        },
      },
    }
    const generated = {
      apiVersion: 'batch/v1',
      kind: 'CronJob',
      metadata: { name: 'cron', namespace: 'default' },
      spec: {
        schedule: '0 0 31 3 *',
        jobTemplate: {
          spec: {
            template: {
              spec: {
                restartPolicy: 'OnFailure',
                containers: [{ name: 'app', image: 'new' }],
              },
            },
          },
        },
      },
    }

    const merged = mergeEditedManifest(generated, original)
    const spec = merged.spec as Record<string, unknown>
    const jobTemplate = spec.jobTemplate as {
      spec: { template: { spec: Record<string, unknown> } }
    }
    expect(spec.schedule).toBe('0 0 31 3 *')
    expect(jobTemplate.spec.template.spec.restartPolicy).toBe('Never')
  })
})

/**
 * 端口行选了 Service 类型时，保存会连同工作负载生成多文档 YAML
 * （Service 在前、工作负载在后）；`serviceType: 'none'` 的端口不产出任何 Service。
 */
describe('工作负载 YAML 生成', () => {
  const formData = formWithPorts([
    {
      name: 'http',
      containerPort: 8080,
      protocol: 'TCP' as const,
      serviceType: 'none' as const,
    },
  ])

  it('端口不请求 Service 时只生成工作负载文档，容器端口保留', () => {
    const text = generateWorkloadYaml(formData, 'deployments')

    expect(text).not.toContain('kind: Service')
    expect(text.match(/^---$/m)).toBeNull()
    expect(text).toContain('containerPort: 8080')
    expect(text).toContain('name: http')
  })

  it('StatefulSet / DaemonSet / Job / CronJob 同样只生成一个文档', () => {
    for (const resourceType of [
      'statefulsets',
      'daemonsets',
      'jobs',
      'cronjobs',
    ] as const) {
      const text = generateWorkloadYaml(formData, resourceType)
      expect(text, resourceType).not.toContain('kind: Service')
      expect(text.match(/^---$/m), resourceType).toBeNull()
    }
  })

  it('ClusterIP 端口生成选择器指向工作负载标签的 Service', () => {
    const docs = yaml.loadAll(
      generateWorkloadYaml(
        formWithPorts([
          {
            name: 'http',
            containerPort: 8080,
            protocol: 'TCP',
            serviceType: 'ClusterIP',
          },
        ]),
        'deployments'
      )
    ) as unknown as GeneratedDoc[]

    expect(docs.map((doc) => doc.kind)).toEqual(['Service', 'Deployment'])
    expect(docs[0].metadata.name).toBe('web')
    expect(docs[0].spec.type).toBe('ClusterIP')
    expect(docs[0].spec.selector).toEqual({ app: 'web' })
    expect(docs[0].spec.ports).toEqual([
      { name: 'http', port: 8080, targetPort: 8080 },
    ])
  })

  it('同类型端口合成一个 Service，不同类型各一个并带类型后缀', () => {
    const docs = yaml.loadAll(
      generateWorkloadYaml(
        formWithPorts([
          { containerPort: 80, protocol: 'TCP', serviceType: 'ClusterIP' },
          {
            containerPort: 443,
            protocol: 'TCP',
            serviceType: 'ClusterIP',
            servicePort: 8443,
          },
          {
            containerPort: 53,
            protocol: 'UDP',
            serviceType: 'NodePort',
            nodePort: 30053,
          },
        ]),
        'deployments'
      )
    ) as unknown as GeneratedDoc[]

    const services = docs.filter((doc) => doc.kind === 'Service')
    expect(services.map((doc) => doc.metadata.name)).toEqual([
      'web',
      'web-nodeport',
    ])
    expect(services[0].spec.ports).toEqual([
      { port: 80, targetPort: 80 },
      { port: 8443, targetPort: 443 },
    ])
    expect(services[1].spec.ports).toEqual([
      { port: 53, targetPort: 53, nodePort: 30053, protocol: 'UDP' },
    ])
  })

  it('LoadBalancer 的名字带类型后缀，静态 ClusterIP 只写进 ClusterIP', () => {
    const loadBalancer = yaml.loadAll(
      generateWorkloadYaml(
        formWithPorts([
          { containerPort: 8080, protocol: 'TCP', serviceType: 'LoadBalancer' },
        ]),
        'deployments'
      )
    ) as unknown as GeneratedDoc[]
    expect(loadBalancer[0].metadata.name).toBe('web-loadbalancer')

    const staticIP = yaml.loadAll(
      generateWorkloadYaml(
        formWithPorts([
          {
            containerPort: 80,
            protocol: 'TCP',
            serviceType: 'ClusterIP',
            clusterIP: '10.96.0.10',
          },
        ]),
        'deployments'
      )
    ) as unknown as GeneratedDoc[]
    expect(staticIP[0].spec.clusterIP).toBe('10.96.0.10')
  })

  it('把 Service 文档反解回端口行', () => {
    const parsed = parseYamlToFormData(
      generateWorkloadYaml(
        formWithPorts([
          {
            containerPort: 8080,
            protocol: 'TCP',
            serviceType: 'NodePort',
            servicePort: 30080,
            nodePort: 30080,
          },
          { containerPort: 9090, protocol: 'TCP', serviceType: 'none' },
        ]),
        'deployments'
      ),
      'deployments',
      initialFormData
    )

    expect(parsed.containers[0].ports).toEqual([
      {
        name: undefined,
        containerPort: 8080,
        protocol: 'TCP',
        serviceType: 'NodePort',
        servicePort: 30080,
        nodePort: 30080,
      },
      {
        name: undefined,
        containerPort: 9090,
        protocol: 'TCP',
        serviceType: 'none',
      },
    ])
  })

  it('手写的 ExternalName Service 不写进端口行', () => {
    const parsed = parseYamlToFormData(
      [
        `apiVersion: v1
kind: Service
metadata:
  name: web
  namespace: default
spec:
  type: ExternalName
  externalName: example.com
  ports:
    - port: 80
      targetPort: 8080`,
        generateWorkloadYaml(
          formWithPorts([
            { containerPort: 8080, protocol: 'TCP', serviceType: 'none' },
          ]),
          'deployments'
        ),
      ].join('\n---\n'),
      'deployments',
      initialFormData
    )

    expect(parsed.containers[0].ports[0].serviceType).toBe('none')
  })
})

/**
 * 编辑模式会把表单生成的 manifest 叠加到线上对象上。生成的多文档里第一个是
 * Service，因此这里必须按 kind 找到工作负载再合并，否则会把 Service 和线上
 * Deployment 揉成一个对象。
 */
describe('applyEditedManifest', () => {
  it('只合并工作负载文档，生成的 Service 原样保留', () => {
    const original = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'web', namespace: 'default' },
      spec: {
        selector: { matchLabels: { app: 'web' } },
        template: {
          metadata: { labels: { app: 'web' } },
          spec: {
            serviceAccountName: 'web-sa',
            containers: [{ name: 'app', image: 'old' }],
          },
        },
      },
    }

    const docs = yaml.loadAll(
      applyEditedManifest(
        generateWorkloadYaml(
          formWithPorts([
            { containerPort: 8080, protocol: 'TCP', serviceType: 'ClusterIP' },
          ]),
          'deployments'
        ),
        original
      )
    ) as unknown as GeneratedDoc[]

    expect(docs.map((doc) => doc.kind)).toEqual(['Service', 'Deployment'])
    expect(docs[0].spec.selector).toEqual({ app: 'web' })
    expect(docs[0].spec.type).toBe('ClusterIP')
    // 表单没建模的字段从线上对象保留下来。
    const deployment = docs[1].spec as {
      template: { spec: { serviceAccountName?: string } }
    }
    expect(deployment.template.spec.serviceAccountName).toBe('web-sa')
  })
})

/**
 * 存储卷：表单支持的卷来源要能完整写进 podSpec.volumes，并能原样读回表单。
 *
 * 这里盯的是两类容易写错的地方：hostPath 的空 type 是 API 的默认值（不检查路径），
 * 不能写成 `type: ''`；Pod 级 CSI 卷没有 volumeHandle 字段，参数只能走
 * volumeAttributes（写错会被 API 直接拒掉）。
 */
describe('存储卷的生成与反向解析', () => {
  const withVolumes = (volumes: VolumeForm[]): DeploymentFormData => ({
    ...initialFormData,
    name: 'web',
    namespace: 'default',
    labels: [{ key: 'app', value: 'web' }],
    containers: [
      { ...initialFormData.containers[0], name: 'app', image: 'nginx:1.25' },
    ],
    podSpec: { ...initialFormData.podSpec, volumes },
  })

  const volumesOf = (volumes: VolumeForm[]) => {
    const doc = yaml.load(
      generateWorkloadYaml(withVolumes(volumes), 'deployments')
    ) as {
      spec: { template: { spec: { volumes: unknown } } }
    }
    return doc.spec.template.spec.volumes
  }

  it('hostPath 写出路径类型；未指定类型时不写 type 字段', () => {
    expect(
      volumesOf([
        {
          name: 'data',
          sourceType: 'hostPath',
          options: { path: '/data', hostPathType: 'DirectoryOrCreate' },
        },
        { name: 'scratch', sourceType: 'hostPath', options: { path: '/tmp' } },
      ])
    ).toEqual([
      {
        name: 'data',
        hostPath: { path: '/data', type: 'DirectoryOrCreate' },
      },
      { name: 'scratch', hostPath: { path: '/tmp' } },
    ])
  })

  it('NFS 与 CSI 卷按 API 字段生成，CSI 参数落在 volumeAttributes', () => {
    expect(
      volumesOf([
        {
          name: 'shared',
          sourceType: 'nfs',
          options: {
            nfsServer: '10.0.0.1',
            nfsPath: '/exports/data',
            nfsReadOnly: true,
          },
        },
        {
          name: 'disk',
          sourceType: 'csi',
          options: {
            csiDriver: 'disk.csi.everest.io',
            csiFsType: 'ext4',
            csiVolumeAttributes: [
              { key: 'volumeHandle', value: 'd-1' },
              { key: '', value: '被丢弃的空键' },
            ],
          },
        },
      ])
    ).toEqual([
      {
        name: 'shared',
        nfs: { server: '10.0.0.1', path: '/exports/data', readOnly: true },
      },
      {
        name: 'disk',
        csi: {
          driver: 'disk.csi.everest.io',
          fsType: 'ext4',
          volumeAttributes: { volumeHandle: 'd-1' },
        },
      },
    ])
  })

  it('生成的 YAML 能原样读回表单', () => {
    const volumes: VolumeForm[] = [
      { name: 'cache', sourceType: 'emptyDir' },
      {
        name: 'data',
        sourceType: 'hostPath',
        options: { path: '/data', hostPathType: 'Directory' },
      },
      {
        name: 'shared',
        sourceType: 'nfs',
        options: { nfsServer: '10.0.0.1', nfsPath: '/exports/data' },
      },
      {
        name: 'disk',
        sourceType: 'csi',
        options: {
          csiDriver: 'disk.csi.everest.io',
          csiReadOnly: true,
          csiVolumeAttributes: [{ key: 'volumeHandle', value: 'd-1' }],
        },
      },
    ]
    const parsed = parseYamlToFormData(
      generateWorkloadYaml(withVolumes(volumes), 'deployments'),
      'deployments',
      initialFormData
    )

    expect(parsed.podSpec.volumes).toEqual([
      { name: 'cache', sourceType: 'emptyDir', options: {} },
      {
        name: 'data',
        sourceType: 'hostPath',
        options: { path: '/data', hostPathType: 'Directory' },
      },
      {
        name: 'shared',
        sourceType: 'nfs',
        options: {
          nfsServer: '10.0.0.1',
          nfsPath: '/exports/data',
          nfsReadOnly: false,
        },
      },
      {
        name: 'disk',
        sourceType: 'csi',
        options: {
          csiDriver: 'disk.csi.everest.io',
          csiFsType: '',
          csiReadOnly: true,
          csiVolumeAttributes: [{ key: 'volumeHandle', value: 'd-1' }],
        },
      },
    ])
  })

  /**
   * 容器面板的「存储」直接写 container.volumeMounts，生成 YAML 也必须从这里取，
   * 否则界面上挂好了、YAML 里却没有 volumeMounts（挂载不生效）。
   */
  it('容器挂载写进生成的 volumeMounts，并能读回容器面板', () => {
    const form: DeploymentFormData = {
      ...withVolumes([
        {
          name: 'data',
          sourceType: 'hostPath',
          options: { path: '/data', hostPathType: 'DirectoryOrCreate' },
        },
      ]),
      containers: [
        {
          ...initialFormData.containers[0],
          name: 'app',
          image: 'nginx:1.25',
          container: {
            ...initialFormData.containers[0].container,
            name: 'app',
            image: 'nginx:1.25',
            volumeMounts: [
              {
                name: 'data',
                mountPath: '/usr/share/nginx/html',
                readOnly: true,
              },
            ],
          },
        },
      ],
    }

    const doc = yaml.load(generateWorkloadYaml(form, 'deployments')) as {
      spec: {
        template: { spec: { containers: Array<{ volumeMounts?: unknown }> } }
      }
    }
    expect(doc.spec.template.spec.containers[0].volumeMounts).toEqual([
      { name: 'data', mountPath: '/usr/share/nginx/html', readOnly: true },
    ])

    const parsed = parseYamlToFormData(
      generateWorkloadYaml(form, 'deployments'),
      'deployments',
      initialFormData
    )
    expect(parsed.containers[0].container.volumeMounts).toEqual([
      {
        name: 'data',
        mountPath: '/usr/share/nginx/html',
        subPath: undefined,
        readOnly: true,
      },
    ])
  })
})
