/**
 * 克隆资源的 manifest 预处理：剥离服务端字段、改名、清理会让 API 拒绝
 * 或语义错误的注解。
 *
 * 单独放在 lib：克隆弹窗（clone-resource-dialog）与工作负载表单克隆
 * （deployment-create-page 的克隆分支）共用同一套预处理，纯数据变换
 * 也便于脱离 DOM 做测试。
 */
import type { ResourceType } from '@/types/api'

import { alignWorkloadSelector } from './clone-workload'

export type MutableResource = Record<string, unknown> & {
  metadata?: Record<string, unknown>
  spec?: Record<string, unknown>
}

const serverMetadataFields = [
  'uid',
  'resourceVersion',
  'generation',
  'creationTimestamp',
  'deletionTimestamp',
  'deletionGracePeriodSeconds',
  'managedFields',
  'selfLink',
  'ownerReferences',
  'finalizers',
  'generateName',
]

const controllerLabelKeys = [
  'controller-uid',
  'job-name',
  'batch.kubernetes.io/controller-uid',
  'batch.kubernetes.io/job-name',
  'batch.kubernetes.io/job-completion-index',
  'pod-template-hash',
  'controller-revision-hash',
  'statefulset.kubernetes.io/pod-name',
  'apps.kubernetes.io/pod-index',
]

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  return value as Record<string, unknown>
}

function removeControllerLabels(metadata?: Record<string, unknown>) {
  const labels = asRecord(metadata?.labels)
  if (!labels) return

  controllerLabelKeys.forEach((key) => delete labels[key])
}

function removeInjectedServiceAccountVolumes(spec: Record<string, unknown>) {
  const volumes = Array.isArray(spec.volumes) ? spec.volumes : []
  const injectedVolumeNames = new Set(
    volumes.flatMap((volume) => {
      const item = asRecord(volume)
      const name = item?.name
      return typeof name === 'string' && name.startsWith('kube-api-access-')
        ? [name]
        : []
    })
  )

  if (injectedVolumeNames.size === 0) return

  spec.volumes = volumes.filter((volume) => {
    const name = asRecord(volume)?.name
    return typeof name !== 'string' || !injectedVolumeNames.has(name)
  })

  for (const containerField of ['containers', 'initContainers']) {
    const containers = spec[containerField]
    if (!Array.isArray(containers)) continue

    for (const container of containers) {
      const item = asRecord(container)
      if (!item || !Array.isArray(item.volumeMounts)) continue
      item.volumeMounts = item.volumeMounts.filter((mount) => {
        const name = asRecord(mount)?.name
        return typeof name !== 'string' || !injectedVolumeNames.has(name)
      })
    }
  }
}

function cleanService(resource: MutableResource) {
  const spec = asRecord(resource.spec)
  if (!spec) return

  delete spec.clusterIP
  delete spec.clusterIPs
  delete spec.healthCheckNodePort

  if (Array.isArray(spec.ports)) {
    for (const port of spec.ports) {
      const item = asRecord(port)
      if (item) delete item.nodePort
    }
  }
}

function cleanVolumeClaim(resource: MutableResource) {
  const spec = asRecord(resource.spec)
  if (spec) delete spec.volumeName

  const annotations = asRecord(resource.metadata?.annotations)
  if (!annotations) return

  delete annotations['pv.kubernetes.io/bind-completed']
  delete annotations['pv.kubernetes.io/bound-by-controller']
  delete annotations['volume.kubernetes.io/selected-node']
  delete annotations['volume.kubernetes.io/storage-provisioner']
  delete annotations['volume.beta.kubernetes.io/storage-provisioner']
}

/**
 * 生成源资源的克隆草稿，目标名默认 `<源名>-copy`。
 * 工作负载的 selector 与 Pod 模板标签在草稿阶段就改成新名字，草稿本身要自洽。
 */
export function prepareCloneResource(
  resource: unknown,
  resourceType: ResourceType,
  sourceName: string,
  targetName = `${sourceName}-copy`
) {
  const cloned = structuredClone(resource) as MutableResource
  const metadata = asRecord(cloned.metadata) || {}

  serverMetadataFields.forEach((field) => delete metadata[field])
  metadata.name = targetName
  cloned.metadata = metadata
  delete cloned.status
  delete cloned.metrics

  // 见 alignWorkloadSelector 与 clone-service.ts。
  alignWorkloadSelector(cloned, resource, resourceType, sourceName, targetName)

  const annotations = asRecord(metadata.annotations)
  if (annotations) {
    delete annotations['kubectl.kubernetes.io/last-applied-configuration']
    delete annotations['deployment.kubernetes.io/revision']
    delete annotations['deprecated.daemonset.template.generation']
    delete annotations['kubernetes.io/config.mirror']
    delete annotations['kubernetes.io/config.seen']
    delete annotations['kubernetes.io/config.source']
  }

  if (resourceType === 'jobs') {
    const spec = asRecord(cloned.spec)
    if (spec) {
      delete spec.selector
      delete spec.manualSelector
      removeControllerLabels(metadata)
      removeControllerLabels(asRecord(asRecord(spec.template)?.metadata))
    }
  }

  if (resourceType === 'pods') {
    const spec = asRecord(cloned.spec)
    if (spec) {
      delete spec.nodeName
      delete spec.ephemeralContainers
      removeInjectedServiceAccountVolumes(spec)
    }
    removeControllerLabels(metadata)
  }

  if (resourceType === 'services') {
    cleanService(cloned)
  }

  if (resourceType === 'persistentvolumeclaims') {
    cleanVolumeClaim(cloned)
  }

  if (resourceType === 'persistentvolumes') {
    const spec = asRecord(cloned.spec)
    if (spec) delete spec.claimRef
  }

  if (resourceType === 'serviceaccounts') {
    delete cloned.secrets
  }

  if (resourceType === 'namespaces') {
    const spec = asRecord(cloned.spec)
    if (spec) delete spec.finalizers
  }

  if (resourceType === 'storageclasses' && annotations) {
    delete annotations['storageclass.kubernetes.io/is-default-class']
    delete annotations['storageclass.beta.kubernetes.io/is-default-class']
  }

  return cloned
}
