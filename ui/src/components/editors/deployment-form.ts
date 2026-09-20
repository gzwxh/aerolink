import yaml from 'js-yaml'
import { Deployment } from 'kubernetes-types/apps/v1'
import { Container, Volume } from 'kubernetes-types/core/v1'

export interface VolumeForm {
  name: string
  sourceType: 'emptyDir' | 'hostPath' | 'configMap' | 'secret' | 'pvc'
  options?: {
    path?: string
    configMapName?: string
    secretName?: string
    claimName?: string
  }
}

export interface VolumeMountForm {
  name: string
  mountPath: string
  subPath?: string
  readOnly?: boolean
}

export type PortServiceType = 'none' | 'ClusterIP' | 'NodePort' | 'LoadBalancer'

export interface PortForm {
  name?: string
  containerPort: number
  protocol: 'TCP' | 'UDP'
  serviceType: PortServiceType
  servicePort?: number
  nodePort?: number
  /** 静态 ClusterIP（必须位于 Service CIDR 内）。 */
  clusterIP?: string
}

export interface ContainerConfig {
  name: string
  image: string
  /** init 容器在应用容器之前运行。 */
  isInit?: boolean
  port?: number
  ports: PortForm[]
  pullPolicy: 'Default' | 'Always' | 'IfNotPresent' | 'Never'
  resources: {
    requests: { cpu: string; memory: string }
    limits: { cpu: string; memory: string }
  }
  volumeMounts?: VolumeMountForm[]
  /** NVIDIA GPU 上限（nvidia.com/gpu）。 */
  gpu?: string
  container: Container
}

/** 节点调度面板状态（腾讯云风格）。 */
export interface SchedulingRule {
  id: number
  key: string
  operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist' | 'Gt' | 'Lt'
  values: string // comma-separated for In/NotIn/Gt/Lt
}

export interface SchedulingTerm {
  id: number
  expressions: SchedulingRule[]
}

export interface TolerationForm {
  id: number
  key: string
  operator: 'Equal' | 'Exists'
  value: string
  effect: '' | 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute'
  tolerationSeconds: string
}

export interface SchedulingConfig {
  mode: 'any' | 'specific' | 'rules'
  nodeName: string
  terms: SchedulingTerm[]
  tolerations: TolerationForm[]
  priorityClassName: string
}

export const defaultSchedulingConfig = (): SchedulingConfig => ({
  mode: 'any',
  nodeName: '',
  terms: [],
  tolerations: [],
  priorityClassName: '',
})

/** YAML 解析器重建的调度条目的行 id。 */
let schedulingFormIdSeq = 0
const nextSchedulingFormId = () => ++schedulingFormIdSeq

let nextSchedulingId = 1
export const genSchedulingId = () => nextSchedulingId++

export const emptySchedulingTerm = (): SchedulingTerm => ({
  id: genSchedulingId(),
  expressions: [{ id: genSchedulingId(), key: '', operator: 'In', values: '' }],
})

export const emptyToleration = (): TolerationForm => ({
  id: genSchedulingId(),
  key: '',
  operator: 'Equal',
  value: '',
  effect: '',
  tolerationSeconds: '',
})

export type SchedulingOperator =
  'In' | 'NotIn' | 'Exists' | 'DoesNotExist' | 'Gt' | 'Lt'

export const SCHEDULING_OPERATORS: Array<{
  value: SchedulingOperator
  label: string
}> = [
  { value: 'In', label: '在列表中' },
  { value: 'NotIn', label: '不在列表中' },
  { value: 'Exists', label: '存在' },
  { value: 'DoesNotExist', label: '不存在' },
  { value: 'Gt', label: '大于' },
  { value: 'Lt', label: '小于' },
]

export interface StrategyForm {
  /** Deployment：RollingUpdate | Recreate；StatefulSet：RollingUpdate | OnDelete（映射为 Recreate）。 */
  type: 'RollingUpdate' | 'Recreate'
  maxSurge: string
  maxSurgeUnit: 'count' | 'percent'
  maxUnavailable: string
  maxUnavailableUnit: 'count' | 'percent'
  minReadySeconds: string
  revisionHistoryLimit: string
  progressDeadlineSeconds: string
  /** StatefulSet 滚动更新 partition。 */
  partition: string
}

export const defaultStrategy = (): StrategyForm => ({
  type: 'RollingUpdate',
  maxSurge: '25',
  maxSurgeUnit: 'percent',
  maxUnavailable: '25',
  maxUnavailableUnit: 'percent',
  minReadySeconds: '',
  revisionHistoryLimit: '',
  progressDeadlineSeconds: '',
  partition: '',
})

export interface NetworkForm {
  dnsPolicy: string
  hostname: string
  subdomain: string
  /** podSpec.hostNetwork —— "host network" 模式。 */
  hostNetwork: boolean
  /** podSpec.dnsConfig（DNS 配置） */
  dnsConfig: {
    nameservers: string[]
    searches: string[]
    options: Array<{ name: string; value: string }>
  }
  /** podSpec.hostAliases（主机名保持为逗号分隔的字符串）。 */
  hostAliases: Array<{ ip: string; hostnames: string }>
}

