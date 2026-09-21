// 自定资源的 API 类型

import {
  CustomResourceDefinition,
  CustomResourceDefinitionList,
} from 'kubernetes-types/apiextensions/v1'
import {
  DaemonSet,
  DaemonSetList,
  Deployment,
  DeploymentList,
  ReplicaSet,
  ReplicaSetList,
  StatefulSet,
  StatefulSetList,
} from 'kubernetes-types/apps/v1'
import {
  HorizontalPodAutoscaler,
  HorizontalPodAutoscalerList,
} from 'kubernetes-types/autoscaling/v2'
import { CronJob, CronJobList, Job, JobList } from 'kubernetes-types/batch/v1'
import {
  ConfigMap,
  ConfigMapList,
  Endpoints,
  EndpointsList,
  Event,
  EventList,
  Namespace,
  NamespaceList,
  Node,
  PersistentVolume,
  PersistentVolumeClaim,
  PersistentVolumeClaimList,
  PersistentVolumeList,
  Pod,
  Secret,
  SecretList,
  Service,
  ServiceAccount,
  ServiceAccountList,
  ServiceList,
} from 'kubernetes-types/core/v1'
import { EndpointSlice, EndpointSliceList } from 'kubernetes-types/discovery/v1'
import {
  Ingress,
  IngressList,
  NetworkPolicy,
  NetworkPolicyList,
} from 'kubernetes-types/networking/v1'
import {
  PodDisruptionBudget,
  PodDisruptionBudgetList,
} from 'kubernetes-types/policy/v1'
import {
  ClusterRole,
  ClusterRoleBinding,
  ClusterRoleBindingList,
  ClusterRoleList,
  Role as RawRole,
  RoleBinding,
  RoleBindingList,
  RoleList,
} from 'kubernetes-types/rbac/v1'
import { StorageClass, StorageClassList } from 'kubernetes-types/storage/v1'

import type { ResourceType } from '@/lib/resource-metadata'

import { Gateway, HTTPRoute } from './gateway'

export type { ResourceType } from '@/lib/resource-metadata'

export interface CustomResource {
  apiVersion: string
  kind: string
  metadata: {
    name: string
    namespace?: string
    creationTimestamp: string
    uid?: string
    resourceVersion?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
  }
  spec?: Record<string, unknown>
  status?: Record<string, unknown>
}

export interface CustomResourceList {
  apiVersion: string
  kind: string
  items: CustomResource[]
  metadata?: {
    continue?: string
    remainingItemCount?: number
  }
}

export interface DeploymentRelatedResource {
  events: Event[]
  pods: Pod[]
  services: Service[]
}

export interface HelmReleaseResource {
  apiVersion: string
  kind: string
  name: string
  namespace?: string
}

export interface HelmReleaseHistoryItem {
  revision: number
  status: string
  chart: string
  chartName: string
  chartVersion: string
  appVersion?: string
  values?: Record<string, unknown>
  description?: string
  firstDeployed?: string
  lastDeployed?: string
  deleted?: string
}

export interface HelmReleaseHistoryResponse {
  items: HelmReleaseHistoryItem[]
}

export interface HelmRelease {
  apiVersion: 'v1'
  kind: 'HelmRelease'
  metadata: {
    name: string
    namespace: string
    uid?: string
    resourceVersion?: string
    creationTimestamp?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
  }
  spec: {
    releaseName: string
    namespace: string
    chart: string
    chartName: string
    chartVersion: string
    appVersion?: string
    icon?: string
    revision: number
    values?: Record<string, unknown>
    defaultValues?: Record<string, unknown>
    manifest?: string
    notes?: string
    description?: string
  }
  status: {
    status: string
    firstDeployed?: string
    lastDeployed?: string
    deleted?: string
    resources?: HelmReleaseResource[]
  }
}

export interface HelmReleaseList {
  apiVersion: 'v1'
  kind: 'HelmReleaseList'
  items: HelmRelease[]
  metadata?: listMetadataType
}

export interface HelmRepository {
  id: number
  name: string
  url: string
  username?: string
  hasAuth: boolean
  createdAt: string
  updatedAt: string
}

