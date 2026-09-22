import jsonpath from 'jsonpath'
import { Deployment } from 'kubernetes-types/apps/v1'
import {
  Container,
  ContainerStatus,
  EphemeralContainer,
  Event as KubernetesEvent,
  Pod,
  Service,
} from 'kubernetes-types/core/v1'
import { ObjectMeta } from 'kubernetes-types/meta/v1'

import { CustomResource, ResourceType } from '@/types/api'
import { DeploymentStatusType, PodStatus, SimpleContainer } from '@/types/k8s'

import {
  getResourceDetailPath,
  isClusterScopedResource,
  resourceMetadataList,
} from './resource-metadata'
import { getAge } from './utils'

// 该函数获取 Kubernetes 中 Pod 的状态。
// @see 上游实现：https://github.com/kubernetes/kubernetes/blob/master/pkg/printers/internalversion/printers.go#L881
export function getPodStatus(pod?: Pod): PodStatus {
  if (!pod || !pod.status) {
    return {
      readyContainers: 0,
      totalContainers: 0,
      reason: 'Unknown',
      restarts: 0,
      restartString: '0',
    }
  }
  let restarts = 0
  let restartableInitContainerRestarts = 0
  let totalContainers = pod.spec?.containers?.length || 0
  let readyContainers = 0
  let lastRestartDate = new Date(0)
  let lastRestartableInitContainerRestartDate = new Date(0)

  const podPhase = pod.status?.phase || 'Unknown'
  let reason = podPhase

  if (pod.status?.reason && pod.status.reason !== '') {
    reason = pod.status.reason
  }

  // 如果 Pod 带有 {type:PodScheduled, reason:SchedulingGated}，把 reason 设为 'SchedulingGated'。
  if (pod.status?.conditions) {
    for (const condition of pod.status.conditions) {
      if (
        condition.type === 'PodScheduled' &&
        condition.reason === 'SchedulingGated'
      ) {
        reason = 'SchedulingGated'
      }
    }
  }

  const initContainers = new Map<
    string,
    { name: string; restartPolicy?: string }
  >()
  if (pod.spec?.initContainers) {
    for (const container of pod.spec.initContainers) {
      initContainers.set(container.name, container)
      if (isRestartableInitContainer(container)) {
        totalContainers++
      }
    }
  }

  let initializing = false

  if (pod.status?.initContainerStatuses) {
    for (let i = 0; i < pod.status.initContainerStatuses.length; i++) {
      const container = pod.status.initContainerStatuses[i]
      restarts += container.restartCount || 0

      if (container.lastState?.terminated?.finishedAt) {
        const terminatedDate = new Date(
          container.lastState.terminated.finishedAt
        )
        if (lastRestartDate < terminatedDate) {
          lastRestartDate = terminatedDate
        }
      }

      const initContainer = initContainers.get(container.name)
      if (initContainer && isRestartableInitContainer(initContainer)) {
        restartableInitContainerRestarts += container.restartCount || 0
        if (container.lastState?.terminated?.finishedAt) {
          const terminatedDate = new Date(
            container.lastState.terminated.finishedAt
          )
          if (lastRestartableInitContainerRestartDate < terminatedDate) {
            lastRestartableInitContainerRestartDate = terminatedDate
          }
        }
      }

      if (container.state?.terminated?.exitCode === 0) {
        continue
      } else if (
        initContainer &&
        isRestartableInitContainer(initContainer) &&
        container.started
      ) {
        if (container.ready) {
          readyContainers++
        }
        continue
      } else if (container.state?.terminated) {
        // 初始化失败
        if (!container.state.terminated.reason) {
          if (container.state.terminated.signal) {
            reason = `Init:Signal:${container.state.terminated.signal}`
          } else {
            reason = `Init:ExitCode:${container.state.terminated.exitCode}`
          }
        } else {
          reason = 'Init:' + container.state.terminated.reason
        }
        initializing = true
      } else if (
        container.state?.waiting?.reason &&
        container.state.waiting.reason !== 'PodInitializing'
      ) {
        reason = 'Init:' + container.state.waiting.reason
        initializing = true
      } else {
        reason = `Init:${i}/${pod.spec?.initContainers?.length || 0}`
        initializing = true
      }
      break
    }
  }

  if (!initializing || isPodInitializedConditionTrue(pod.status)) {
    restarts = restartableInitContainerRestarts
    lastRestartDate = lastRestartableInitContainerRestartDate
    let hasRunning = false

    if (pod.status?.containerStatuses) {
      for (let i = pod.status.containerStatuses.length - 1; i >= 0; i--) {
        const container = pod.status.containerStatuses[i]

        restarts += container.restartCount || 0
        if (container.lastState?.terminated?.finishedAt) {
          const terminatedDate = new Date(
            container.lastState.terminated.finishedAt
          )
          if (lastRestartDate < terminatedDate) {
            lastRestartDate = terminatedDate
          }
        }

        if (container.state?.waiting?.reason) {
          reason = container.state.waiting.reason
        } else if (container.state?.terminated?.reason) {
          reason = container.state.terminated.reason
        } else if (
          container.state?.terminated &&
          !container.state.terminated.reason
        ) {
          if (container.state.terminated.signal) {
            reason = `Signal:${container.state.terminated.signal}`
          } else {
            reason = `ExitCode:${container.state.terminated.exitCode}`
          }
        } else if (container.ready && container.state?.running) {
          hasRunning = true
          readyContainers++
        }
      }
    }

    if (reason === 'Completed' && hasRunning) {
      if (hasPodReadyCondition(pod.status?.conditions)) {
        reason = 'Running'
      } else {
        reason = 'NotReady'
      }
    }
  }

  if (pod.metadata?.deletionTimestamp && pod.status?.reason === 'NodeLost') {
    reason = 'Unknown'
  } else if (pod.metadata?.deletionTimestamp && !isPodPhaseTerminal(podPhase)) {
    reason = 'Terminating'
  }

  let restartsStr = restarts.toString()
  if (restarts !== 0 && lastRestartDate.getTime() > 0) {
    restartsStr = `${restarts} (${getAge(lastRestartDate.toString())})`
  }

  return {
    readyContainers,
    totalContainers,
    reason,
    restarts,
    restartString: restartsStr,
  }
}