export const defaultNetwork = (): NetworkForm => ({
  dnsPolicy: '',
  hostname: '',
  subdomain: '',
  hostNetwork: false,
  dnsConfig: { nameservers: [], searches: [], options: [] },
  hostAliases: [],
})

export interface PodSpecForm {
  volumes?: Array<VolumeForm>
  scheduling: SchedulingConfig
  network: NetworkForm
  /** Simple nodeSelector key/value pairs (Pod 调度). */
  nodeSelectorPairs: Array<{ key: string; value: string }>
  terminationGracePeriodSeconds: string
  /** securityContext.fsGroup（文件系统组） */
  fsGroup: string
  /** podSpec.imagePullSecrets（secret 名称）。 */
  imagePullSecrets?: string[]
}

export interface DeploymentFormData {
  name: string
  namespace: string
  description: string
  replicas: number
  /** Headless Service 名称，StatefulSet 必需。 */
  serviceName?: string

  labels: Array<{ key: string; value: string }>
  annotations: Array<{ key: string; value: string }>
  podLabels: Array<{ key: string; value: string }>
  podAnnotations: Array<{ key: string; value: string }>
  strategy: StrategyForm
  podSpec: PodSpecForm
  containers: ContainerConfig[]
  /** Cron 表达式，仅在生成 CronJob 时使用。 */
  schedule?: string
}

export type WorkloadResourceType =
  'deployments' | 'pods' | 'daemonsets' | 'statefulsets' | 'jobs' | 'cronjobs'

export const createDefaultContainer = (index: number): ContainerConfig => ({
  name: `container-${index + 1}`,
  image: '',
  ports: [],
  pullPolicy: 'Always',
  resources: {
    requests: { cpu: '', memory: '' },
    limits: { cpu: '', memory: '' },
  },
  container: {
    name: `container-${index + 1}`,
    image: '',
  },
})

export const initialFormData: DeploymentFormData = {
  name: '',
  namespace: 'default',
  description: '',
  replicas: 1,
  labels: [],
  annotations: [],
  podLabels: [],
  podAnnotations: [],
  strategy: defaultStrategy(),
  podSpec: {
    scheduling: defaultSchedulingConfig(),
    network: defaultNetwork(),
    nodeSelectorPairs: [],
    terminationGracePeriodSeconds: '30',
    fsGroup: '',
    imagePullSecrets: [],
  },
  containers: [createDefaultContainer(0)],
}

export function validateStep(
  formData: DeploymentFormData,
  stepNum: number
): boolean {
  switch (stepNum) {
    case 1:
      return !!(
        formData.name &&
        formData.namespace &&
        formData.replicas > 0 &&
        formData.labels.every((label) => label.key && label.value)
      )
    case 2:
      for (const volume of formData.podSpec?.volumes || []) {
        if (!volume.name) return false
        if (volume.sourceType === 'hostPath' && !volume.options?.path)
          return false
        if (volume.sourceType === 'configMap' && !volume.options?.configMapName)
          return false
        if (volume.sourceType === 'secret' && !volume.options?.secretName)
          return false
        if (volume.sourceType === 'pvc' && !volume.options?.claimName)
          return false
      }
      return true
    case 3:
      return formData.containers.every((c) => c.image && c.name)
    default:
      return true
  }
}

function buildVolumes(volumeForms: VolumeForm[]): Volume[] {
  return volumeForms.map((volume): Volume => {
    switch (volume.sourceType) {
      case 'emptyDir':
        return { name: volume.name, emptyDir: {} }
      case 'hostPath':
        return {
          name: volume.name,
          hostPath: { path: volume.options?.path || '/data' },
        }
      case 'configMap':
        return {
          name: volume.name,
          configMap: { name: volume.options?.configMapName || '' },
        }
      case 'secret':
        return {
          name: volume.name,
          secret: { secretName: volume.options?.secretName || '' },
        }
      case 'pvc':
        return {
          name: volume.name,
          persistentVolumeClaim: {
            claimName: volume.options?.claimName || '',
          },
        }
      default:
        return { name: volume.name }
    }
  })
}