export interface HelmChart {
  repositoryId: number
  repositoryName: string
  repositoryUrl: string
  source?: 'repository' | 'artifacthub'
  name: string
  version: string
  appVersion?: string
  kubeVersion?: string
  description?: string
  icon?: string
  home?: string
  artifactHubUrl?: string
  chartUrl?: string
  sources?: string[]
  keywords?: string[]
  maintainers?: {
    name: string
    email?: string
    url?: string
  }[]
  deprecated?: boolean
  updatedAt?: string
}

export interface HelmChartVersion {
  version: string
  appVersion?: string
  publishedAt?: string
}

export interface HelmChartList {
  items: HelmChart[]
  total?: number
}

export type HelmChartContentType = 'values' | 'templates'

export interface HelmChartTemplate {
  path: string
  content: string
}

export interface HelmChartContent {
  content?: string
  templates?: HelmChartTemplate[]
}

export interface HelmChartDetail extends HelmChart {
  readme?: string
  versions: HelmChartVersion[]
}

export interface HelmReleaseInstallRequest {
  releaseName: string
  namespace?: string
  chartUrl: string
  repositoryName?: string
  source?: 'repository' | 'artifacthub'
  values?: Record<string, unknown>
  description?: string
  createNamespace?: boolean
  wait?: boolean
}

export interface HelmReleaseUpgradeRequest {
  chartUrl?: string
  repositoryName?: string
  source?: 'repository' | 'artifacthub'
  values?: Record<string, unknown>
  description?: string
  forceConflicts?: boolean
  wait?: boolean
  rollbackOnFailure?: boolean
}

export interface HelmReleaseAutoUpgrade {
  clusterName: string
  namespace: string
  releaseName: string
  enabled: boolean
  scheduleType: 'interval' | 'daily'
  intervalMinutes: number
  scheduleTime: string
  timeoutMinutes: number
  rollbackOnFailure: boolean
  source?: 'repository' | 'artifacthub'
  repositoryName?: string
  chartName?: string
  lastCheckedAt?: string
  lastUpgradedAt?: string
  lastError?: string
}

export interface HelmReleaseAutoUpgradeRequest {
  enabled: boolean
  scheduleType: 'interval' | 'daily'
  intervalMinutes: number
  scheduleTime: string
  timeoutMinutes: number
  rollbackOnFailure: boolean
  source?: 'repository' | 'artifacthub'
  repositoryName?: string
  chartName?: string
}

export interface HelmReleaseDryRunResource {
  path: string
  content: string
  originalContent?: string
  modifiedContent?: string
  status?: 'added' | 'deleted' | 'changed' | 'unchanged'
  apiVersion?: string
  kind?: string
  name?: string
  namespace?: string
}

export interface HelmReleaseDryRunResponse {
  resources: HelmReleaseDryRunResource[]
}

type listMetadataType = {
  continue?: string
  remainingItemCount?: number
}

export interface KubernetesResource {
  apiVersion?: string
  kind?: string
  metadata?: {
    name?: string
    namespace?: string
    creationTimestamp?: string
    uid?: string
    resourceVersion?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
  }
  [key: string]: unknown
}

export interface KubernetesResourceList {
  apiVersion?: string
  kind?: string
  items: KubernetesResource[]
  metadata?: listMetadataType
}

