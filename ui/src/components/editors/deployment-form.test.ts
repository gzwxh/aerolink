import { describe, expect, it } from 'vitest'

import {
  generateWorkloadYaml,
  initialFormData,
  mergeEditedManifest,
} from './deployment-form'

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
 * Service 是独立对象：工作负载表单只描述容器端口，不再顺带产出 Service 文档，
 * 关联改由 Service 自己的选择器决定（在「服务」页面维护）。
 */
describe('工作负载 YAML 生成', () => {
  const formData = {
    ...initialFormData,
    name: 'web',
    namespace: 'default',
    labels: [{ key: 'app', value: 'web' }],
    containers: [
      {
        ...initialFormData.containers[0],
        name: 'app',
        image: 'nginx:1.25',
        ports: [
          { name: 'http', containerPort: 8080, protocol: 'TCP' as const },
        ],
      },
    ],
  }

  it('生成单个工作负载文档，容器端口保留', () => {
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
})
