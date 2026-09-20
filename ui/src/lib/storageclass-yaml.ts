import * as yaml from 'js-yaml'

import { parseMountOptions } from './mount-options'

/**
 * StorageClass 创建表单的取值与 YAML 生成。
 *
 * 抽成纯函数是为了能直接单测：表单里的一次点击最终变成什么 YAML，是本模块的唯一职责，
 * 页面只负责收集输入与提示错误。
 */

// StorageClass 是集群级资源：没有命名空间，创建后立即对全集群生效。
export type ReclaimPolicy = 'Delete' | 'Retain'
export type VolumeBindingMode = 'Immediate' | 'WaitForFirstConsumer'

export interface ParameterRow {
  key: string
  value: string
}

export interface StorageClassFormData {
  name: string
  provisioner: string
  reclaimPolicy: ReclaimPolicy
  volumeBindingMode: VolumeBindingMode
  allowVolumeExpansion: boolean
  isDefault: boolean
  mountOptions: string
  allowedTopologies: string
  parameters: ParameterRow[]
}

/** allowedTopologies 的一条 term（一行文本 → 一个表达式）。 */
export interface TopologyTerm {
  matchLabelExpressions: Array<{ key: string; values: string[] }>
}

export const initialData: StorageClassFormData = {
  name: '',
  provisioner: '',
  reclaimPolicy: 'Delete',
  volumeBindingMode: 'Immediate',
  allowVolumeExpansion: false,
  isDefault: false,
  mountOptions: '',
  allowedTopologies: '',
  parameters: [{ key: '', value: '' }],
}

// 常见 provisioner 仅作为输入建议，最终以用户填写的值为准。
export const commonProvisioners = [
  'kubernetes.io/no-provisioner',
  'rancher.io/local-path',
  'csi-hostpath',
  'nfs.csi.k8s.io',
  'ebs.csi.aws.com',
  'disk.csi.azure.com',
  'cinder.csi.openstack.org',
]

export const defaultClassAnnotation =
  'storageclass.kubernetes.io/is-default-class'

// 纯静态卷的驱动：没有动态供给，PV 必须人工预先创建。
export const staticProvisioner = 'kubernetes.io/no-provisioner'

/**
 * 切换 provisioner 时要落到的卷绑定模式。
 *
 * 纯静态卷（no-provisioner）没有动态供给，用 Immediate 会在 PVC 一创建时就去绑任意可用
 * PV，对带 nodeAffinity 的 node-local PV 会绑到 Pod 调度不上去的节点，表现为「PVC 已
 * Bound 但 Pod 一直 Pending」。所以切到它时主动改成 WaitForFirstConsumer；用户手动改回
 * 不受影响（只在当前是 Immediate 时切）。
 */
export function resolveVolumeBindingMode(
  provisioner: string,
  current: VolumeBindingMode
): VolumeBindingMode {
  if (provisioner.trim() === staticProvisioner && current === 'Immediate') {
    return 'WaitForFirstConsumer'
  }
  return current
}

/**
 * 出现多次的参数名。生成 YAML 时按 key 累加，后面的会静默覆盖前面的，用户会以为两行都
 * 生效，因此表单要把它们标出来并拦下提交。
 */
export function findDuplicateParameterKeys(
  parameters: ParameterRow[]
): Set<string> {
  const counts = new Map<string, number>()
  for (const row of parameters) {
    const key = row.key.trim()
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return new Set(
    [...counts].filter(([, count]) => count > 1).map(([key]) => key)
  )
}

export { parseMountOptions }

/**
 * 解析 allowedTopologies 文本：每行一条 matchLabelExpression，写成 `key=value1,value2`
 * （多个值用逗号分隔），每行生成一个 term。这覆盖的是「一行一个表达式」的常见写法；
 * 一个 term 里带多个表达式的情况请用创建页的 YAML 编辑器直接写。
 *
 * 返回解析结果与写错的行，供表单标红并拦下提交。
 */
export function parseAllowedTopologies(value: string): {
  terms: TopologyTerm[]
  invalidLines: string[]
} {
  const terms: TopologyTerm[] = []
  const invalidLines: string[] = []
  for (const raw of value.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const separator = line.indexOf('=')
    const key = separator > 0 ? line.slice(0, separator).trim() : ''
    const values =
      separator > 0
        ? line
            .slice(separator + 1)
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
        : []
    if (!key || values.length === 0) {
      invalidLines.push(line)
      continue
    }
    terms.push({ matchLabelExpressions: [{ key, values }] })
  }
  return { terms, invalidLines }
}

export function generateStorageClassYaml(data: StorageClassFormData): string {
  const metadata: Record<string, unknown> = { name: data.name.trim() }
  if (data.isDefault) {
    metadata.annotations = { [defaultClassAnnotation]: 'true' }
  }

  const doc: Record<string, unknown> = {
    apiVersion: 'storage.k8s.io/v1',
    kind: 'StorageClass',
    metadata,
    provisioner: data.provisioner.trim(),
    reclaimPolicy: data.reclaimPolicy,
    volumeBindingMode: data.volumeBindingMode,
  }

  if (data.allowVolumeExpansion) {
    doc.allowVolumeExpansion = true
  }

  const parameters = data.parameters.reduce<Record<string, string>>(
    (acc, row) => {
      const key = row.key.trim()
      if (key) acc[key] = row.value.trim()
      return acc
    },
    {}
  )
  if (Object.keys(parameters).length > 0) {
    doc.parameters = parameters
  }

  const mountOptions = parseMountOptions(data.mountOptions)
  if (mountOptions.length > 0) {
    doc.mountOptions = mountOptions
  }

  // 写错的行由表单拦下（这里只写能解析出来的部分）。
  const { terms } = parseAllowedTopologies(data.allowedTopologies)
  if (terms.length > 0) {
    doc.allowedTopologies = terms
  }

  return yaml.dump(doc, { indent: 2, noRefs: true })
}
