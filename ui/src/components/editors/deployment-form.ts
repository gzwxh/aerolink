import yaml from 'js-yaml'
import { Deployment } from 'kubernetes-types/apps/v1'
import { Container, Volume } from 'kubernetes-types/core/v1'

export type VolumeSourceType =
  'emptyDir' | 'hostPath' | 'configMap' | 'secret' | 'pvc' | 'nfs' | 'csi'

/** hostPath 的路径类型；空串表示「任意路径，不做检查」（API 的默认值）。 */
export const hostPathTypeOptions = [
  '',
  'DirectoryOrCreate',
  'Directory',
  'FileOrCreate',
  'File',
  'Socket',
  'CharDevice',
  'BlockDevice',
] as const

export interface VolumeForm {
  name: string
  sourceType: VolumeSourceType
  options?: {
    path?: string
    hostPathType?: string
    configMapName?: string
    secretName?: string
    claimName?: string
    nfsServer?: string
    nfsPath?: string
    nfsReadOnly?: boolean
    csiDriver?: string
    csiFsType?: string
    csiReadOnly?: boolean
    /**
     * Pod 级 CSI 卷没有 volumeHandle 字段（那是 PV/PVC 的），驱动相关参数
     * 一律走 volumeAttributes，例如华为云 CSI 的 volumeHandle/everest.io/disk-volume-type。
     */
    csiVolumeAttributes?: Array<{ key: string; value: string }>
  }
}

export type PortServiceType = 'none' | 'ClusterIP' | 'NodePort' | 'LoadBalancer'

/**
 * 容器的监听端口，以及为它声明的 Service。
 *
 * `serviceType !== 'none'` 时保存会一并生成对应的 Service 文档（见
 * `buildServiceDocuments`）：同一类型的端口合成一个 Service，选择器就是本工作负载的标签。
 * 关联关系由 Service 侧的选择器决定，因此从工作负载删除端口不会删掉已建的 Service。
 */
export interface PortForm {
  name?: string
  containerPort: number
  protocol: 'TCP' | 'UDP'
  serviceType: PortServiceType
  servicePort?: number
  nodePort?: number
  /** 静态 ClusterIP（必须落在 service CIDR 内）。 */
  clusterIP?: string
  /**
   * 反显时记录的线上 Service 名。线上 Service 的名字未必符合
   * `<负载名>-<类型>` 的生成约定（老对象、手建的都可能是裸负载名），
   * 生成时沿用这个名字走 apply 的 update；只有新建的端口行才按约定命名。
   */
  serviceName?: string
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
  /**
   * Job 级调度参数：Job 直接放在 `spec` 下，CronJob 放在 `spec.jobTemplate.spec` 下。
   * 用字符串是因为表单里可以留空——留空表示「不写进 manifest」：新建时由集群套默认值，
   * 编辑时沿用线上对象当前的值（mergeEditedManifest 只在生成物带该键时才覆盖）。
   */
  backoffLimit?: string
  parallelism?: string
  completions?: string
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

/**
 * Job 级参数的取值范围（k8s 校验：completions 至少 1，backoffLimit / parallelism 非负）。
 * 导出给创建页渲染表单用，保证输入框的 min 与这里的解析规则一致。
 */
export const JOB_LEVEL_FIELDS = [
  { key: 'backoffLimit', min: 0 },
  { key: 'parallelism', min: 0 },
  { key: 'completions', min: 1 },
] as const

/** 表单值是字符串：空串表示「不设置」，非整数或越界的一律当作没填。 */
function parseJobLevelValue(
  value: string | undefined,
  min: number
): number | null {
  if (value === undefined || value.trim() === '') return null
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min) return null
  return parsed
}

/**
 * Job 级参数：只在表单真的填了值时才写进 manifest，留空交由 mergeEditedManifest 的
 * 深合并沿用线上对象当前的值（新建时则由集群套默认值）。
 */
