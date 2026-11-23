import { describe, expect, it } from 'vitest'

import {
  isCommentOnlyManifestDocument,
  manifestResources,
  splitManifestDocuments,
} from './helm-manifest'

// 回归（第 22 轮 D-117）：Release 详情页的「资源」页签读的是 status.resources，
// 那是 Flux 风格的字段，本平台的 helm 后端从不填，于是页签永远空着。现在回落到
// 按 spec.manifest 解析，这里钉住解析口径。
describe('从 manifest 解析 release 的资源清单', () => {
  it('多文档按顺序解析出 kind/name/apiVersion/namespace', () => {
    const manifest = [
      '# Source: configmap-demo/templates/cm.yaml',
      'apiVersion: v1',
      'kind: ConfigMap',
      'metadata:',
      '  name: demo-cm',
      'data:',
      '  k: v',
      '--- # Source: configmap-demo/templates/svc.yaml',
      'apiVersion: v1',
      'kind: Service',
      'metadata:',
      '  name: demo-svc',
    ].join('\n')

    expect(manifestResources(manifest, 'ui-smoke')).toEqual([
      {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        name: 'demo-cm',
        namespace: 'ui-smoke',
      },
      {
        apiVersion: 'v1',
        kind: 'Service',
        name: 'demo-svc',
        namespace: 'ui-smoke',
      },
    ])
  })

  it('文档自带 namespace 时以文档为准，缺省才回落到 release 的命名空间', () => {
    const manifest = [
      'apiVersion: v1',
      'kind: Secret',
      'metadata:',
      '  name: s1',
      '  namespace: elsewhere',
    ].join('\n')

    expect(manifestResources(manifest, 'ui-smoke')[0].namespace).toBe(
      'elsewhere'
    )
  })

  it('集群级资源没有 namespace 时回落到 release 命名空间，由链接层按 scope 忽略', () => {
    const items = manifestResources(
      [
        'apiVersion: rbac.authorization.k8s.io/v1',
        'kind: ClusterRole',
        'metadata:',
        '  name: reader',
      ].join('\n'),
      'ui-smoke'
    )
    expect(items).toHaveLength(1)
    // 解析层不做 scope 判断（它没有资源登记表），兜底填上 release 命名空间；
    // 链接由 getResourceDetailPath 的 isClusterScopedResource 忽略掉它。
    expect(items[0].kind).toBe('ClusterRole')
    expect(items[0].namespace).toBe('ui-smoke')
  })

  it('丢掉纯注释与空文档，也丢掉没有 kind 或没有名字的对象', () => {
    const manifest = [
      '# 整篇都是注释的段（Helm 条件渲染关掉时留下）',
      '# nothing here',
      '---',
      '',
      '---',
      'apiVersion: v1',
      'kind: ConfigMap',
      'metadata:',
      '  labels:',
      '    a: b',
      '---',
      'apiVersion: v1',
      'metadata:',
      '  name: no-kind-at-all',
    ].join('\n')

    expect(manifestResources(manifest, 'ui-smoke')).toEqual([])
    expect(splitManifestDocuments(manifest)).toHaveLength(3)
    expect(isCommentOnlyManifestDocument('# 只有注释\n\n  ')).toBe(true)
  })

  it('单个文档解析失败只少一条，不会让整页资源清单崩掉', () => {
    const manifest = [
      'apiVersion: v1',
      'kind: ConfigMap',
      'metadata:',
      '  name: good-1',
      '---',
      'this: [is not valid yaml',
      '---',
      'apiVersion: v1',
      'kind: ConfigMap',
      'metadata:',
      '  name: good-2',
    ].join('\n')

    const items = manifestResources(manifest, 'ui-smoke')
    expect(items.map((item) => item.name)).toEqual(['good-1', 'good-2'])
  })

  it('kind: List 包裹的 manifest 要下钻 items（第 22 轮实测：stakater configmap chart 就是这个形状）', () => {
    const manifest = [
      'apiVersion: v1',
      'kind: List',
      'items:',
      '- apiVersion: v1',
      '  kind: ConfigMap',
      '  metadata:',
      '    name: configmapname',
      '- apiVersion: v1',
      '  kind: Service',
      '  metadata:',
      '    name: svc-in-list',
      '    namespace: elsewhere',
    ].join('\n')

    const got = manifestResources(manifest, 'ui-smoke').map(
      (item) => `${item.kind}/${item.namespace}/${item.name}`
    )
    // List 本身只当容器，不进结果；里面的条目走同一套命名空间回落规则。
    expect(got).toEqual([
      'ConfigMap/ui-smoke/configmapname',
      'Service/elsewhere/svc-in-list',
    ])
  })

  it('空的 kind: List 不会凭空造出一条记录', () => {
    expect(
      manifestResources(['apiVersion: v1', 'kind: List'].join('\n'), 'ui-smoke')
    ).toEqual([])
  })

  it('空 manifest 返回空数组', () => {
    expect(manifestResources('', 'ui-smoke')).toEqual([])
  })
})