function buildContainers(configs: ContainerConfig[]): Container[] {
  return configs.map((cfg) => {
    const hasRequests =
      cfg.resources.requests.cpu || cfg.resources.requests.memory
    const hasLimits = cfg.resources.limits.cpu || cfg.resources.limits.memory

    const extra = cfg.container
    const hasGpu = !!cfg.gpu?.trim()
    const limitEntries: Record<string, string> = {}
    if (hasGpu) limitEntries['nvidia.com/gpu'] = cfg.gpu!.trim()

    return {
      name: cfg.name,
      image: cfg.image,
      ...(cfg.pullPolicy !== 'Default' && { imagePullPolicy: cfg.pullPolicy }),
      ...(extra.command?.length && { command: extra.command }),
      ...(extra.args?.length && { args: extra.args }),
      ...(extra.workingDir && { workingDir: extra.workingDir }),
      ...(extra.stdin && { stdin: true }),
      ...(extra.tty && { tty: true }),
      ...(extra.ports?.length && { ports: extra.ports }),
      ...(extra.lifecycle && { lifecycle: extra.lifecycle }),
      ...(extra.readinessProbe && { readinessProbe: extra.readinessProbe }),
      ...(extra.livenessProbe && { livenessProbe: extra.livenessProbe }),
      ...(extra.startupProbe && { startupProbe: extra.startupProbe }),
      ...(extra.securityContext && { securityContext: extra.securityContext }),
      ...(cfg.container.env &&
        cfg.container.env.length > 0 && {
          env: cfg.container.env.filter(
            (env) => env.name && (env.value || env.valueFrom)
          ),
        }),
      ...(cfg.container.envFrom &&
        cfg.container.envFrom.length > 0 && {
          envFrom: cfg.container.envFrom.filter(
            (source) => source.configMapRef?.name || source.secretRef?.name
          ),
        }),
      ...(cfg.ports.length > 0 && {
        ports: cfg.ports.map((p) => ({
          ...(p.name && { name: p.name }),
          containerPort: p.containerPort,
          ...(p.protocol !== 'TCP' && { protocol: p.protocol }),
        })),
      }),
      ...((hasRequests || hasLimits || hasGpu) && {
        resources: {
          ...(hasRequests && {
            requests: {
              ...(cfg.resources.requests.cpu && {
                cpu: cfg.resources.requests.cpu,
              }),
              ...(cfg.resources.requests.memory && {
                memory: cfg.resources.requests.memory,
              }),
            },
          }),
          ...((hasLimits || hasGpu) && {
            limits: {
              ...(cfg.resources.limits.cpu && {
                cpu: cfg.resources.limits.cpu,
              }),
              ...(cfg.resources.limits.memory && {
                memory: cfg.resources.limits.memory,
              }),
              ...limitEntries,
            },
          }),
        },
      }),
      ...(cfg.volumeMounts &&
        cfg.volumeMounts.length > 0 && {
          volumeMounts: cfg.volumeMounts.map((mount) => ({
            name: mount.name,
            mountPath: mount.mountPath,
            subPath: mount.subPath,
            readOnly: mount.readOnly === true,
          })),
        }),
    }
  })
}

const pairsToRecord = (
  pairs: Array<{ key: string; value: string }>
): Record<string, string> => {
  const result: Record<string, string> = {}
  for (const { key, value } of pairs) {
    if (key.trim() && value.trim()) result[key.trim()] = value.trim()
  }
  return result
}

const parseValues = (raw: string): string[] =>
  raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)

/** 依据面板状态构造 pod spec 的调度字段。 */
export function buildSchedulingPodSpec(
  scheduling: SchedulingConfig
): Record<string, unknown> {
  const podSpec: Record<string, unknown> = {}
  if (scheduling.mode === 'specific' && scheduling.nodeName.trim()) {
    podSpec.nodeName = scheduling.nodeName.trim()
  }
  if (scheduling.mode === 'rules') {
    const terms = scheduling.terms
      .map((term) => ({
        matchExpressions: term.expressions
          .filter((expr) => expr.key.trim())
          .map((expr) => ({
            key: expr.key.trim(),
            operator: expr.operator,
            ...(expr.operator !== 'Exists' && expr.operator !== 'DoesNotExist'
              ? { values: parseValues(expr.values) }
              : {}),
          })),
      }))
      .filter((term) => term.matchExpressions.length > 0)
    if (terms.length > 0) {
      podSpec.affinity = {
        nodeAffinity: {
          requiredDuringSchedulingIgnoredDuringExecution: {
            nodeSelectorTerms: terms,
          },
        },
      }
    }
  }
  if (scheduling.tolerations.length > 0) {
    podSpec.tolerations = scheduling.tolerations.map((t) => {
      const toleration: Record<string, unknown> = {
        key: t.key.trim(),
        operator: t.operator,
      }
      if (t.operator === 'Equal') toleration.value = t.value.trim()
      if (t.effect) toleration.effect = t.effect
      const seconds = Number(t.tolerationSeconds)
      if (
        t.effect === 'NoExecute' &&
        t.tolerationSeconds &&
        !Number.isNaN(seconds)
      ) {
        toleration.tolerationSeconds = seconds
      }
      return toleration
    })
  }
  if (scheduling.priorityClassName.trim()) {
    podSpec.priorityClassName = scheduling.priorityClassName.trim()
  }
  return podSpec
}

const formatQuantity = (value: string, unit: 'count' | 'percent') => {
  if (!value.trim()) return undefined
  const num = Number(value)
  if (Number.isNaN(num)) return undefined
  return unit === 'percent' ? `${num}%` : num
}

