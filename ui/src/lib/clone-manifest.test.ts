import { describe, expect, it } from 'vitest'

import { prepareCloneResource } from './clone-manifest'

const deployment = {
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: {
    name: 'nginx',
    namespace: 'web',
    uid: 'uid-1',
    resourceVersion: '42',
    labels: { app: 'nginx' },
    annotations: {
      'deployment.kubernetes.io/revision': '5',
      'kubernetes.io/description': '示例',
    },
  },
  spec: {
    replicas: 2,
    selector: { matchLabels: { app: 'nginx' } },
    template: {
      metadata: { labels: { app: 'nginx' } },
      spec: { containers: [{ name: 'nginx', image: 'nginx:1' }] },
    },
  },
  status: { replicas: 2, readyReplicas: 2 },
}

describe('prepareCloneResource', () => {
  it('默认目标名是 `<源名>-copy`，显式传入 targetName 时用它', () => {
    expect(
      prepareCloneResource(deployment, 'deployments', 'nginx').metadata
    ).toMatchObject({ name: 'nginx-copy' })
    expect(
      prepareCloneResource(deployment, 'deployments', 'nginx', 'nginx-clone')
        .metadata
    ).toMatchObject({ name: 'nginx-clone' })
  })

  it('剥离服务端字段与 status，清掉 revision 注解', () => {
    const cloned = prepareCloneResource(
      deployment,
      'deployments',
      'nginx',
      'nginx-clone'
    )

    expect(cloned.metadata).not.toHaveProperty('uid')
    expect(cloned.metadata).not.toHaveProperty('resourceVersion')
    expect(cloned.status).toBeUndefined()
    expect(cloned.metadata.annotations).toEqual({
      'kubernetes.io/description': '示例',
    })
  })

  it('selector 与 Pod 模板标签指向新名字，两个克隆互不争抢 Pod', () => {
    const cloned = prepareCloneResource(
      deployment,
      'deployments',
      'nginx',
      'nginx-clone'
    ) as {
      spec: {
        selector: { matchLabels: Record<string, string> }
        template: { metadata: { labels: Record<string, string> } }
      }
    }

    expect(cloned.spec.selector.matchLabels).toEqual({ app: 'nginx-clone' })
    expect(cloned.spec.template.metadata.labels).toEqual({
      app: 'nginx-clone',
    })
  })
})