export type PodPort = {
  containerName: string
  port: NonNullable<Container['ports']>[number]
}

export function getPodPorts(pod: Pod): PodPort[] {
  return (pod.spec?.containers || []).flatMap((container) =>
    (container.ports || []).map((port) => ({
      containerName: container.name,
      port,
    }))
  )
}

export function getContainerState(status?: ContainerStatus) {
  if (status?.state?.running) {
    return 'Running'
  }
  if (status?.state?.terminated) {
    return (
      status.state.terminated.reason ||
      (status.state.terminated.exitCode === 0 ? 'Completed' : 'Terminated')
    )
  }
  if (status?.state?.waiting) {
    return status.state.waiting.reason || 'Waiting'
  }
  return 'Waiting'
}

export function getLastContainerState(status?: ContainerStatus) {
  if (status?.lastState?.terminated) {
    const terminated = status.lastState.terminated
    return [
      terminated.reason || 'Terminated',
      terminated.exitCode !== undefined ? `exit ${terminated.exitCode}` : '',
    ]
      .filter(Boolean)
      .join(', ')
  }
  if (status?.lastState?.waiting) {
    return status.lastState.waiting.reason || 'Waiting'
  }
  if (status?.lastState?.running) {
    return 'Running'
  }
  return undefined
}

export function getEventTime(event: KubernetesEvent) {
  const timestamp =
    event.lastTimestamp ||
    event.eventTime ||
    event.metadata?.creationTimestamp ||
    event.firstTimestamp
  return timestamp ? new Date(timestamp) : new Date(0)
}

// 辅助函数：判断 pod 阶段是否为终态
function isPodPhaseTerminal(phase: string): boolean {
  return phase === 'Failed' || phase === 'Succeeded'
}