function jobLevelSpec(formData: DeploymentFormData): Record<string, number> {
  const spec: Record<string, number> = {}
  for (const { key, min } of JOB_LEVEL_FIELDS) {
    const parsed = parseJobLevelValue(formData[key], min)
    if (parsed !== null) spec[key] = parsed
  }
  return spec
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
        if (
          volume.sourceType === 'nfs' &&
          (!volume.options?.nfsServer || !volume.options?.nfsPath)
        )
          return false
        if (volume.sourceType === 'csi' && !volume.options?.csiDriver)
          return false
      }
      return true
    case 3:
      return formData.containers.every((c) => c.image && c.name)
    default:
      return true
  }
}

/** 容器端口必须在 1-65535。 */
export function isValidContainerPort(port: number): boolean {
  return !!port && port >= 1 && port <= 65535
}

/** 静态 ClusterIP 的格式：四段十进制 IPv4。 */
export function isValidClusterIP(value: string): boolean {
  const octets = value.trim().split('.')
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  )
}

/**
 * 端口行里与集群配置无关的硬错误：容器端口超出 1-65535，或静态 ClusterIP 格式不对。
 *
 * 校验放在提交前，是因为容器端口非法时 `buildServiceDocuments` 会静默跳过该行 ——
 * 用户以为勾了 Service，实际什么都没建。NodePort 的合法范围由 kube-apiserver 的
 * `--service-node-port-range` 决定，只有界面能拿到（见 `lib/node-port-range.ts`），
 * 因此不在这里判。
 */
export function hasInvalidPorts(formData: DeploymentFormData): boolean {
  return formData.containers.some((container) =>
    container.ports.some((port) => {
      if (!isValidContainerPort(port.containerPort)) return true
      return (
        port.serviceType === 'ClusterIP' &&
        !!port.clusterIP?.trim() &&
        !isValidClusterIP(port.clusterIP)
      )
    })
  )
}

