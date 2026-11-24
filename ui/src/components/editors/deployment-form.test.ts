import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

import {
  applyEditedManifest,
  generateWorkloadYaml,
  initialFormData,
  mergeEditedManifest,
  parseYamlToFormData,
  workloadWithServiceDocs,
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
            schedulerName: 'custom-scheduler',
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
    expect(template.spec.schedulerName).toBe('custom-scheduler')
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

  // 回归（第 17 轮 D-138）：selector 一度用的是「标签」栏（metadata.labels），
  // 而 Pod 模板用的是「Pod 标签」栏。只要用户在工作负载的标签里加了自定义键，
  // selector 就包含模板里没有的标签，apiserver 以
  // `selector does not match template labels` 直接拒收（实测 StatefulSet 新建就 422）。
  it('只填工作负载标签时，selector 仍是 Pod 模板标签的子集', () => {
    const labeled: DeploymentFormData = {
      ...formWithPorts([
        {
          name: 'http',
          containerPort: 80,
          protocol: 'TCP' as const,
          serviceType: 'none' as const,
        },
      ]),
      labels: [
        { key: 'app', value: 'web' },
        { key: 'tier', value: 'front' },
      ],
    }

    for (const resourceType of [
      'deployments',
      'statefulsets',
      'daemonsets',
    ] as const) {
      const doc = yaml.load(
        generateWorkloadYaml(labeled, resourceType)
      ) as GeneratedDoc & {
        spec: {
          selector: { matchLabels: Record<string, string> }
          template: { metadata: { labels: Record<string, string> } }
        }
      }
      const selector = doc.spec.selector.matchLabels
      const templateLabels = doc.spec.template.metadata.labels
      // selector 的每一个键都必须在模板标签里存在且同值
      for (const [key, value] of Object.entries(selector)) {
        expect(templateLabels[key], `${resourceType} 的 ${key}`).toEqual(value)
      }
      // 并且不能把 metadata 独有的标签带进 selector
      expect(selector, resourceType).toEqual(templateLabels)
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

  it('克隆场景（labels 仍是源负载标签）时，Service selector 用 Pod 模板标签', () => {
    // prepareCloneResource 只改写 Pod 模板标签与 selector，metadata.labels
    // 保持源负载的 app: nginx。生成的 Service 若拿 metadata 标签当 selector，
    // 就会选中源负载的 Pod（出现在源负载的相关资源里）。
    const cloneForm: DeploymentFormData = {
      ...formWithPorts([
        {
          containerPort: 80,
          protocol: 'TCP' as const,
          serviceType: 'NodePort' as const,
        },
      ]),
      name: 'nginx-copy',
      labels: [{ key: 'app', value: 'nginx' }],
      podLabels: [{ key: 'app', value: 'nginx-copy' }],
    }
    const docs = yaml.loadAll(
      generateWorkloadYaml(cloneForm, 'deployments')
    ) as unknown as GeneratedDoc[]

    const workload = docs.find((doc) => doc.kind === 'Deployment')
    const podTemplateLabels = (
      workload?.spec as { template?: { metadata?: { labels?: unknown } } }
    )?.template?.metadata?.labels
    expect(podTemplateLabels).toEqual({ app: 'nginx-copy' })

    const svc = docs.find((doc) => doc.kind === 'Service')
    expect(svc).toBeDefined()
    expect(svc?.metadata.name).toBe('nginx-copy-nodeport')
    expect(svc?.spec.selector).toEqual({ app: 'nginx-copy' })
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
        serviceName: 'web-nodeport',
      },
      {
        name: undefined,
        containerPort: 9090,
        protocol: 'TCP',
        serviceType: 'none',
      },
    ])
  })

  it('线上 Service 名与命名约定不一致时，反显后生成沿用线上名字', () => {
    // 老 Service / 手建 Service 可能是裸负载名：生成若按约定改名，
    // apply 会当成新建，撞上线上 Service 已占用的 nodePort 报 already allocated。
    const source = yaml.loadAll(
      [
        `apiVersion: v1
kind: Service
metadata:
  name: web
  namespace: default
  labels:
    app: web
spec:
  type: NodePort
  selector:
    app: web
  ports:
    - name: http
      port: 8080
      targetPort: 8080
      nodePort: 27862`,
        generateWorkloadYaml(
          formWithPorts([
            { containerPort: 8080, protocol: 'TCP', serviceType: 'none' },
          ]),
          'deployments'
        ),
      ].join('\n---\n')
    ) as unknown as GeneratedDoc[]
    const parsed = parseYamlToFormData(
      source.map((doc) => yaml.dump(doc)).join('\n---\n'),
      'deployments',
      initialFormData
    )

    expect(parsed.containers[0].ports[0]).toMatchObject({
      serviceType: 'NodePort',
      nodePort: 27862,
      serviceName: 'web',
    })

    const docs = yaml.loadAll(
      generateWorkloadYaml(parsed, 'deployments')
    ) as unknown as GeneratedDoc[]
    expect(docs[0].kind).toBe('Service')
    expect(docs[0].metadata.name).toBe('web')
    expect(docs[0].spec.ports).toEqual([
      { port: 8080, targetPort: 8080, nodePort: 27862 },
    ])
  })

  it('新建的端口行没有线上名字，仍按 <负载名>-<类型> 约定命名', () => {
    const docs = yaml.loadAll(
      generateWorkloadYaml(
        formWithPorts([
          {
            containerPort: 8080,
            protocol: 'TCP',
            serviceType: 'NodePort',
            serviceName: '',
          },
        ]),
        'deployments'
      )
    ) as unknown as GeneratedDoc[]
    expect(docs[0].metadata.name).toBe('web-nodeport')
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
 * Job 级参数（backoffLimit / parallelism / completions）：Job 直接放在 `spec` 下，
 * CronJob 放在 `spec.jobTemplate.spec` 下。表单值是字符串，空串表示「不写进 manifest」——
 * 新建时由集群套默认值，编辑时由 mergeEditedManifest 的深合并沿用线上对象当前的值。
 */
describe('Job 级参数', () => {
  const form = (
    overrides: Partial<DeploymentFormData> = {}
  ): DeploymentFormData => ({
    ...formWithPorts([
      { containerPort: 8080, protocol: 'TCP', serviceType: 'none' },
    ]),
    name: 'batch',
    ...overrides,
  })

  it('Job 写进 spec，CronJob 写进 spec.jobTemplate.spec', () => {
    const data = form({ backoffLimit: '3', parallelism: '2', completions: '5' })

    const job = yaml.load(generateWorkloadYaml(data, 'jobs')) as GeneratedDoc
    expect(job.spec.backoffLimit).toBe(3)
    expect(job.spec.parallelism).toBe(2)
    expect(job.spec.completions).toBe(5)

    const cronjob = yaml.load(
      generateWorkloadYaml(data, 'cronjobs')
    ) as GeneratedDoc
    expect(cronjob.spec.jobTemplate).toMatchObject({
      spec: { backoffLimit: 3, parallelism: 2, completions: 5 },
    })
    // Job 级参数不该落到 CronJob 的 spec 顶层（那里只有 schedule 等 CronJob 自己的字段）。
    expect(cronjob.spec).not.toHaveProperty('backoffLimit')
  })

  it('留空不写进 manifest，非法或越界的值按没填处理', () => {
    const empty = yaml.load(
      generateWorkloadYaml(form(), 'jobs')
    ) as GeneratedDoc
    expect(empty.spec).not.toHaveProperty('backoffLimit')
    expect(empty.spec).not.toHaveProperty('parallelism')
    expect(empty.spec).not.toHaveProperty('completions')

    // completions 至少 1，backoffLimit / parallelism 非负；非整数也当作没填。
    const invalid = yaml.load(
      generateWorkloadYaml(
        form({ backoffLimit: 'abc', parallelism: '-1', completions: '0' }),
        'jobs'
      )
    ) as GeneratedDoc
    expect(invalid.spec).not.toHaveProperty('backoffLimit')
    expect(invalid.spec).not.toHaveProperty('parallelism')
    expect(invalid.spec).not.toHaveProperty('completions')
  })

  it('把 Job / CronJob 上的参数反解回表单字符串', () => {
    const data = form({ backoffLimit: '4', parallelism: '1', completions: '6' })

    const parsedJob = parseYamlToFormData(
      generateWorkloadYaml(data, 'jobs'),
      'jobs',
      initialFormData
    )
    expect(parsedJob.backoffLimit).toBe('4')
    expect(parsedJob.parallelism).toBe('1')
    expect(parsedJob.completions).toBe('6')

    const parsedCron = parseYamlToFormData(
      generateWorkloadYaml(data, 'cronjobs'),
      'cronjobs',
      initialFormData
    )
    expect(parsedCron.backoffLimit).toBe('4')
    expect(parsedCron.parallelism).toBe('1')
    expect(parsedCron.completions).toBe('6')
  })
})

/**
 * 编辑页的反显输入：线上工作负载是单对象，Service 是独立对象，必须由页面
 * 查回来拼成多文档才能反显「网络」区块。这里盯的是「只收 selector 匹配的
 * Service」——把别的负载的 Service 拼进来会把端口反显到错误的容器端口行。
 */
describe('workloadWithServiceDocs', () => {
  const deployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'web', namespace: 'default' },
    spec: {
      selector: { matchLabels: { app: 'web' } },
      template: {
        metadata: { labels: { app: 'web' } },
        spec: {
          containers: [
            {
              name: 'app',
              image: 'nginx:1.25',
              ports: [{ containerPort: 8080, protocol: 'TCP' }],
            },
          ],
        },
      },
    },
  }

  const service = (name: string, selector: unknown, type = 'ClusterIP') => ({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name, namespace: 'default' },
    spec: { type, selector, ports: [{ port: 8080, targetPort: 8080 }] },
  })

  it('selector 匹配的 Service 拼进文档并反显到端口行', () => {
    const docs = workloadWithServiceDocs(deployment, [
      service('web', { app: 'web' }),
    ])
    expect(docs.map((doc) => (doc as { kind: string }).kind)).toEqual([
      'Deployment',
      'Service',
    ])

    const parsed = parseYamlToFormData(
      docs.map((doc) => yaml.dump(doc)).join('---\n'),
      'deployments',
      initialFormData
    )
    expect(parsed.containers[0].ports[0].serviceType).toBe('ClusterIP')
  })

  it('多个 Service 指向同一容器端口时各占一行，不互相覆盖', () => {
    // 常见配置：两行容器端口都是 80，一行 ClusterIP、一行 NodePort。
    const twoPortDeployment = {
      ...deployment,
      spec: {
        ...deployment.spec,
        template: {
          metadata: { labels: { app: 'web' } },
          spec: {
            containers: [
              {
                name: 'app',
                image: 'nginx:1.25',
                ports: [
                  { containerPort: 80, protocol: 'TCP' },
                  { containerPort: 80, protocol: 'TCP' },
                ],
              },
            ],
          },
        },
      },
    }
    const svc = (name: string, type: string, ports: unknown[]) => ({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name, namespace: 'default' },
      spec: { type, selector: { app: 'web' }, ports },
    })
    const parsed = parseYamlToFormData(
      workloadWithServiceDocs(twoPortDeployment, [
        svc('web', 'ClusterIP', [{ port: 80, targetPort: 80 }]),
        svc('web-nodeport', 'NodePort', [
          { port: 80, targetPort: 80, nodePort: 30888 },
        ]),
      ])
        .map((doc) => yaml.dump(doc))
        .join('---\n'),
      'deployments',
      initialFormData
    )
    expect(parsed.containers[0].ports).toEqual([
      {
        name: undefined,
        containerPort: 80,
        protocol: 'TCP',
        serviceType: 'ClusterIP',
        serviceName: 'web',
      },
      {
        name: undefined,
        containerPort: 80,
        protocol: 'TCP',
        serviceType: 'NodePort',
        nodePort: 30888,
        serviceName: 'web-nodeport',
      },
    ])
  })

  it('targetPort 写端口名时按名字匹配容器端口行', () => {
    const namedDeployment = {
      ...deployment,
      spec: {
        ...deployment.spec,
        template: {
          metadata: { labels: { app: 'web' } },
          spec: {
            containers: [
              {
                name: 'app',
                image: 'nginx:1.25',
                ports: [{ name: 'http', containerPort: 80, protocol: 'TCP' }],
              },
            ],
          },
        },
      },
    }
    const namedService = {
      ...service('web', { app: 'web' }),
      spec: {
        type: 'ClusterIP',
        selector: { app: 'web' },
        ports: [{ port: 8080, targetPort: 'http' }],
      },
    }
    const parsed = parseYamlToFormData(
      workloadWithServiceDocs(namedDeployment, [namedService])
        .map((doc) => yaml.dump(doc))
        .join('---\n'),
      'deployments',
      initialFormData
    )
    expect(parsed.containers[0].ports[0].serviceType).toBe('ClusterIP')
    expect(parsed.containers[0].ports[0].servicePort).toBe(8080)
  })

  it('selector 不匹配、空 selector 与 ExternalName 的 Service 不拼进来', () => {
    const docs = workloadWithServiceDocs(deployment, [
      service('other', { app: 'other' }),
      service('empty', {}),
      service('ext', undefined, 'ExternalName'),
    ])
    expect(docs).toHaveLength(1)
  })

  it('兼容 Rancher 风格 Service：selector 带额外键（在 Pod 标签上）也能反显', () => {
    // Rancher 创建的工作负载会在 Pod 模板标签上注入额外键（如
    // workload.user.cattle.io/*），Service 的 selector 也带这些键，但
    // spec.selector.matchLabels 里只有 app —— 旧逻辑只比对 matchLabels
    // 会漏掉这种 Service，现在以 Pod 模板标签为基准应能匹配。
    const rancherDeployment = {
      ...deployment,
      spec: {
        ...deployment.spec,
        selector: { matchLabels: { app: 'web' } },
        template: {
          ...deployment.spec.template,
          metadata: {
            labels: {
              app: 'web',
              'workload.user.cattle.io/workload-port': '80',
            },
          },
        },
      },
    }
    const rancherService = service('web', {
      app: 'web',
      'workload.user.cattle.io/workload-port': '80',
    })
    const docs = workloadWithServiceDocs(rancherDeployment, [rancherService])
    expect(docs.map((doc) => (doc as { kind: string }).kind)).toEqual([
      'Deployment',
      'Service',
    ])

    const parsed = parseYamlToFormData(
      docs.map((doc) => yaml.dump(doc)).join('---\n'),
      'deployments',
      initialFormData
    )
    expect(parsed.containers[0].ports[0].serviceType).toBe('ClusterIP')
  })

  it('克隆负载的 Service（selector 指向新名字）不会被反显进源负载', () => {
    const docs = workloadWithServiceDocs(deployment, [
      service('web-clone', { app: 'web-clone' }),
    ])
    expect(docs).toHaveLength(1)
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
            schedulerName: 'custom-scheduler',
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
      template: { spec: { schedulerName?: string } }
    }
    expect(deployment.template.spec.schedulerName).toBe('custom-scheduler')
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

/**
 * 服务账号：Pod 模板的 serviceAccountName 既要在生成侧总是写出来（否则编辑时
 * 把账号改回默认不会生效），也要能从线上对象反显，包括旧字段 serviceAccount。
 *
 * 六种工作负载默认走同一份表单，这里按类型逐个校验字段真的落在各自的 Pod 模板上
 * （CronJob 在 spec.jobTemplate.spec.template 下）。
 */
describe('服务账号的生成与反显', () => {
  const withServiceAccount = (
    serviceAccountName?: string,
    automountServiceAccountToken?: '' | 'true' | 'false'
  ): DeploymentFormData => ({
    ...initialFormData,
    name: 'web',
    namespace: 'default',
    labels: [{ key: 'app', value: 'web' }],
    containers: [
      { ...initialFormData.containers[0], name: 'app', image: 'nginx:1.25' },
    ],
    podSpec: {
      ...initialFormData.podSpec,
      serviceAccountName,
      automountServiceAccountToken,
    },
  })

  type WorkloadType = Parameters<typeof generateWorkloadYaml>[1]
  type PodSpecDoc = {
    serviceAccountName?: string
    automountServiceAccountToken?: boolean
  }
  const podSpecOf = (
    form: DeploymentFormData,
    type: WorkloadType
  ): PodSpecDoc => {
    const doc = yaml.load(generateWorkloadYaml(form, type)) as {
      spec: PodSpecDoc & {
        template?: { spec?: PodSpecDoc }
        jobTemplate?: { spec?: { template?: { spec?: PodSpecDoc } } }
      }
    }
    if (type === 'pods') return doc.spec
    if (type === 'cronjobs')
      return doc.spec.jobTemplate?.spec?.template?.spec ?? {}
    return doc.spec.template?.spec ?? {}
  }

  it.each<WorkloadType>([
    'deployments',
    'statefulsets',
    'daemonsets',
    'jobs',
    'cronjobs',
    'pods',
  ])('%s 的 Pod 模板写入服务账号', (type) => {
    expect(
      podSpecOf(withServiceAccount('web-sa'), type).serviceAccountName
    ).toBe('web-sa')
    expect(podSpecOf(withServiceAccount(''), type).serviceAccountName).toBe(
      'default'
    )
  })

  it('自动挂载令牌三态：未设置不写字段，显式值写成布尔', () => {
    const unset = withServiceAccount('web-sa')
    expect(podSpecOf(unset, 'deployments')).not.toHaveProperty(
      'automountServiceAccountToken'
    )
    expect(
      podSpecOf(withServiceAccount('web-sa', 'true'), 'deployments')
        .automountServiceAccountToken
    ).toBe(true)
    expect(
      podSpecOf(withServiceAccount('web-sa', 'false'), 'deployments')
        .automountServiceAccountToken
    ).toBe(false)
  })

  it('反显 serviceAccountName，并兼容旧字段 serviceAccount', () => {
    const doc = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'web', namespace: 'default' },
      spec: {
        selector: { matchLabels: { app: 'web' } },
        template: {
          metadata: { labels: { app: 'web' } },
          spec: {
            containers: [{ name: 'app', image: 'nginx' }],
            serviceAccount: 'legacy-sa',
            automountServiceAccountToken: false,
          },
        },
      },
    }
    const parsed = parseYamlToFormData(
      yaml.dump(doc),
      'deployments',
      initialFormData
    )
    expect(parsed.podSpec.serviceAccountName).toBe('legacy-sa')
    expect(parsed.podSpec.automountServiceAccountToken).toBe('false')
  })

  it('CronJob 从 jobTemplate 深层反显服务账号', () => {
    const doc = {
      apiVersion: 'batch/v1',
      kind: 'CronJob',
      metadata: { name: 'cron', namespace: 'default' },
      spec: {
        schedule: '*/5 * * * *',
        jobTemplate: {
          spec: {
            template: {
              metadata: { labels: { app: 'cron' } },
              spec: {
                containers: [{ name: 'app', image: 'nginx' }],
                serviceAccountName: 'cron-sa',
                automountServiceAccountToken: true,
              },
            },
          },
        },
      },
    }
    const parsed = parseYamlToFormData(
      yaml.dump(doc),
      'cronjobs',
      initialFormData
    )
    expect(parsed.podSpec.serviceAccountName).toBe('cron-sa')
    expect(parsed.podSpec.automountServiceAccountToken).toBe('true')
  })
})