// 定义资源类型映射
export interface ResourcesTypeMap {
  pods: {
    items: PodWithMetrics[]
    metadata?: listMetadataType
  }
  deployments: DeploymentList
  statefulsets: StatefulSetList
  daemonsets: DaemonSetList
  jobs: JobList
  cronjobs: CronJobList
  services: ServiceList
  endpoints: EndpointsList
  endpointslices: EndpointSliceList
  podtemplates: KubernetesResourceList
  replicationcontrollers: KubernetesResourceList
  limitranges: KubernetesResourceList
  resourcequotas: KubernetesResourceList
  componentstatuses: KubernetesResourceList
  gateways: {
    items: Gateway[]
    metadata?: listMetadataType
  }
  httproutes: {
    items: HTTPRoute[]
    metadata?: listMetadataType
  }
  configmaps: ConfigMapList
  secrets: SecretList
  persistentvolumeclaims: PersistentVolumeClaimList
  ingresses: IngressList
  networkpolicies: NetworkPolicyList
  namespaces: NamespaceList
  crds: CustomResourceDefinitionList
  crs: {
    items: CustomResource[]
    metadata?: listMetadataType
  }
  nodes: {
    items: NodeWithMetrics[]
    metadata?: listMetadataType
  }
  events: EventList
  persistentvolumes: PersistentVolumeList
  storageclasses: StorageClassList
  volumeattachments: KubernetesResourceList
  csidrivers: KubernetesResourceList
  csinodes: KubernetesResourceList
  csistoragecapacities: KubernetesResourceList
  volumeattributesclasses: KubernetesResourceList
  podmetrics: {
    items: PodMetrics[]
    metadata?: listMetadataType
  }
  replicasets: ReplicaSetList
  controllerrevisions: KubernetesResourceList
  poddisruptionbudgets: PodDisruptionBudgetList
  serviceaccounts: ServiceAccountList
  roles: RoleList
  rolebindings: RoleBindingList
  clusterroles: ClusterRoleList
  clusterrolebindings: ClusterRoleBindingList
  certificatesigningrequests: KubernetesResourceList
  clustertrustbundles: KubernetesResourceList
  podcertificaterequests: KubernetesResourceList
  leases: KubernetesResourceList
  leasecandidates: KubernetesResourceList
  runtimeclasses: KubernetesResourceList
  priorityclasses: KubernetesResourceList
  workloads: KubernetesResourceList
  podgroups: KubernetesResourceList
  flowschemas: KubernetesResourceList
  prioritylevelconfigurations: KubernetesResourceList
  validatingadmissionpolicies: KubernetesResourceList
  validatingadmissionpolicybindings: KubernetesResourceList
  validatingwebhookconfigurations: KubernetesResourceList
  mutatingwebhookconfigurations: KubernetesResourceList
  mutatingadmissionpolicies: KubernetesResourceList
  mutatingadmissionpolicybindings: KubernetesResourceList
  resourceslices: KubernetesResourceList
  resourceclaims: KubernetesResourceList
  deviceclasses: KubernetesResourceList
  resourceclaimtemplates: KubernetesResourceList
  devicetaintrules: KubernetesResourceList
  resourcepoolstatusrequests: KubernetesResourceList
  storageversions: KubernetesResourceList
  storageversionmigrations: KubernetesResourceList
  ingressclasses: KubernetesResourceList
  ipaddresses: KubernetesResourceList
  servicecidrs: KubernetesResourceList
  horizontalpodautoscalers: HorizontalPodAutoscalerList
  helmrelease: HelmReleaseList
}

export interface PodMetrics {
  metadata: {
    name: string
    namespace: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
    creationTimestamp?: string
    uid?: string
    resourceVersion?: string
  }
  containers: {
    name: string // container name
    usage: {
      cpu: string // 214572390n
      memory: string // 2956516Ki
    }
  }[]
}

export type MetricsData = {
  cpuUsage?: number
  memoryUsage?: number
  cpuLimit?: number
  memoryLimit?: number
  cpuRequest?: number
  memoryRequest?: number
  pods?: number
  podsLimit?: number
}

export type PodWithMetrics = Pod & {
  metrics?: MetricsData
}

export type NodeWithMetrics = Node & {
  metrics?: MetricsData
}