/** 依据请求创建 Service 的端口行，构造 Service 文档。 */
export function buildServiceDocuments(
  formData: DeploymentFormData
): Array<Record<string, unknown>> {
  const labelsObj = formData.labels.reduce(
    (acc, label) => {
      if (label.key && label.value) acc[label.key] = label.value
      return acc
    },
    {} as Record<string, string>
  )
  if (!labelsObj.app && formData.name) labelsObj.app = formData.name

  // 按 service 类型对需要暴露 Service 的端口行分组。
  const groups = new Map<
    Exclude<PortServiceType, 'none'>,
    Array<Record<string, unknown>>
  >()
  for (const c of formData.containers) {
    for (const p of c.ports) {
      if (p.serviceType === 'none' || !p.containerPort) continue
      const group = groups.get(p.serviceType) || []
      const exists = group.some((gp) => gp.containerPort === p.containerPort)
      if (exists) continue
      group.push({
        ...(p.name && { name: p.name }),
        port: p.servicePort || p.containerPort,
        targetPort: p.containerPort,
        ...(p.nodePort && p.serviceType === 'NodePort'
          ? { nodePort: p.nodePort }
          : {}),
        ...(p.protocol !== 'TCP' ? { protocol: p.protocol } : {}),
      })
      group[group.length - 1].containerPort = p.containerPort
      groups.set(p.serviceType, group)
    }
  }

  const docs: Array<Record<string, unknown>> = []
  for (const [type, ports] of groups) {
    const portsOut = ports.map((p) => {
      const rest: Record<string, unknown> = { ...p }
      delete rest.containerPort
      return rest
    })
    const spec: Record<string, unknown> = {
      type,
      selector: labelsObj,
      ports: portsOut,
    }
    // 静态 ClusterIP 分配（kubernetes.io cluster-ip-allocation）：
    // 用户可以在 Service CIDR 内指定一个具体 IP。
    if (type === 'ClusterIP') {
      const staticIP = ports.find(
        (p) => typeof p.clusterIP === 'string' && p.clusterIP.trim()
      )?.clusterIP as string | undefined
      if (staticIP) spec.clusterIP = staticIP
    }
    docs.push({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name:
          type === 'ClusterIP'
            ? formData.name
            : `${formData.name}-${type.toLowerCase()}`,
        namespace: formData.namespace,
        labels: labelsObj,
      },
      spec,
    })
  }
  return docs
}

export function generateDeploymentYaml(formData: DeploymentFormData): string {
  return generateWorkloadYaml(formData, 'deployments')
}