export function getPodErrorMessage(pod: Pod): string | undefined {
  if (!pod.status || !pod.status.containerStatuses) {
    return undefined
  }
  if (pod.status.phase === 'Running' || pod.status.phase === 'Succeeded') {
    return ''
  }
  if (pod.status.containerStatuses.length === 0) {
    return ''
  }

  for (const container of pod.status.containerStatuses) {
    if (container.state?.waiting?.reason !== '') {
      return container.state?.waiting?.message || ''
    }
    if (container.state?.terminated?.reason !== '') {
      return container.state?.terminated?.message || ''
    }
    if (container.state?.terminated?.signal) {
      return `Signal: ${container.state.terminated.signal}`
    }
    if (container.state?.terminated?.exitCode !== 0) {
      return `ExitCode: ${container.state.terminated.exitCode}`
    }
  }

  return undefined
}

export function getPrinterColumnValue(
  resource: CustomResource,
  jsonPath: string
): string | number | boolean | undefined {
  let normalizedPath = ''
  let quote = ''
  let escaped = false

  for (let i = 0; i < jsonPath.length; i++) {
    const char = jsonPath[i]

    if (quote) {
      normalizedPath += char
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === quote) {
        quote = ''
      }
    } else if (char === "'" || char === '"') {
      quote = char
      normalizedPath += char
    } else if (char === '[' && jsonPath[i + 1] === ']') {
      normalizedPath += '[0]'
      i++
    } else {
      normalizedPath += char
    }
  }

  const queryPath = normalizedPath.startsWith('$')
    ? normalizedPath
    : normalizedPath.startsWith('.')
      ? `$${normalizedPath}`
      : `$.${normalizedPath}`

  let values: unknown[]
  try {
    values = jsonpath
      .query(resource, queryPath)
      .filter((value) => value !== undefined && value !== null)
  } catch {
    return undefined
  }

  if (values.length === 0) {
    return undefined
  }

  const printableValues = values.map((value) => {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      return value
    }

    return JSON.stringify(value)
  })

  return printableValues.length === 1
    ? printableValues[0]
    : printableValues.join(', ')
}

export function getDeploymentStatus(
  deployment: Deployment
): DeploymentStatusType {
  if (!deployment.status) {
    return 'Unknown'
  }

  const status = deployment.status
  const spec = deployment.spec

  // 检查 Deployment 是否正在被删除
  if (deployment.metadata?.deletionTimestamp) {
    return 'Terminating'
  }

  // 检查 Deployment 是否已暂停
  if (spec?.paused) {
    return 'Paused'
  }

  // 获取副本数
  const replicas = status.replicas || 0
  if (replicas === 0) {
    return 'Scaled Down'
  }
  const desiredReplicas = spec?.replicas || 0
  const actualReplicas = status.replicas || 0
  const availableReplicas = status.availableReplicas || 0
  const readyReplicas = status.readyReplicas || 0

  if (desiredReplicas !== actualReplicas) {
    return 'Progressing'
  }
  if (availableReplicas != actualReplicas || readyReplicas != actualReplicas) {
    return 'Progressing'
  }

  // 所有副本都已就绪且可用
  if (
    readyReplicas === desiredReplicas &&
    availableReplicas === desiredReplicas
  ) {
    return 'Available'
  }

  return 'Unknown'
}

export function isStandardK8sResource(kind: string): boolean {
  const normalizedKind = kind.toLowerCase()
  return resourceMetadataList.some(
    (resource) =>
      resource.type === normalizedKind ||
      resource.singular === normalizedKind ||
      resource.singularLabel.toLowerCase() === normalizedKind ||
      resource.pluralLabel.toLowerCase() === normalizedKind ||
      resource.shortLabel?.toLowerCase() === normalizedKind
  )
}

export function getCRDResourcePath(
  kind: string,
  apiVersion: string,
  namespace?: string,
  name?: string
): string {
  const group = apiVersion.includes('/') ? apiVersion.split('/')[0] : ''
  return namespace
    ? `/crds/${kind}.${group}/${namespace}/${name}`
    : `/crds/${kind}.${group}/${name}`
}