export interface ResourceTypeMap {
  pods: PodWithMetrics
  deployments: Deployment
  statefulsets: StatefulSet
  daemonsets: DaemonSet
  jobs: Job
  cronjobs: CronJob
  services: Service
  endpoints: Endpoints
  endpointslices: EndpointSlice
  podtemplates: KubernetesResource
  replicationcontrollers: KubernetesResource
  limitranges: KubernetesResource
  resourcequotas: KubernetesResource
  componentstatuses: KubernetesResource
  gateways: Gateway
  httproutes: HTTPRoute
  configmaps: ConfigMap
  secrets: Secret
  persistentvolumeclaims: PersistentVolumeClaim
  ingresses: Ingress
  networkpolicies: NetworkPolicy
  namespaces: Namespace
  crds: CustomResourceDefinition
  crs: CustomResource
  nodes: NodeWithMetrics
  events: Event
  persistentvolumes: PersistentVolume
  storageclasses: StorageClass
  volumeattachments: KubernetesResource
  csidrivers: KubernetesResource
  csinodes: KubernetesResource
  csistoragecapacities: KubernetesResource
  volumeattributesclasses: KubernetesResource
  replicasets: ReplicaSet
  controllerrevisions: KubernetesResource
  poddisruptionbudgets: PodDisruptionBudget
  podmetrics: PodMetrics
  serviceaccounts: ServiceAccount
  roles: RawRole
  rolebindings: RoleBinding
  clusterroles: ClusterRole
  clusterrolebindings: ClusterRoleBinding
  certificatesigningrequests: KubernetesResource
  clustertrustbundles: KubernetesResource
  podcertificaterequests: KubernetesResource
  leases: KubernetesResource
  leasecandidates: KubernetesResource
  runtimeclasses: KubernetesResource
  priorityclasses: KubernetesResource
  workloads: KubernetesResource
  podgroups: KubernetesResource
  flowschemas: KubernetesResource
  prioritylevelconfigurations: KubernetesResource
  validatingadmissionpolicies: KubernetesResource
  validatingadmissionpolicybindings: KubernetesResource
  validatingwebhookconfigurations: KubernetesResource
  mutatingwebhookconfigurations: KubernetesResource
  mutatingadmissionpolicies: KubernetesResource
  mutatingadmissionpolicybindings: KubernetesResource
  resourceslices: KubernetesResource
  resourceclaims: KubernetesResource
  deviceclasses: KubernetesResource
  resourceclaimtemplates: KubernetesResource
  devicetaintrules: KubernetesResource
  resourcepoolstatusrequests: KubernetesResource
  storageversions: KubernetesResource
  storageversionmigrations: KubernetesResource
  ingressclasses: KubernetesResource
  ipaddresses: KubernetesResource
  servicecidrs: KubernetesResource
  horizontalpodautoscalers: HorizontalPodAutoscaler
  helmrelease: HelmRelease
}

export interface RecentEvent {
  type: string
  reason: string
  message: string
  involvedObjectKind: string
  involvedObjectName: string
  namespace?: string
  timestamp: string
}

export interface UsageDataPoint {
  timestamp: string
  value: number
}

export interface ResourceUsageHistory {
  cpu: UsageDataPoint[]
  memory: UsageDataPoint[]
  networkIn: UsageDataPoint[]
  networkOut: UsageDataPoint[]
  diskRead: UsageDataPoint[]
  diskWrite: UsageDataPoint[]
}

// Pod 监控类型
export interface PodMetrics {
  cpu: UsageDataPoint[]
  memory: UsageDataPoint[]
  networkIn?: UsageDataPoint[]
  networkOut?: UsageDataPoint[]
  diskRead?: UsageDataPoint[]
  diskWrite?: UsageDataPoint[]
  fallback?: boolean
}

export interface OverviewData {
  totalNodes: number
  readyNodes: number
  totalPods: number
  runningPods: number
  totalNamespaces: number
  totalServices: number
  prometheusEnabled: boolean
  // 仅统计了授权命名空间的数据（无集群容量）。
  scoped: boolean
  resource: {
    cpu: {
      allocatable: number
      requested: number
      limited: number
    }
    memory: {
      allocatable: number
      requested: number
      limited: number
    }
  }
}

// 分页类型
export interface PaginationInfo {
  hasNextPage: boolean
  nextContinueToken?: string
  remainingItems?: number
}

export interface PaginationOptions {
  limit?: number
  continueToken?: string
}

// Pod 当前指标类型
export interface PodCurrentMetrics {
  podName: string
  namespace: string
  cpu: number // CPU cores
  memory: number // Memory in MB
}

export interface ImageTagInfo {
  name: string
  timestamp?: string
}

export interface RelatedResources {
  type: ResourceType
  name: string
  namespace?: string
  apiVersion?: string
}

export interface Cluster {
  id: number
  name: string
  description?: string
  version?: string
  config?: string
  enabled: boolean
  inCluster: boolean
  clusterAgent: boolean
  clusterAgentVersion?: string
  connected: boolean
  isDefault: boolean
  createdAt: string
  updatedAt: string
  prometheusURL?: string
  error?: string
  // 集群徽章：`/clusters` 只在启用时下发，`/admin/clusters/` 始终回传原值。
  badgeEnabled?: boolean
  badgeText?: string
  badgeColor?: string
  // 图标与徽章开关互相独立：只换图标、不显示说明的集群也会下发这几个字段。
  badgeIconEnabled?: boolean
  badgeIconText?: string
  /** 上传的图标地址（`/api/v1/clusters/<id>/badge-icon?v=<哈希>`），未上传时为空。 */
  badgeIconUrl?: string
}

