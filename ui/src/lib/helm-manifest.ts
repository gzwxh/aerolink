import * as yaml from 'js-yaml'

import type { HelmReleaseResource } from '@/types/api'

/**
 * 把 helm release 的 manifest 切成单个文档。
 *
 * 分隔线允许带 Helm 的 `--- # Source: templates/xxx.yaml` 注释形式，
 * 空文档直接丢掉。
 */
export function splitManifestDocuments(manifest: string): string[] {
  const docs: string[] = []
  let lines: string[] = []

  for (const line of manifest.split('\n')) {
    const marker = line.replace(/[ \t\r]+$/, '')
    if (marker === '---' || marker.startsWith('--- #')) {
      const doc = lines.join('\n').trim()
      if (doc) {
        docs.push(doc)
      }
      lines = []
      continue
    }
    lines.push(line)
  }

  const doc = lines.join('\n').trim()
  if (doc) {
    docs.push(doc)
  }
  return docs
}

/** 去掉文档首行的 `# Source: ...`，它不属于资源内容。 */
export function trimHelmSourceComment(content: string): string {
  const lines = content.split('\n')
  if (lines[0]?.trim().startsWith('# Source:')) {
    return lines.slice(1).join('\n').trim()
  }
  return content
}

/** 整篇只有注释或空行的文档（Helm 条件渲染关闭时留下的空段）。 */
export function isCommentOnlyManifestDocument(content: string): boolean {
  return content
    .split('\n')
    .every((line) => !line.trim() || line.trim().startsWith('#'))
}

/**
 * 从解析好的对象收集资源条目；遇到 `kind: List` 时下钻 `items`。
 *
 * helm 允许把一组资源包在 corev1 `List` 里交付（stakater 的 configmap chart 就这么渲染），
 * 真对象在 `items` 数组里；不下钻就会把整个 release 解析成 0 条（第 22 轮实测）。
 */
function collectResources(
  parsed: unknown,
  defaultNamespace: string,
  out: HelmReleaseResource[]
): void {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return
  }

  const { apiVersion, kind, metadata, items } = parsed as {
    apiVersion?: string
    kind?: string
    metadata?: { name?: string; namespace?: string }
    items?: unknown
  }

  if (kind === 'List') {
    // List 本身不是可跳转的资源，只当容器用。
    if (Array.isArray(items)) {
      for (const item of items) {
        collectResources(item, defaultNamespace, out)
      }
    }
    return
  }

  // 与 helm 的判定一致：没有 kind/metadata.name 的东西不算一个可跳转资源。
  if (!kind || !metadata?.name) {
    return
  }

  out.push({
    apiVersion: apiVersion || '',
    kind,
    name: metadata.name,
    namespace: metadata.namespace || defaultNamespace,
  })
}

/**
 * 从 manifest 解析这个 release 实际渲染出来的资源清单。
 *
 * `HelmRelease.status.resources` 是 Flux 风格的字段，本平台的 helm 后端从不填它，
 * 于是详情页的「资源」页签永远是空表（验收台账 D-117），而同一页的 manifest 页签
 * 本来就是拿 `spec.manifest` 渲染的 —— 数据一直都在，只是取错了地方。
 * 这里按与 manifest 页签相同的切分与解析口径产出条目；文档没写 namespace 时回落到
 * release 自己的命名空间，与 helm 的服务端默认行为一致。
 */
export function manifestResources(
  manifest: string,
  defaultNamespace: string
): HelmReleaseResource[] {
  const resources: HelmReleaseResource[] = []

  for (const doc of splitManifestDocuments(manifest)) {
    if (isCommentOnlyManifestDocument(doc)) {
      continue
    }

    let parsed: unknown
    try {
      parsed = yaml.load(trimHelmSourceComment(doc))
    } catch {
      // 单个文档解不出来只少几条记录，不该让整页崩掉。
      continue
    }

    collectResources(parsed, defaultNamespace, resources)
  }

  return resources
}