// 获取 pod 的属主引用信息
export function getOwnerInfo(metadata?: ObjectMeta) {
  if (!metadata) {
    return null
  }
  const ownerRefs = metadata.ownerReferences
  if (!ownerRefs || ownerRefs.length === 0) {
    return null
  }

  const ownerRef = ownerRefs[0]

  const resourcePath = ownerRef.kind.toLowerCase() + 's'
  if (isStandardK8sResource(ownerRef.kind)) {
    return {
      kind: ownerRef.kind,
      name: ownerRef.name,
      path: getResourceDetailPath(
        resourcePath,
        ownerRef.name,
        isClusterScopedResource(resourcePath as ResourceType)
          ? undefined
          : metadata.namespace
      ),
      controller: ownerRef.controller || false,
    }
  } else {
    const apiVersion = ownerRef.apiVersion || ''
    const group = apiVersion.includes('/') ? apiVersion.split('/')[0] : ''
    return {
      kind: ownerRef.kind,
      name: ownerRef.name,
      path: `/crds/${ownerRef.kind.toLowerCase()}s.${group}/${metadata.namespace}/${ownerRef.name}`,
      controller: ownerRef.controller || false,
    }
  }
}

// @see 上游实现：https://github.com/kubernetes/kubernetes/blob/bd44685eadc64c8cd46a8259f027f57ba9724a85/pkg/printers/internalversion/printers.go#L1317-L1347
/**
 * 选出与某个工作负载关联的 Service。
 *
 * 判定同时认两种来源：
 *   - 名字等于工作负载名、或以 `<工作负载名>-` 开头（控制台过去自动生成的命名习惯）；
 *   - Service 的 selector 被工作负载的 Pod 标签完全覆盖 —— 这才是真正决定关联的规则
 *     （Service 选中哪些 Pod 由它自己的 selector 决定）。
 *
 * 关联本身在「服务」页面维护，这里只用于只读展示与跳转。
 */
export function servicesForWorkload(
  services: Service[],
  options: { name?: string; labels?: Record<string, string> }
): Service[] {
  const workloadName = (options.name || '').trim()
  const labels = options.labels || {}
  return services.filter((service) => {
    const svcName = service.metadata?.name || ''
    if (
      workloadName &&
      (svcName === workloadName || svcName.startsWith(`${workloadName}-`))
    ) {
      return true
    }
    const selector = (service.spec?.selector || {}) as Record<string, string>
    const keys = Object.keys(selector)
    if (keys.length === 0) return false
    return keys.every((key) => labels[key] === selector[key])
  })
}

export function getServiceExternalIP(service: Service): string {
  switch (service.spec?.type) {
    case 'LoadBalancer':
      if (service.status?.loadBalancer?.ingress) {
        const ingress = service.status.loadBalancer.ingress
        if (ingress.length > 0) {
          return ingress.map((i) => i.ip || i.hostname).join(', ')
        }
      }
      return '<pending>'
    case 'ExternalName':
      return service.spec.externalName || '-'
    case 'NodePort':
    case 'ClusterIP':
      if (service.spec.externalIPs && service.spec.externalIPs.length > 0) {
        return service.spec.externalIPs.join(', ')
      }
      return '-'
    default:
      return '-'
  }
}

/** Services 列表搜索使用的 token（名称/类型/IP + port / nodePort / targetPort）。 */
export function getServicePortSearchValues(service: Service): string[] {
  return (service.spec?.ports ?? []).map((port) => {
    const protocol = (port.protocol ?? 'TCP').toLowerCase()
    return port.nodePort != null
      ? `${port.port}:${port.nodePort}/${protocol}`
      : `${port.port}/${protocol}`
  })
}

// 辅助函数：判断 pod 是否有 ready 条件
function hasPodReadyCondition(conditions?: Array<{ type?: string }>): boolean {
  return conditions?.some((condition) => condition.type === 'Ready') ?? false
}