export function generateWorkloadYaml(
  formData: DeploymentFormData,
  resourceType: WorkloadResourceType
): string {
  const labelsObj = formData.labels.reduce(
    (acc, label) => {
      if (label.key && label.value) acc[label.key] = label.value
      return acc
    },
    {} as Record<string, string>
  )

  if (!labelsObj.app && formData.name) {
    labelsObj.app = formData.name
  }

  const annotations = pairsToRecord(formData.annotations || [])
  if (formData.description.trim()) {
    annotations['kubernetes.io/description'] = formData.description.trim()
  }

  const metadata: Record<string, unknown> = {
    name: formData.name,
    namespace: formData.namespace,
    labels: labelsObj,
  }
  if (Object.keys(annotations).length > 0) {
    metadata.annotations = annotations
  }

  const podMeta: Record<string, unknown> = {
    labels: pairsToRecord(formData.podLabels || []).app
      ? pairsToRecord(formData.podLabels || [])
      : { ...pairsToRecord(formData.podLabels || []), app: formData.name },
  }
  const podAnnotations = pairsToRecord(formData.podAnnotations || [])
  if (Object.keys(podAnnotations).length > 0) {
    podMeta.annotations = podAnnotations
  }

  const scheduling = formData.podSpec?.scheduling
  const network = formData.podSpec?.network
  const schedulingFields = scheduling ? buildSchedulingPodSpec(scheduling) : {}
  const nodeSelectorObj = pairsToRecord(
    formData.podSpec?.nodeSelectorPairs || []
  )
  const gracePeriod = Number(formData.podSpec?.terminationGracePeriodSeconds)
  const fsGroup = Number(formData.podSpec?.fsGroup)
  const initContainerConfigs = formData.containers.filter((c) => c.isInit)
  const appContainerConfigs = formData.containers.filter((c) => !c.isInit)
  const pullSecrets = (formData.podSpec?.imagePullSecrets || []).filter(Boolean)

  const podSpec: Record<string, unknown> = {
    ...(pullSecrets.length > 0 && {
      imagePullSecrets: pullSecrets.map((name) => ({ name })),
    }),
    ...(network?.hostNetwork && { hostNetwork: true }),
    ...(network?.dnsPolicy && { dnsPolicy: network.dnsPolicy }),
    ...(network?.hostname?.trim() && { hostname: network.hostname.trim() }),
    ...(network?.subdomain?.trim() && { subdomain: network.subdomain.trim() }),
    ...((network?.dnsConfig?.nameservers?.length ?? 0) > 0 ||
    (network?.dnsConfig?.searches?.length ?? 0) > 0 ||
    (network?.dnsConfig?.options?.length ?? 0) > 0
      ? {
          dnsConfig: {
            ...((network?.dnsConfig?.nameservers?.length ?? 0) > 0 && {
              nameservers: network!.dnsConfig.nameservers,
            }),
            ...((network?.dnsConfig?.searches?.length ?? 0) > 0 && {
              searches: network!.dnsConfig.searches,
            }),
            ...((network?.dnsConfig?.options?.length ?? 0) > 0 && {
              options: network!.dnsConfig.options.filter((o) => o.name),
            }),
          },
        }
      : {}),
    ...((network?.hostAliases?.length ?? 0) > 0 && {
      hostAliases: network!.hostAliases
        .filter((a) => a.ip || a.hostnames)
        .map((a) => ({
          ip: a.ip,
          hostnames: a.hostnames
            .split(',')
            .map((h) => h.trim())
            .filter(Boolean),
        })),
    }),
    ...schedulingFields,
    ...(Object.keys(nodeSelectorObj).length > 0 && {
      nodeSelector: nodeSelectorObj,
    }),
    ...(!Number.isNaN(gracePeriod) &&
      formData.podSpec?.terminationGracePeriodSeconds && {
        terminationGracePeriodSeconds: gracePeriod,
      }),
    ...(!Number.isNaN(fsGroup) && formData.podSpec?.fsGroup
      ? { securityContext: { fsGroup } }
      : {}),
    volumes: buildVolumes(formData.podSpec?.volumes || []),
    ...(initContainerConfigs.length > 0 && {
      initContainers: buildContainers(initContainerConfigs),
    }),
    containers: buildContainers(appContainerConfigs),
  }
  const podTemplate = {
    metadata: podMeta,
    spec: podSpec,
  }
  // Job / CronJob 的 Pod 模板不接受默认的 Always：不显式声明 restartPolicy 时
  // API 会以 `restartPolicy: Required value: valid values: "OnFailure", "Never"` 拒绝创建。
  const batchPodTemplate = {
    ...podTemplate,
    spec: { ...podSpec, restartPolicy: 'OnFailure' },
  }

  let manifest: Record<string, unknown>
  switch (resourceType) {
    case 'pods':
      manifest = {
        apiVersion: 'v1',
        kind: 'Pod',
        // 裸 Pod 没有 pod 模板，因此面板中配置的 Pod 级标签/注解
        // 会直接作用于 Pod 自身的元数据。
        metadata: {
          ...metadata,
          labels: {
            ...labelsObj,
            ...pairsToRecord(formData.podLabels || []),
          },
          ...(Object.keys(podAnnotations).length > 0 && {
            annotations: {
              ...annotations,
              ...podAnnotations,
            },
          }),
        },
        spec: podSpec,
      }
      break
    case 'daemonsets':
      manifest = {
        apiVersion: 'apps/v1',
        kind: 'DaemonSet',
        metadata,
        spec: {
          selector: { matchLabels: labelsObj },
          template: podTemplate,
        },
      }
      break
    case 'statefulsets': {
      const ssStrategy = formData.strategy
      const partition = Number(ssStrategy?.partition)
      // 面板复用 Recreate 来表达 StatefulSet 的 OnDelete。
      const updateType =
        ssStrategy?.type === 'Recreate' ? 'OnDelete' : 'RollingUpdate'
      manifest = {
        apiVersion: 'apps/v1',
        kind: 'StatefulSet',
        metadata,
        spec: {
          serviceName: formData.serviceName?.trim() || formData.name,
          replicas: formData.replicas,
          selector: { matchLabels: labelsObj },
          template: podTemplate,
          updateStrategy: {
            type: updateType,
            ...(updateType === 'RollingUpdate' &&
              ssStrategy?.partition &&
              !Number.isNaN(partition) && {
                rollingUpdate: { partition },
              }),
          },
        },
      }
      break
    }
    case 'jobs':
      manifest = {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata,
        spec: { template: batchPodTemplate },
      }
      break
    case 'cronjobs':
      manifest = {
        apiVersion: 'batch/v1',
        kind: 'CronJob',
        metadata,
        spec: {
          schedule: formData.schedule || '*/5 * * * *',
          jobTemplate: { spec: { template: batchPodTemplate } },
        },
      }
      break
    default: {
      const strategy = formData.strategy
      const spec: Record<string, unknown> = {
        replicas: formData.replicas,
        selector: { matchLabels: labelsObj },
        template: podTemplate,
      }
      if (strategy) {
        if (strategy.type === 'Recreate') {
          spec.strategy = { type: 'Recreate' }
        } else {
          const maxSurge = formatQuantity(
            strategy.maxSurge,
            strategy.maxSurgeUnit
          )
          const maxUnavailable = formatQuantity(
            strategy.maxUnavailable,
            strategy.maxUnavailableUnit
          )
          if (maxSurge !== undefined || maxUnavailable !== undefined) {
            spec.strategy = {
              type: 'RollingUpdate',
              ...(maxSurge !== undefined && {
                rollingUpdate: {
                  ...(maxSurge !== undefined && { maxSurge }),
                  ...(maxUnavailable !== undefined && { maxUnavailable }),
                },
              }),
            }
          }
        }
        const minReadySeconds = Number(strategy.minReadySeconds)
        if (strategy.minReadySeconds && !Number.isNaN(minReadySeconds)) {
          spec.minReadySeconds = minReadySeconds
        }
        const revisionHistoryLimit = Number(strategy.revisionHistoryLimit)
        if (
          strategy.revisionHistoryLimit &&
          !Number.isNaN(revisionHistoryLimit)
        ) {
          spec.revisionHistoryLimit = revisionHistoryLimit
        }
        const progressDeadlineSeconds = Number(strategy.progressDeadlineSeconds)
        if (
          strategy.progressDeadlineSeconds &&
          !Number.isNaN(progressDeadlineSeconds)
        ) {
          spec.progressDeadlineSeconds = progressDeadlineSeconds
        }
      }
      const deployment: Deployment = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata,
        spec: spec as unknown as Deployment['spec'],
      }
      manifest = deployment as unknown as Record<string, unknown>
    }
  }

  // 请求 Service 时输出多文档 YAML：
  // 先是 Service，然后才是工作负载，一次性应用。
  const serviceDocs = buildServiceDocuments(formData)
  if (serviceDocs.length > 0) {
    const dumpOpts = { indent: 2, noRefs: true, lineWidth: -1 }
    const parts = serviceDocs.map((d) => yaml.dump(d, dumpOpts))
    parts.push(yaml.dump(manifest, dumpOpts))
    return parts.join('---\n')
  }

  return yaml.dump(manifest, { indent: 2, noRefs: true })
}
/** 尽力而为的反向解析：工作负载 YAML（+ Service 文档）-> 表单状态。 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export function parseYamlToFormData(
  content: string,
  resourceType: WorkloadResourceType,
  fallback: DeploymentFormData
): DeploymentFormData {
  try {
    const docs = (yaml.loadAll(content) as Array<Record<string, unknown>>) || []
    const kinds: Record<string, string> = {
      deployments: 'Deployment',
      statefulsets: 'StatefulSet',
      daemonsets: 'DaemonSet',
      jobs: 'Job',
      cronjobs: 'CronJob',
      pods: 'Pod',
    }
    const wanted = kinds[resourceType]
    const workload = docs.find((d) => d && d.kind === wanted) || docs[0]
    if (!workload) return fallback

    const metadata = (workload.metadata || {}) as Record<string, unknown>
    const labelsObj = (metadata.labels || {}) as Record<string, string>
    const annotationsObj = (metadata.annotations || {}) as Record<
      string,
      string
    >
    const toPairs = (obj: Record<string, string>) =>
      Object.entries(obj).map(([key, value]) => ({ key, value }))

    const spec = (workload.spec || {}) as Record<string, any>
    let podSpecDoc = (spec.template?.spec || spec) as Record<string, any>
    if (resourceType === 'cronjobs') {
      podSpecDoc = spec.jobTemplate?.spec?.template?.spec || podSpecDoc
    }
    const podMeta = (spec.template?.metadata || {}) as Record<string, any>

    const mapContainer = (c: any, i: number, isInit: boolean) => {
      const res = c.resources || {}
      return {
        name: c.name || `container-${i + 1}`,
        image: c.image || '',
        isInit,
        ports: ((c.ports as Array<any>) || []).map((p) => ({
          name: p.name,
          containerPort: Number(p.containerPort) || 0,
          protocol: p.protocol === 'UDP' ? ('UDP' as const) : ('TCP' as const),
          serviceType: 'none' as const,
        })),
        pullPolicy: c.imagePullPolicy || 'IfNotPresent',
        resources: {
          requests: {
            cpu: res.requests?.cpu || '',
            memory: res.requests?.memory || '',
          },
          limits: {
            cpu: res.limits?.cpu || '',
            memory: res.limits?.memory || '',
          },
        },
        gpu:
          res.limits?.['nvidia.com/gpu'] === undefined ||
          res.limits?.['nvidia.com/gpu'] === null
            ? undefined
            : String(res.limits['nvidia.com/gpu']),
        volumeMounts: ((c.volumeMounts as Array<any>) || []).map((vm) => ({
          name: vm.name || '',
          mountPath: vm.mountPath || '',
          subPath: vm.subPath,
          readOnly: !!vm.readOnly,
        })),
        container: {
          name: c.name || `container-${i + 1}`,
          image: c.image || '',
          env: c.env || [],
          envFrom: c.envFrom || [],
          command: c.command || [],
          args: c.args || [],
          workingDir: c.workingDir,
          stdin: !!c.stdin,
          tty: !!c.tty,
          lifecycle: c.lifecycle,
          readinessProbe: c.readinessProbe,
          livenessProbe: c.livenessProbe,
          startupProbe: c.startupProbe,
          securityContext: c.securityContext,
        },
      }
    }

    const containers = [
      ...((podSpecDoc.initContainers as Array<any>) || []).map((c, i) =>
        mapContainer(c, i, true)
      ),
      ...((podSpecDoc.containers as Array<any>) || []).map((c, i) =>
        mapContainer(c, i, false)
      ),
    ]

    // Deployment.spec.strategy / StatefulSet.spec.updateStrategy -> 面板。
    const rawStrategy = (spec.strategy || spec.updateStrategy) as
      | {
          type?: string
          rollingUpdate?: {
            maxSurge?: string | number
            maxUnavailable?: string | number
            partition?: number
          }
        }
      | undefined
    const parsedStrategy: StrategyForm = { ...defaultStrategy() }
    if (rawStrategy) {
      parsedStrategy.type =
        rawStrategy.type === 'Recreate' || rawStrategy.type === 'OnDelete'
          ? 'Recreate'
          : 'RollingUpdate'
      const splitQuantity = (value: string | number | undefined) => {
        if (value === undefined || value === null) return null
        const text = String(value).trim()
        if (!text) return null
        return text.endsWith('%')
          ? { value: text.slice(0, -1), unit: 'percent' as const }
          : { value: text, unit: 'count' as const }
      }
      const surge = splitQuantity(rawStrategy.rollingUpdate?.maxSurge)
      if (surge) {
        parsedStrategy.maxSurge = surge.value
        parsedStrategy.maxSurgeUnit = surge.unit
      }
      const unavailable = splitQuantity(
        rawStrategy.rollingUpdate?.maxUnavailable
      )
      if (unavailable) {
        parsedStrategy.maxUnavailable = unavailable.value
        parsedStrategy.maxUnavailableUnit = unavailable.unit
      }
      const partition = rawStrategy.rollingUpdate?.partition
      if (partition !== undefined && partition !== null) {
        parsedStrategy.partition = String(partition)
      }
    }
    const readSeconds = (value: unknown) =>
      value === undefined || value === null ? '' : String(value)
    parsedStrategy.minReadySeconds = readSeconds(spec.minReadySeconds)
    parsedStrategy.revisionHistoryLimit = readSeconds(spec.revisionHistoryLimit)
    parsedStrategy.progressDeadlineSeconds = readSeconds(
      spec.progressDeadlineSeconds
    )

    const scheduling = defaultSchedulingConfig()
    if (podSpecDoc.nodeName) {
      scheduling.mode = 'specific'
      scheduling.nodeName = String(podSpecDoc.nodeName)
    } else {
      // 节点调度规则（nodeAffinity）-> 面板条目。
      const nodeAffinity = podSpecDoc.affinity?.nodeAffinity as
        | {
            requiredDuringSchedulingIgnoredDuringExecution?: {
              nodeSelectorTerms?: Array<{
                matchExpressions?: Array<{
                  key?: string
                  operator?: string
                  values?: string[]
                }>
              }>
            }
          }
        | undefined
      const terms = (
        nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution
          ?.nodeSelectorTerms || []
      )
        .map((term) => ({
          id: nextSchedulingFormId(),
          expressions: (term.matchExpressions || []).map((expr) => ({
            id: nextSchedulingFormId(),
            key: expr.key || '',
            operator: (expr.operator || 'In') as SchedulingRule['operator'],
            values: (expr.values || []).join(', '),
          })),
        }))
        .filter((term) => term.expressions.length > 0)
      if (terms.length > 0) {
        scheduling.mode = 'rules'
        scheduling.terms = terms
      }
    }
    // 容忍与优先级适用于所有调度模式。
    scheduling.tolerations = ((podSpecDoc.tolerations as Array<any>) || []).map(
      (tol) => ({
        id: nextSchedulingFormId(),
        key: tol.key || '',
        operator:
          tol.operator === 'Exists' ? ('Exists' as const) : ('Equal' as const),
        value: tol.value || '',
        effect: (tol.effect || '') as TolerationForm['effect'],
        tolerationSeconds:
          tol.tolerationSeconds === undefined ||
          tol.tolerationSeconds === null ||
          typeof tol.tolerationSeconds === 'object'
            ? ''
            : String(tol.tolerationSeconds),
      })
    )
    scheduling.priorityClassName =
      (podSpecDoc.priorityClassName as string) || ''

    const base: DeploymentFormData = {
      ...fallback,
      name: (metadata.name as string) || fallback.name,
      namespace: (metadata.namespace as string) || fallback.namespace,
      description:
        annotationsObj['kubernetes.io/description'] || fallback.description,
      replicas:
        resourceType === 'deployments' || resourceType === 'statefulsets'
          ? Number(spec.replicas) || 1
          : fallback.replicas,
      labels: toPairs(labelsObj).length ? toPairs(labelsObj) : fallback.labels,
      annotations: toPairs(annotationsObj),
      strategy: parsedStrategy,
      podLabels: toPairs(podMeta.labels || {}),
      podAnnotations: toPairs(podMeta.annotations || {}),
      podSpec: {
        volumes: ((podSpecDoc.volumes as Array<any>) || []).map((v) => {
          let sourceType: VolumeForm['sourceType'] = 'emptyDir'
          let options: VolumeForm['options'] = {}
          if (v.hostPath) {
            sourceType = 'hostPath'
            options = { path: v.hostPath.path }
          } else if (v.configMap) {
            sourceType = 'configMap'
            options = { configMapName: v.configMap.name }
          } else if (v.secret) {
            sourceType = 'secret'
            options = { secretName: v.secret.secretName }
          } else if (v.persistentVolumeClaim) {
            sourceType = 'pvc'
            options = { claimName: v.persistentVolumeClaim.claimName }
          }
          return { name: v.name || '', sourceType, options }
        }),
        scheduling,
        network: {
          dnsPolicy: podSpecDoc.dnsPolicy || '',
          hostname: podSpecDoc.hostname || '',
          subdomain: podSpecDoc.subdomain || '',
          hostNetwork: podSpecDoc.hostNetwork === true,
          dnsConfig: {
            nameservers: (podSpecDoc.dnsConfig?.nameservers || []).filter(
              Boolean
            ),
            searches: (podSpecDoc.dnsConfig?.searches || []).filter(Boolean),
            options: (
              (podSpecDoc.dnsConfig?.options || []) as Array<{
                name?: string
                value?: string
              }>
            ).map((o) => ({
              name: o.name || '',
              value: o.value || '',
            })),
          },
          hostAliases: (
            (podSpecDoc.hostAliases || []) as Array<{
              ip?: string
              hostnames?: string[]
            }>
          ).map((a) => ({
            ip: a.ip || '',
            hostnames: (a.hostnames || []).join(', '),
          })),
        },
        nodeSelectorPairs: toPairs(
          (podSpecDoc.nodeSelector || {}) as Record<string, string>
        ),
        terminationGracePeriodSeconds: podSpecDoc.terminationGracePeriodSeconds
          ? String(podSpecDoc.terminationGracePeriodSeconds)
          : '30',
        fsGroup: podSpecDoc.securityContext?.fsGroup
          ? String(podSpecDoc.securityContext.fsGroup)
          : '',
        imagePullSecrets: ((podSpecDoc.imagePullSecrets as Array<any>) || [])
          .map((s) => s?.name)
          .filter((n): n is string => !!n),
      },
      containers: containers.length > 0 ? containers : fallback.containers,
    }

    if (resourceType === 'statefulsets' && spec.serviceName)
      base.serviceName = String(spec.serviceName)
    if (resourceType === 'cronjobs' && spec.schedule)
      base.schedule = String(spec.schedule)

    // 把 Service 文档映射回端口行。
    for (const svc of docs.filter((d) => d.kind === 'Service')) {
      const svcSpec = (svc.spec || {}) as Record<string, any>
      const svcType = (svcSpec.type as PortServiceType) || 'ClusterIP'
      for (const sp of (svcSpec.ports as Array<any>) || []) {
        const target = Number(sp.targetPort)
        for (const c of base.containers) {
          for (const p of c.ports) {
            if (p.containerPort === target) {
              p.serviceType = svcType
              if (sp.port !== undefined && Number(sp.port) !== target)
                p.servicePort = Number(sp.port)
              if (sp.nodePort !== undefined) p.nodePort = Number(sp.nodePort)
            }
          }
        }
      }
    }

    return base
  } catch {
    return fallback
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 递归地把 overlay 叠加到 base 上；数组与标量直接替换。 */
function overlayObject(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    const current = result[key]
    result[key] =
      isPlainObject(value) && isPlainObject(current)
        ? overlayObject(current, value)
        : value
  }
  return result
}