function buildVolumes(volumeForms: VolumeForm[]): Volume[] {
  const volumes: Volume[] = []
  for (const volume of volumeForms) {
    switch (volume.sourceType) {
      case 'emptyDir':
        volumes.push({ name: volume.name, emptyDir: {} })
        break
      case 'hostPath':
        volumes.push({
          name: volume.name,
          // 空 type 是 API 的默认值（不检查目标路径），此时不写这个字段。
          hostPath: {
            path: volume.options?.path || '/data',
            ...(volume.options?.hostPathType
              ? { type: volume.options.hostPathType }
              : {}),
          },
        })
        break
      case 'configMap':
        volumes.push({
          name: volume.name,
          configMap: { name: volume.options?.configMapName || '' },
        })
        break
      case 'secret':
        volumes.push({
          name: volume.name,
          secret: { secretName: volume.options?.secretName || '' },
        })
        break
      case 'pvc':
        volumes.push({
          name: volume.name,
          persistentVolumeClaim: {
            claimName: volume.options?.claimName || '',
          },
        })
        break
      case 'nfs':
        volumes.push({
          name: volume.name,
          nfs: {
            server: volume.options?.nfsServer || '',
            path: volume.options?.nfsPath || '',
            ...(volume.options?.nfsReadOnly ? { readOnly: true } : {}),
          },
        })
        break
      case 'csi': {
        const attributes = (volume.options?.csiVolumeAttributes || []).filter(
          (pair) => pair.key
        )
        volumes.push({
          name: volume.name,
          csi: {
            driver: volume.options?.csiDriver || '',
            ...(volume.options?.csiFsType
              ? { fsType: volume.options.csiFsType }
              : {}),
            ...(volume.options?.csiReadOnly ? { readOnly: true } : {}),
            ...(attributes.length > 0 && {
              volumeAttributes: Object.fromEntries(
                attributes.map((pair) => [pair.key, pair.value])
              ),
            }),
          },
        })
        break
      }
      default:
        // 表单表达不了的卷类型：整条跳过，绝不发一个空 source —— 空的
        // VolumeSource 会把线上对象的真实卷覆盖成空（server-side apply 不区分
        // 「我不管理它」和「它没有来源」）。
        break
    }
  }
  return volumes
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
      ...(extra.volumeMounts &&
        extra.volumeMounts.length > 0 && {
          volumeMounts: extra.volumeMounts.map((mount) => ({
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

/**
 * 工作负载标签，`app` 缺省补成工作负载名。
 *
 * 写到工作负载 metadata.labels 上；不要拿它当 Service 的 selector——
 * 克隆时它仍是源负载的标签（prepareCloneResource 不改写 metadata.labels）。
 */
function workloadLabels(formData: DeploymentFormData): Record<string, string> {
  const labels = formData.labels.reduce(
    (acc, label) => {
      if (label.key && label.value) acc[label.key] = label.value
      return acc
    },
    {} as Record<string, string>
  )
  if (!labels.app && formData.name) labels.app = formData.name
  return labels
}

/**
 * Pod 模板标签，`app` 缺省补成工作负载名。
 *
 * 生成的 Pod 模板与 Service 的 selector 都用它：Service 选中的是 Pod，
 * selector 必须来自 Pod 实际拥有的标签。克隆场景下 formData.podLabels
 * 已指向新名字（prepareCloneResource 改写了模板），而 formData.labels
 * 还留着源负载的 metadata.labels——用后者当 selector 会让克隆体的
 * Service 选中源负载的 Pod。
 */
function podTemplateLabels(
  formData: DeploymentFormData
): Record<string, string> {
  const labels = pairsToRecord(formData.podLabels || [])
  if (!labels.app && formData.name) labels.app = formData.name
  return labels
}

/**
 * 端口行里请求了 Service 的部分，按「类型 + 线上 Service 名」分组生成 Service 文档。
 *
 * 命名：反显带上线上名字的端口行沿用该名字（名字与 `<负载名>-<类型>` 约定不一致的
 * 老 Service / 手建 Service，apply 才能按同名 Get 到并走 update；否则会当成新建，
 * 撞上线上 Service 已占用的 nodePort 直接报 already allocated）。新建的端口行
 * 沿用 `33c323d` 的约定：ClusterIP 用工作负载名，其余类型加 `-<类型小写>` 后缀。
 * 没有端口请求 Service 时返回空数组，调用方据此保持单文档 YAML。
 */
export function buildServiceDocuments(
  formData: DeploymentFormData
): Array<Record<string, unknown>> {
  const labelsObj = podTemplateLabels(formData)

  const groups = new Map<
    string,
    {
      type: Exclude<PortServiceType, 'none'>
      name: string
      entries: Array<{ port: Record<string, unknown>; clusterIP?: string }>
    }
  >()
  for (const container of formData.containers) {
    for (const p of container.ports) {
      if (p.serviceType === 'none' || !p.containerPort) continue
      const key = `${p.serviceType}|${p.serviceName || ''}`
      const group = groups.get(key) || {
        type: p.serviceType,
        name: p.serviceName || '',
        entries: [],
      }
      // 同一个容器端口在一个 Service 里只需要一条映射（多容器可能重复声明同一端口）。
      if (
        group.entries.some((entry) => entry.port.targetPort === p.containerPort)
      )
        continue
      group.entries.push({
        port: {
          ...(p.name ? { name: p.name } : {}),
          port: p.servicePort || p.containerPort,
          targetPort: p.containerPort,
          ...(p.serviceType === 'NodePort' && p.nodePort
            ? { nodePort: p.nodePort }
            : {}),
          ...(p.protocol === 'TCP' ? {} : { protocol: p.protocol }),
        },
        clusterIP: p.clusterIP?.trim() || undefined,
      })
      groups.set(key, group)
    }
  }

  const docs: Array<Record<string, unknown>> = []
  for (const { type, name, entries } of groups.values()) {
    const spec: Record<string, unknown> = {
      type,
      selector: labelsObj,
      ports: entries.map((entry) => entry.port),
    }
    // 静态 ClusterIP：允许在 service CIDR 内指定固定地址，只在 ClusterIP 上有意义。
    const staticIP = entries.find((entry) => entry.clusterIP)?.clusterIP
    if (type === 'ClusterIP' && staticIP) spec.clusterIP = staticIP
    docs.push({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name:
          name ||
          (type === 'ClusterIP'
            ? formData.name
            : `${formData.name}-${type.toLowerCase()}`),
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
  const labelsObj = workloadLabels(formData)
  // selector 必须用 Pod 模板标签，不能用 metadata.labels：两者在面板里是分开的两栏，
  // 只要用户在「标签」里加了自定义键，`selector: metadata 标签` 就会包含模板里
  // 没有的标签，apiserver 直接以 `selector does not match template labels` 拒收
  // （第 17 轮 D-138：StatefulSet 新建表单填两个标签就 422，Deployment / DaemonSet 同病）。
  // 与 buildServiceDocuments 同一口径（见 podTemplateLabels 的注释）；
  // 编辑反显时 podLabels 取自线上 template.metadata.labels（见 line ~1278），
  // 生成的 selector 与线上一致，不会撞上 selector immutable。
  const selectorLabels = podTemplateLabels(formData)

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
    labels: podTemplateLabels(formData),
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
    ...(buildVolumes(formData.podSpec?.volumes || []).length > 0 && {
      volumes: buildVolumes(formData.podSpec?.volumes || []),
    }),
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
          selector: { matchLabels: selectorLabels },
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
          selector: { matchLabels: selectorLabels },
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
        spec: { ...jobLevelSpec(formData), template: batchPodTemplate },
      }
      break
    case 'cronjobs':
      manifest = {
        apiVersion: 'batch/v1',
        kind: 'CronJob',
        metadata,
        spec: {
          schedule: formData.schedule || '*/5 * * * *',
          jobTemplate: {
            spec: { ...jobLevelSpec(formData), template: batchPodTemplate },
          },
        },
      }
      break
    default: {
      const strategy = formData.strategy
      const spec: Record<string, unknown> = {
        replicas: formData.replicas,
        selector: { matchLabels: selectorLabels },
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

  // 有端口请求 Service 时输出多文档 YAML：Service 在前，工作负载在后，
  // 一次 apply 全部落地（后端逐文档鉴权与写入）。
  const serviceDocs = buildServiceDocuments(formData)
  if (serviceDocs.length > 0) {
    const dumpOpts = { indent: 2, noRefs: true }
    return [...serviceDocs, manifest]
      .map((doc) => yaml.dump(doc, dumpOpts))
      .join('---\n')
  }

  return yaml.dump(manifest, { indent: 2, noRefs: true })
}
/**
 * 编辑页的反显输入：把线上工作负载与同命名空间下 selector 匹配它的
 * Service 拼成文档数组（parseYamlToFormData 从中识别 kind: 'Service'
 * 反显「网络」区块）。Service 是独立对象，编辑页若只拿工作负载单文档，
 * 网络区块会永远显示「不创建服务」。
 */
export function workloadWithServiceDocs(
  workload: Record<string, unknown>,
  services: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const spec = (workload.spec || {}) as {
    selector?: { matchLabels?: Record<string, string> }
    template?: { metadata?: { labels?: Record<string, string> } }
  }
  // Service 的 selector 指向的是 Pod 标签，而不是工作负载的 spec.selector：
  // Rancher 等工具创建的 Service 常带额外键（如 workload.user.cattle.io/*），
  // 只比对 spec.selector.matchLabels 会漏掉它们。合并 Pod 模板标签作基准。
  const matchLabels = {
    ...(spec.template?.metadata?.labels || {}),
    ...(spec.selector?.matchLabels || {}),
  }
  const docs = [workload]
  for (const svc of services) {
    const svcSpec = (svc.spec || {}) as { selector?: Record<string, string> }
    const selector = svcSpec.selector || {}
    // 空 selector 在新版本 K8s 里不选中任何 Pod，不会反显到端口行。
    if (Object.keys(selector).length === 0) continue
    if (!Object.entries(selector).every(([k, v]) => matchLabels[k] === v))
      continue
    docs.push(svc)
  }
  return docs
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
        // Service 类型先留空，随后由 Service 文档回填（见下方 "Map Service docs"）。
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
          // 容器内的挂载由容器面板的「存储」编辑，写的就是这个字段；生成 YAML 也从
          // 这里取。曾经在配置结构里另存一份，结果面板写的是这份、生成读的是那份。
          volumeMounts: ((c.volumeMounts as Array<any>) || []).map((vm) => ({
            name: vm.name || '',
            mountPath: vm.mountPath || '',
            subPath: vm.subPath,
            readOnly: !!vm.readOnly,
          })),
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
        // 只把表单能表达的卷类型读进来：projected / downwardAPI 这类
        // 没有对应输入项，硬塞进表单只会被当成空卷写回去（把线上对象改坏），
        // 所以留给 mergeEditedManifest 从线上对象恢复。
        volumes: ((podSpecDoc.volumes as Array<any>) || []).flatMap(
          (v): VolumeForm[] => {
            const name = v.name || ''
            if (v.emptyDir)
              return [{ name, sourceType: 'emptyDir' as const, options: {} }]
            if (v.hostPath)
              return [
                {
                  name,
                  sourceType: 'hostPath' as const,
                  options: {
                    path: v.hostPath.path,
                    hostPathType: v.hostPath.type || '',
                  },
                },
              ]
            if (v.configMap)
              return [
                {
                  name,
                  sourceType: 'configMap' as const,
                  options: { configMapName: v.configMap.name },
                },
              ]
            if (v.secret)
              return [
                {
                  name,
                  sourceType: 'secret' as const,
                  options: { secretName: v.secret.secretName },
                },
              ]
            if (v.persistentVolumeClaim)
              return [
                {
                  name,
                  sourceType: 'pvc' as const,
                  options: { claimName: v.persistentVolumeClaim.claimName },
                },
              ]
            if (v.nfs)
              return [
                {
                  name,
                  sourceType: 'nfs' as const,
                  options: {
                    nfsServer: v.nfs.server,
                    nfsPath: v.nfs.path,
                    nfsReadOnly: v.nfs.readOnly === true,
                  },
                },
              ]
            if (v.csi)
              return [
                {
                  name,
                  sourceType: 'csi' as const,
                  options: {
                    csiDriver: v.csi.driver,
                    csiFsType: v.csi.fsType || '',
                    csiReadOnly: v.csi.readOnly === true,
                    csiVolumeAttributes: Object.entries(
                      (v.csi.volumeAttributes || {}) as Record<string, string>
                    ).map(([key, value]) => ({ key, value: String(value) })),
                  },
                },
              ]
            return []
          }
        ),
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

    // Job 级参数：Job 在 spec 下，CronJob 在 spec.jobTemplate.spec 下。回填成字符串，
    // 让编辑表单能显示并改线上已有的值（留空则不写回，见 jobLevelSpec）。
    const jobSpec =
      resourceType === 'jobs'
        ? spec
        : (spec.jobTemplate?.spec as Record<string, any> | undefined)
    if (jobSpec) {
      for (const { key } of JOB_LEVEL_FIELDS) {
        const value = jobSpec[key]
        if (typeof value === 'number') base[key] = String(value)
      }
    }

    // 把 Service 文档映射回端口行：按 targetPort（数字或端口名）找到对应的
    // 容器端口行，记下它的 Service 类型、服务端口与 NodePort。多个 Service
    // 指向同一个容器端口时（比如同端口建了 ClusterIP 与 NodePort），按文档
    // 顺序各占一行，不互相覆盖——否则后处理的 Service 会抹掉先前的反显。
    const claimedRows = new Set<string>()
    for (const svc of docs.filter((d) => d && d.kind === 'Service')) {
      const svcSpec = (svc.spec || {}) as Record<string, any>
      const svcType = String(svcSpec.type || 'ClusterIP')
      // 表单只支持这三种类型；ExternalName 这类手写的 Service 不进端口行。
      if (
        svcType !== 'ClusterIP' &&
        svcType !== 'NodePort' &&
        svcType !== 'LoadBalancer'
      )
        continue
      for (const sp of (svcSpec.ports as Array<any>) || []) {
        const targetName =
          typeof sp.targetPort === 'string' ? sp.targetPort : ''
        const target =
          sp.targetPort !== undefined ? Number(sp.targetPort) : Number(sp.port)
        const candidates: Array<{ key: string; p: any }> = []
        base.containers.forEach((c, ci) => {
          c.ports.forEach((p, pi) => {
            if (targetName ? p.name === targetName : p.containerPort === target)
              candidates.push({ key: `${ci}:${pi}`, p })
          })
        })
        const row =
          candidates.find(({ key }) => !claimedRows.has(key)) || candidates[0]
        if (!row) continue
        claimedRows.add(row.key)
        row.p.serviceType = svcType
        // 记下线上 Service 的名字，生成时沿用（见 buildServiceDocuments）。
        const svcName = String(
          ((svc.metadata as Record<string, unknown> | undefined)?.name as
            string | undefined) || ''
        )
        if (svcName) row.p.serviceName = svcName
        // 服务端口与容器端口相同时是默认推导，不算用户填过。
        if (sp.port !== undefined && Number(sp.port) !== target)
          row.p.servicePort = Number(sp.port)
        if (sp.nodePort !== undefined) row.p.nodePort = Number(sp.nodePort)
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

/** Pod 模板在 manifest 里的位置：工作负载在 spec.template，CronJob 在 spec.jobTemplate.spec.template。 */
const POD_TEMPLATE_PATHS: string[][] = [
  ['spec', 'template'],
  ['spec', 'jobTemplate', 'spec', 'template'],
]

/** 取出 manifest 里的 Pod 模板；找不到时返回 null。 */
function podTemplateOf(
  manifest: Record<string, unknown>
): Record<string, unknown> | null {
  for (const path of POD_TEMPLATE_PATHS) {
    let current: unknown = manifest
    for (const key of path) {
      current = isPlainObject(current) ? current[key] : undefined
    }
    if (isPlainObject(current)) return current
  }
  return null
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
  if (!spec) return merged

  // 表单没有 restartPolicy 这一栏，但生成 batch 模板（Job / CronJob）时固定写
  // OnFailure（API 不接受 Job 模板用 Always）。线上对象用的是 Never 时，这个固定值会把
  // 「什么都没改」的保存变成一次 Pod 模板变更：Job 的模板不可变，API 会直接以
  // `spec.template: field is immutable` 拒绝。所以在编辑模式下按线上对象恢复 ——
  // YAML 标签页不走这里，想改 restartPolicy 仍然可以在那里改。
  const generatedPodSpec = podTemplateOf(merged)?.spec
  const originalPodSpec = podTemplateOf(original)?.spec
  if (
    isPlainObject(generatedPodSpec) &&
    isPlainObject(originalPodSpec) &&
    typeof originalPodSpec.restartPolicy === 'string'
  ) {
    generatedPodSpec.restartPolicy = originalPodSpec.restartPolicy
  }

  const selector = isPlainObject(original.spec)
    ? original.spec.selector
    : undefined
  if (!isPlainObject(selector)) return merged

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
 * 可选地把生成 manifest 里与线上对象同 kind 的文档合并到线上对象之上，
 * 其余文档（例如一并生成的 Service）保持原样。
 *
 * 这里按 kind 定位而不是取第一个文档：端口请求了 Service 时，生成的 YAML 是
 * 「Service 在前、工作负载在后」，拿第一个文档去合并会把 Service 和线上对象搅在一起。
 */
export function applyEditedManifest(
  content: string,
  original: Record<string, unknown>
): string {
  const docs = yaml.loadAll(content)
  if (docs.length === 0) return content
  const index = docs.findIndex(
    (doc) => isPlainObject(doc) && doc.kind === original.kind
  )
  if (index === -1) return content
  return docs
    .map((doc, i) =>
      i === index && isPlainObject(doc)
        ? yaml.dump(mergeEditedManifest(doc, original))
        : yaml.dump(doc)
    )
    .join('---\n')
}