export interface OAuthProvider {
  id: number
  name: string
  clientId: string
  clientSecret: string
  authUrl?: string
  tokenUrl?: string
  userInfoUrl?: string
  scopes?: string
  issuer?: string
  usernameClaim?: string
  groupsClaim?: string
  allowedGroups?: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface RoleAssignment {
  id: number
  roleId: number
  subjectType: 'user' | 'group'
  subject: string
  createdAt: string
  updatedAt: string
}

export interface ResourceGrant {
  resource: string
  verbs: string[]
}

export interface Role {
  id: number
  /** 角色 ID：权限判定与权限绑定的依据，全局唯一，创建后不可修改。 */
  name: string
  /**
   * 界面展示用的「名称」，可自定义；为空表示未自定义——内置角色显示内置名（随语言
   * 切换），自定义角色显示角色 ID（见 lib/system-roles.ts）。
   */
  displayName?: string
  description?: string
  isSystem?: boolean
  clusters: string[]
  /**
   * 旧模型的角色级命名空间限制：新建角色不再写入，但存量角色仍受其约束
   * （见 ui/src/lib/rbac-permissions.ts 的镜像判定）。
   */
  namespaces: string[]
  resources: string[]
  verbs: string[]
  /**
   * 按资源保存的操作集合（资源 × 操作一一对应）。新版角色用它判定；
   * 为空时退回 resources × verbs 的笛卡尔积（存量角色）。
   */
  grants?: ResourceGrant[]
  assignments?: RoleAssignment[]
  createdAt: string
  updatedAt: string
}

export interface UserItem {
  id: number
  username: string
  sub?: string
  provider: string
  createdAt: string
  lastLoginAt?: string
  enabled?: boolean
  pendingDeletion?: boolean
  avatar_url?: string
  name?: string
  oidc_groups?: string[]
  roles?: Role[]
  /** 联系方式。LDAP 账号从目录获取。 */
  email?: string
  phone?: string
  remark?: string
  /** 资料更新时间：LDAP 账号每次目录同步都会刷新。 */
  updatedAt?: string
  /** 账号到期时间；缺省表示不过期。 */
  expiresAt?: string
  /** 停用原因（inactive = 由「不活跃用户自动禁用」任务关闭）。 */
  disabledReason?: string
  disabledAt?: string
  /** 密码最后一次修改时间。 */
  password_updated_at?: string
  /**
   * 初始化创建的超级管理员账号：不可删除、不允许停用（保护手段是绑定 MFA）。
   */
  isSuperAdmin?: boolean
  /** 是否已绑定动态码（MFA）。 */
  mfa_enabled?: boolean
  /** 创建时选择「MFA 级别：禁用」的账号不受全局策略强制。 */
  mfaDisabled?: boolean
}

export interface FetchUserListResponse {
  users: UserItem[]
  total: number
  page: number
  size: number
}

export interface APIKey {
  id: number
  username: string
  apiKey: string
  lastLoginAt?: string
  createdAt: string
  updatedAt: string
  roles?: Role[]
}

// 资源历史类型
export interface ResourceHistory {
  id: number
  clusterName: string
  resourceType: string
  resourceName: string
  namespace: string
  operationType: string
  operationSource: string
  resourceYaml: string
  previousYaml: string
  success: boolean
  errorMessage: string
  /** 事件来源：发起请求的客户端 IP（等保三级要求审计记录含来源）。 */
  clientIp: string
  /** 事件来源：请求的 User-Agent。 */
  userAgent: string
  /** 账号被删除后为 null（审计记录保留，操作者以 operatorName 快照为准）。 */
  operatorId: number | null
  /** 写入时的操作者用户名快照，账号删除/改名后仍可追溯。 */
  operatorName: string
  operator: {
    username: string
    provider: string
  }
  createdAt: string
  updatedAt: string
}

export interface ResourceHistoryResponse {
  data: ResourceHistory[]
  pagination: {
    page: number
    pageSize: number
    total: number
    totalPages: number
    hasNextPage: boolean
    hasPrevPage: boolean
  }
}

export type WorkloadRevisionResourceType =
  'deployments' | 'statefulsets' | 'daemonsets'

export interface WorkloadRevisionItem {
  revision: number
  revisionObject: string
  changeCause?: string
  images: string[]
  replicas?: number
  createdAt: string
  current: boolean
}

export interface WorkloadRevisionsResponse {
  items: WorkloadRevisionItem[]
}

export interface AuditLogResponse {
  data: ResourceHistory[]
  total: number
  page: number
  size: number
  /**
   * 数据来源后端：只有 sink 不是 database 时才有（此时列表由归档检索回答）。
   * 界面据此提示"这份数据来自归档，不是实时库表"。
   */
  backend?: ArchiveBackend
  /** 刚发生的操作最晚多久之后才可查（秒）：parquet 攒批落盘带来的延迟，界面应明示。 */
  queryDelaySeconds?: number
}

/**
 * 归档检索的记录字段名与后端 ES 文档一致（snake_case，见方案 §5 schema）。
 * 这里只声明界面用到的字段，其余原样透传。
 */
export interface ArchiveAuditHistoryRecord {
  id?: number
  created_at?: string
  cluster_name?: string
  resource_type?: string
  resource_name?: string
  namespace?: string
  operation_type?: string
  operation_source?: string
  success?: boolean
  error_message?: string
  client_ip?: string
  user_agent?: string
  operator_name?: string
}

export interface ArchiveLoginRecord {
  id?: number
  created_at?: string
  user_id?: number
  username?: string
  provider?: string
  ip?: string
  user_agent?: string
  result?: string
}

export interface ArchiveAccessLogRecord {
  ts?: string
  client_ip?: string
  method?: string
  path?: string
  status_code?: number
  latency_ms?: number
  cluster?: string
  user?: string
}

/**
 * 归档检索的后端标识。
 *
 * - elasticsearch：走 ES 检索面（有倒排索引，能力最强）
 * - duckdb：DuckDB 直接查 parquet（本地热层 + S3 冷层），**不需要额外部署组件**
 * - victorialogs：VictoriaLogs 自己的 LogsQL 检索面
 * - openobserve：OpenObserve 自己的搜索接口
 */
export type ArchiveBackend =
  'elasticsearch' | 'duckdb' | 'victorialogs' | 'openobserve'

/**
 * 审计记录的落地方式（**五选一互斥**，见后端 model.AuditSink）。
 *
 * 由**配置文件**在启动时决定、运行期不变，因此界面只读展示：
 * - database：只写数据库（默认）
 * - parquet：只落 parquet 文件（可叠加 S3 远端副本），查询有攒批延迟
 * - elasticsearch：只写 Elasticsearch
 * - victorialogs：只写 VictoriaLogs（**不是** VictoriaMetrics：后者存不下字段明细）
 * - openobserve：只写 OpenObserve
 */
export type AuditSinkName =
  'database' | 'parquet' | 'elasticsearch' | 'victorialogs' | 'openobserve'

/** 归档检索后端的可用性：界面据此启用/禁用选项并解释原因。 */
export interface ArchiveBackendStatus {
  name: ArchiveBackend
  available: boolean
  /** 不可用的原因（例如「未启用 Elasticsearch」）。 */
  reason?: string
  /** 是否为当前配置下的默认后端。 */
  default: boolean
}

/** 可用后端列表与默认选择（`default` 为空表示没有任何后端可用）。 */
export interface ArchiveBackendsResponse {
  backends: ArchiveBackendStatus[]
  default: ArchiveBackend | ''
  /** 当前审计落地方式：通道互斥，界面据此给引导。 */
  sink?: string
}

/** 归档检索的响应结构，与本地列表接口同构（data/total/page/size）。 */
export interface ArchiveQueryResponse<T> {
  data: T[]
  total: number
  page: number
  size: number
  /** 本次结果来自哪个后端，界面据此提示数据来源。 */
  backend?: ArchiveBackend
}

/** 归档检索的类型：操作历史 / 登录 / 访问日志。 */
export type ArchiveKind = 'audit' | 'login' | 'access'

export interface LoginRecord {
  id: number
  userId: number
  username: string
  provider: string
  ip: string
  userAgent: string
  /**
   * 空字符串 = 登录成功；非空 = 失败原因码（invalid_credentials /
   * mfa_invalid / ip_denied / too_many_attempts / not_provisioned /
   * no_permission / captcha_invalid）。历史行可能为 null。
   */
  result?: string | null
  createdAt: string
}

export interface LoginLogResponse {
  data: LoginRecord[]
  total: number
  page: number
  size: number
  /** 数据来源后端（sink 非 database 时才有）；同 AuditLogResponse。 */
  backend?: ArchiveBackend
  /** 刚发生的操作最晚多久之后才可查（秒）。 */
  queryDelaySeconds?: number
}

export interface PasswordChangeLog {
  id: number
  userId: number
  username: string
  operatorId: number
  operator: string
  source: string
  createdAt: string
}

export interface PasswordChangeLogResponse {
  data: PasswordChangeLog[]
  total: number
  page: number
  size: number
  /** 数据来源后端（sink 非 database 时才有）；同 AuditLogResponse。 */
  backend?: ArchiveBackend
  /** 刚发生的操作最晚多久之后才可查（秒）。 */
  queryDelaySeconds?: number
}

/** syslog 外发的网络类型（tls 为加密外发）。 */
export type SyslogNetwork = 'udp' | 'tcp' | 'tls'

/** 日志输出格式：text 为现状，json 为结构化单行。 */
export type LogFormat = 'text' | 'json'

/**
 * 审计事件输出到标准输出（stdout）的设置：交给外部日志采集工具收走。
 *
 * 与 syslog 的区别：syslog 是应用主动外发到远端日志服务器；stdout 是本地输出、被动采集。
 * 默认开启且用 json——日志平台只收 stdout 时也应能查到「谁在什么时间从哪个 IP 做了什么」。
 */
export interface StdoutSetting {
  enabled: boolean
  format: LogFormat
}

/** 日志外发方式：**二选一**，同一时刻只有一条链路生效。 */
export type LogForwardMode = 'syslog' | 'kafka'

/** Kafka 的 SASL 认证机制，none 表示不做认证。 */
export type KafkaSASLMechanism =
  'none' | 'plain' | 'scram-sha-256' | 'scram-sha-512'

/** Kafka 外发的连接参数（mode=kafka 时生效）。 */
export interface KafkaSetting {
  /** `host:port` 列表。 */
  brokers: string[]
  topic: string
  saslMechanism: KafkaSASLMechanism
  username: string
  /** 只写不回显：读取时后端返回掩码，原样回传表示不修改。 */
  password: string
  /** 默认开启：审计记录含操作者与来源 IP，明文发到 broker 不是可接受的默认值。 */
  useTLS: boolean
  /** 仅 useTLS 时生效：跳过服务端证书校验（自签证书场景）。 */
  tlsInsecureSkipVerify: boolean
}

/**
 * 日志外发设置：一个开关 + 一种方式（syslog 或 kafka）。
 *
 * 注意字段名仍是后端 JSON 里的 `syslog`（历史键名，见 `AuditSetting.syslog`）。
 */
export interface LogForwardSetting {
  enabled: boolean
  mode: LogForwardMode
  /** —— 以下为 syslog 参数（mode=syslog 时生效）—— */
  network: SyslogNetwork
  /** host:port 形式 */
  address: string
  /** RFC5424 的 APP-NAME 字段。 */
  tag: string
  facility: number
  /** 外发消息正文格式：text（RFC5424 + key=value）或 json。 */
  format: LogFormat
  /** 仅 tls 生效：跳过服务端证书校验（自签证书场景）。 */
  insecureSkipVerify: boolean
  /** —— 以下为 Kafka 参数（mode=kafka 时生效）—— */
  kafka: KafkaSetting
}

/**
 * 审计章节配置：保留策略 + syslog 外发 + 归档。
 *
 * retentionDays 为 0 = 永久保留；非 0 时后端强制不低于 minRetentionDays。
 */
export interface AuditSetting {
  retentionDays: number
  /** 日志外发（syslog / kafka 二选一）；JSON 键沿用历史的 `syslog`，不可改名。 */
  syslog: LogForwardSetting
  stdout: StdoutSetting
  archive: ArchiveSetting
}

/** parquet writer 的攒批触发条件：时间 / 条数 / 字节满足其一即 flush。 */
export interface FlushSetting {
  intervalSeconds: number
  maxBatchRows: number
  maxBatchBytes: number
}

/** 访问日志的归档与本地滚留（与审计日志分开配置，默认保留期更短）。 */
export interface AccessLogArchiveSetting {
  enabled: boolean
  retentionDays: number
  maxBytes: number
  flush: FlushSetting
  /** 访问日志写到标准输出的格式：text（现状）或 json。 */
  format: LogFormat
}

/**
 * S3 兼容对象存储的归档设置（MinIO / RustFS / Ceph RGW / COS / OBS / OSS…）。
 * 各家只差 endpoint / pathStyle / region 三项。
 */
export interface S3ArchiveSetting {
  enabled: boolean
  endpoint: string
  region: string
  bucket: string
  accessKey: string
  /** 只写不回显：读取时后端返回掩码，原样回传表示不修改。 */
  secretKey: string
  pathStyle: boolean
  useTLS: boolean
  prefix: string
  /** 上传成功后删除本地文件（S3 作为最终存储）。 */
  deleteLocalAfterUpload: boolean
}

/** Elasticsearch 检索面设置：按天索引 `<indexPrefix>-YYYY.MM.DD`。 */
export interface ESArchiveSetting {
  enabled: boolean
  urls: string[]
  username: string
  /** 只写不回显：读取时后端返回掩码，原样回传表示不修改。 */
  password: string
  indexPrefix: string
  tlsInsecureSkipVerify: boolean
}

/**
 * VictoriaLogs 写入设置（写入走 ES bulk 兼容接口，检索走 LogsQL）。
 *
 * **不是** VictoriaMetrics：后者是时序库，存不下审计记录的字段明细。
 * 单 stream，不自己按天分区；过期数据由服务端 `-retentionPeriod` 负责。
 */
export interface VictoriaLogsArchiveSetting {
  enabled: boolean
  urls: string[]
  /** 日志流名（VictoriaLogs 的 stream 字段）。 */
  stream: string
  /** 多租户标识（请求头 AccountID / ProjectID），单租户留空。 */
  accountId: string
  projectId: string
  tlsInsecureSkipVerify: boolean
}

/**
 * OpenObserve 写入设置（写入走 `_json` 接口，检索走它自己的搜索接口）。
 *
 * 单 stream，不自己按天分区；过期数据由服务端 stream 的 `data_retention` 负责。
 */
export interface OpenObserveArchiveSetting {
  enabled: boolean
  urls: string[]
  /** 组织名（默认 default）。 */
  org: string
  /** 日志流名（默认 kite-audit）。 */
  stream: string
  username: string
  /** 只写不回显：读取时后端返回掩码，原样回传表示不修改。 */
  password: string
  tlsInsecureSkipVerify: boolean
}

/** 审计/访问日志的归档设置：本地 parquet + S3 + 三种外部日志存储。 */
export interface ArchiveSetting {
  enabled: boolean
  localDir: string
  retentionDays: number
  maxBytes: number
  flush: FlushSetting
  accessLog: AccessLogArchiveSetting
  s3: S3ArchiveSetting
  elasticsearch: ESArchiveSetting
  victorialogs: VictoriaLogsArchiveSetting
  openobserve: OpenObserveArchiveSetting
  /** 操作日志归档是否带上变更前后的资源清单（默认关：YAML 可能很大）。 */
  includeResourceYAML: boolean
}

export interface AuditSettingResponse {
  setting: AuditSetting
  /**
   * 审计记录的落地方式。由配置文件决定、运行期不变，所以界面上只读展示。
   */
  sink?: AuditSinkName
  /**
   * 保留天数是否由**存储端**负责（sink=victorialogs / openobserve 时为 true）。
   *
   * 这两家都没有「删除过期数据」的客户端接口，保留由服务端配置决定，因此界面必须明说
   * 「保留策略对当前存储方式不生效」，否则就是「配了没生效」的静默失效。
   */
  retentionServerSide?: boolean
  /** 后端强制的保留天数下限（30）。 */
  minRetentionDays: number
  /** 等保 / 网安法通常核查的最低保留期（180），仅作提示。 */
  recommendedRetention: number
}
export interface ResourceTemplate {
  id: number
  name: string
  description: string
  yaml: string
}