/**
 * 把表单生成的 manifest 叠加到正在编辑的线上对象之上，
 * 使可视化表单未建模的字段（serviceAccountName、Pod 级
 * securityContext 扩展项、topologySpreadConstraints 等）在更新后保留下来。
 * spec.selector 在工作负载上是不可变的：它从线上对象恢复，
 * 并让 pod 模板标签重新与它匹配。
 */
export function mergeEditedManifest(
  generated: Record<string, unknown>,
  original: Record<string, unknown>
): Record<string, unknown> {
  const merged = overlayObject(original, generated)
  // Update 两者都会忽略，它们只会让 YAML 标签页显得杂乱。
  delete merged.status
  if (isPlainObject(merged.metadata)) delete merged.metadata.managedFields

  const spec = isPlainObject(merged.spec) ? merged.spec : null
  const selector = isPlainObject(original.spec)
    ? original.spec.selector
    : undefined
  if (!spec || !isPlainObject(selector)) return merged

  const template = isPlainObject(spec.template) ? spec.template : {}
  const templateMetadata = isPlainObject(template.metadata)
    ? template.metadata
    : {}
  spec.selector = selector
  spec.template = {
    ...template,
    metadata: {
      ...templateMetadata,
      labels: {
        ...(isPlainObject(templateMetadata.labels)
          ? templateMetadata.labels
          : {}),
        ...(isPlainObject(selector.matchLabels) ? selector.matchLabels : {}),
      },
    },
  }
  return merged
}

/**
 * 可选地把生成 manifest 的第一个文档与线上对象合并，
 * 其余文档（例如生成的 Service）保持原样。
 */
export function applyEditedManifest(
  content: string,
  original: Record<string, unknown>
): string {
  const docs = yaml.loadAll(content)
  if (docs.length === 0 || !isPlainObject(docs[0])) return content
  return [
    yaml.dump(mergeEditedManifest(docs[0], original)),
    ...docs.slice(1).map((doc) => yaml.dump(doc)),
  ].join('---\n')
}