// 辅助函数：判断 pod 是否已初始化
function isPodInitializedConditionTrue(status: Pod['status']): boolean {
  return (
    status?.conditions?.some(
      (condition) =>
        condition.type === 'Initialized' && condition.status === 'True'
    ) ?? false
  )
}

// 辅助函数：判断容器是否为可重启的 init 容器
function isRestartableInitContainer(container: {
  restartPolicy?: string
}): boolean {
  return container.restartPolicy === 'Always'
}

export function toSimpleContainer(
  initContainers?: Container[],
  containers?: Container[],
  ephemeralContainers?: EphemeralContainer[]
): SimpleContainer {
  return [
    ...(containers || []).map((container) => ({
      name: container.name,
      image: container.image || '',
    })),
    ...(initContainers || []).map((container) => ({
      name: container.name,
      image: container.image || '',
      init: true,
    })),
    ...(ephemeralContainers || []).map((container) => ({
      name: container.name,
      image: container.image || '',
      ephemeral: true,
    })),
  ]
}

export function createSearchFilter<T>(
  ...fieldAccessors: Array<(item: T) => string | string[] | undefined>
): (item: T, query: string) => boolean {
  return (item, query) => {
    const q = query.toLowerCase()
    return fieldAccessors.some((accessor) => {
      const value = accessor(item)
      if (!value) return false
      if (Array.isArray(value)) {
        return value.some((v) => v.toLowerCase().includes(q))
      }
      return value.toLowerCase().includes(q)
    })
  }
}

/**
 * AeroLink 在创建表单里记录自由文本描述时写入的注解。
 * 它保存在 annotations（而绝不是 labels）中，这样描述不会进入
 * 标签选择器，同时又能从对象本身读到。
 */
export const DESCRIPTION_ANNOTATION = 'aerolink.io/description'

/**
 * 改名前的描述注解。改名后只写新键，但读的时候要兼容旧对象：
 * 界面上「升级前建过的」资源仍带着旧键，不读就要丢描述。
 */
export const LEGACY_DESCRIPTION_ANNOTATION = 'kite.io/description'

/** 读取描述：新键优先，其次回退到改名前的旧键。 */
export function readDescription(
  annotations: Record<string, string> | undefined | null
): string {
  if (!annotations) return ''
  return (
    annotations[DESCRIPTION_ANNOTATION] ??
    annotations[LEGACY_DESCRIPTION_ANNOTATION] ??
    ''
  )
}

/**
 * 创建表单（ConfigMap / Secret …）共用的校验模式。
 *
 * 名称遵循 DNS 子域规则；数据键仅限
 * 字母数字以及 '-'、'_' 和 '.'；label / annotation 键允许可选的
 * DNS 子域前缀，然后是也可以包含大写字母的名称部分。
 */
export const K8S_RESOURCE_NAME_PATTERN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
export const K8S_DATA_KEY_PATTERN = /^[-._a-zA-Z0-9]+$/
export const K8S_META_KEY_PATTERN =
  /^(?:[a-z0-9]([-a-z0-9.]*[a-z0-9])?\/)?[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/

/**
 * 与创建页 URL 冲突的对象名
 * （"/configmaps/<ns>/create"），因此使用这类名字的对象永远无法
 * 跳回它的详情页。
 */
export const RESERVED_CREATE_NAMES = new Set(['create'])

/**
 * 挑选创建表单应打开的命名空间。表格把它的选择
 * 保存在 sessionStorage（按标签页）与 localStorage（全局）中，而
 * 多选（"a,b"）或 "_all" 哨兵无法承载新对象，
 * 因此这些候选项会退化为第一个具体命名空间，或者 "default"。
 */
export function resolveCreateNamespace(
  ...candidates: Array<string | null | undefined>
): string {
  for (const candidate of candidates) {
    const value = (candidate || '').trim()
    if (!value) continue
    const first = value.split(',')[0]?.trim()
    if (first && first !== '_all') return first
  }
  return 'default'
}
