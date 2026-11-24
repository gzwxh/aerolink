/**
 * k8s 写操作的「提交前二次确认」。
 *
 * 需求：集群可以逐类开启确认（新增 / 修改 / 删除 / 重启 / 节点维护），开启后用户点提交、
 * 请求真正发给 k8s **之前**先确认一次，避免误触。
 *
 * 为什么集中在这里而不是各操作自己弹窗：写操作分散在几十个组件里，逐一加必然漏；
 * 而所有 k8s 请求都经过 api-client（见 lib/api-client.ts 的 request）。于是：
 *   1. `writeConfirmFor()` 判断这次请求属于哪类操作、当前集群是否开了对应开关；
 *   2. 需要确认时由 api-client `await requestWriteConfirm()`，弹窗由应用壳里的
 *      `WriteConfirmDialog` 渲染，确认结果 resolve 回来；
 *   3. 用户取消 → api-client 直接抛错、**不发请求**。
 * 与 MFA 二次校验（lib/mfa-prompt.ts）是同一套「模块级桥梁」写法。
 *
 * 覆盖边界：终端与 exec 走裸 WebSocket（components/terminal-content.tsx），不经 api-client，
 * 因此不在覆盖范围内；集群自身的管理接口（/admin/*）也不弹——改开关本身不该再被确认一次。
 */

import type { Cluster } from '@/types/api'
import { getCurrentCluster } from '@/lib/current-cluster'
import { getResourceCatalogEntry } from '@/lib/resource-catalog'

/** 参与二次确认的操作类别，与后端 model.Cluster 的 Confirm* 列一一对应。 */
export type WriteOperationKind =
  'create' | 'update' | 'delete' | 'restart' | 'nodeMaintenance'

export interface WriteConfirmPolicy {
  create: boolean
  update: boolean
  delete: boolean
  restart: boolean
  nodeMaintenance: boolean
}

export interface WriteTarget {
  /** 资源类型（k8s 复数名，如 deployments）。 */
  resource: string
  namespace?: string
  name?: string
}

export interface WriteConfirmRequest {
  cluster: string
  kind: WriteOperationKind
  method: string
  target: WriteTarget
  /** 对象位于 kube-* 系统名称空间：弹窗要额外给出集群级风险提示。 */
  system?: boolean
}

const NEVER: WriteConfirmPolicy = {
  create: false,
  update: false,
  delete: false,
  restart: false,
  nodeMaintenance: false,
}

/** 集群名 → 确认策略。拦截发生在非 React 模块里，读不到 react-query 的数据，故缓存在这。 */
const policies = new Map<string, WriteConfirmPolicy>()

/** 由集群上下文在集群列表更新时调用（见 contexts/cluster-context.tsx）。 */
export function setClusterConfirmPolicies(clusters: Cluster[]) {
  policies.clear()
  for (const cluster of clusters) {
    policies.set(cluster.name, {
      create: cluster.confirmCreate === true,
      update: cluster.confirmUpdate === true,
      delete: cluster.confirmDelete === true,
      restart: cluster.confirmRestart === true,
      nodeMaintenance: cluster.confirmNodeMaintenance === true,
    })
  }
}

/** 该集群的这类操作是否需要二次确认；未知集群按不需要处理。 */
export function requiresWriteConfirm(
  cluster: string | null | undefined,
  kind: WriteOperationKind
): boolean {
  if (!cluster) {
    return false
  }
  return (policies.get(cluster) ?? NEVER)[kind]
}

/** 命令式动作的路径后缀：它们与普通 CRUD 共用 method，只能靠路径区分。 */
const ACTION_PATH_SUFFIXES: Array<{
  pattern: RegExp
  kind: WriteOperationKind
}> = [
  {
    pattern: /\/(drain|cordon|uncordon|taint|untaint)$/,
    kind: 'nodeMaintenance',
  },
]

function stripQuery(url: string): string {
  const index = url.indexOf('?')
  return index === -1 ? url : url.slice(0, index)
}

/**
 * 剥掉 API 请求路径里的 `/_clusters/<集群名>` 前缀（lib/current-cluster.ts 的
 * withCurrentClusterPath() 产出的**后端选集群**段，值是编码后的集群名）。
 * 注意它与浏览器地址的 `/_clusters/<slug>` 前缀（lib/cluster-path.ts）同形不同源；
 * 这里只处理发给后端的请求 URL，与前端导航无关。
 */
function stripApiClusterPrefix(path: string): string {
  const segments = path.split('/').filter(Boolean)
  if (segments[0] === '_clusters' && segments.length >= 2) {
    return `/${segments.slice(2).join('/')}`
  }
  return path
}

/**
 * 判断这次写请求属于哪类操作；返回 null 表示不需要参与二次确认。
 *
 * 主口径是 HTTP 方法：DELETE=删除、POST=新增、PUT/PATCH=修改。两处例外：
 *   - **重启**与普通修改同 URL 同 method（都是 PATCH 工作负载），只有请求体能区分，
 *     所以由 lib/api/core.ts 的 restartWorkload 显式标注（见 ApiRequestOptions.operation）；
 *   - 节点维护类接口（drain/cordon/…）路径可辨，用上面的后缀表识别。
 *
 * 排除项：后台管理接口（/admin/*，改的是 AeroLink 自己的配置）、认证接口（/auth/*），
 * 以及首段不是已知 k8s 资源的路径（个人设置、通知这类 POST 不该弹确认）。
 */
export function classifyWriteOperation(
  method: string,
  url: string,
  explicit?: WriteOperationKind
): WriteOperationKind | null {
  if (explicit) {
    return explicit
  }

  const path = stripApiClusterPrefix(stripQuery(url))
  if (path.startsWith('/admin/') || path.startsWith('/auth/')) {
    return null
  }

  const normalized = method.toUpperCase()
  if (
    normalized !== 'POST' &&
    normalized !== 'PUT' &&
    normalized !== 'PATCH' &&
    normalized !== 'DELETE'
  ) {
    return null
  }

  for (const entry of ACTION_PATH_SUFFIXES) {
    if (entry.pattern.test(path)) {
      return entry.kind
    }
  }

  // YAML apply 与 Helm release 是 k8s 写操作，但路径首段不是资源复数名。
  if (path.startsWith('/resources/apply') || path.startsWith('/helmrelease/')) {
    return normalized === 'DELETE'
      ? 'delete'
      : normalized === 'POST'
        ? 'create'
        : 'update'
  }

  const first = path.split('/').filter(Boolean)[0]
  if (!first || !getResourceCatalogEntry(first)) {
    return null
  }

  if (normalized === 'DELETE') {
    return 'delete'
  }
  if (normalized === 'POST') {
    return 'create'
  }
  return 'update'
}

/** 从 `/{resource}/{namespace}/{name}` 这类路径解析出给用户看的操作对象。 */
export function parseWriteTarget(path: string): WriteTarget {
  const segments = stripApiClusterPrefix(stripQuery(path))
    .split('/')
    .filter(Boolean)
  const resource = segments[0] ?? ''

  if (resource === 'resources' || resource === 'helmrelease') {
    return {
      resource,
      name: segments[2] || segments[1],
      namespace: segments[1],
    }
  }
  if (segments.length < 2) {
    return { resource }
  }

  const namespace = segments[1] === '_all' ? undefined : segments[1]
  if (segments.length < 3) {
    return { resource, namespace }
  }
  return { resource, namespace, name: segments[2] }
}

/**
 * 给出「这次请求是否需要确认」的判定结果；null 表示直接放行。
 * api-client 只需判断是否为 null，弹窗内容由 WriteConfirmDialog 渲染。
 */
export function writeConfirmFor(
  method: string,
  path: string,
  explicit?: WriteOperationKind
): WriteConfirmRequest | null {
  const kind = classifyWriteOperation(method, path, explicit)
  if (!kind) {
    return null
  }
  const cluster = getCurrentCluster()
  const target = parseWriteTarget(path)
  // 系统名称空间里的写操作**无论集群开关都要确认**（验收台账 D-144）：
  // 二次确认开关默认是关的，而 kube-system 里的 DaemonSet 误删/误改影响的是整个集群，
  // 不该取决于某个集群有没有勾选。其余操作仍按集群自己的策略。
  if (
    !isSystemNamespace(target.namespace) &&
    !requiresWriteConfirm(cluster, kind)
  ) {
    return null
  }
  return {
    cluster: cluster as string,
    kind,
    method: method.toUpperCase(),
    target,
    system: isSystemNamespace(target.namespace),
  }
}

/**
 * Kubernetes 保留的名称空间前缀（kube-system / kube-public / kube-node-lease）。
 * 里面的东西是集群自身的运转件（CNI / CSI / kube-proxy / 节点 agent），
 * 入口与按钮和业务负载完全一样，改错或删掉可能让整个集群失联。
 */
const SYSTEM_NAMESPACE_RE = /^kube-/i

export function isSystemNamespace(namespace?: string): boolean {
  return Boolean(namespace && SYSTEM_NAMESPACE_RE.test(namespace))
}

// ---- 与弹窗组件之间的桥梁（写法同 lib/mfa-prompt.ts） ----

export const WRITE_CONFIRM_EVENT = 'aerolink:write-confirm'

/** 弹窗当前展示的确认项：合并后的同类请求共用一个 request。 */
export interface WriteConfirmPrompt {
  request: WriteConfirmRequest
  /** 一起等这次确认的请求数；批量操作（如一次重启多个 Deployment）会大于 1。 */
  count: number
}

interface PendingConfirm {
  request: WriteConfirmRequest
  resolvers: Array<(confirmed: boolean) => void>
}

/**
 * 待确认队列（队首即弹窗正在展示的那一项）。
 *
 * 批量操作会并发发起多个写请求（见 components/resource-batch-action-dialog.tsx），
 * 而这里曾经是单槽 pending：后到的请求直接覆盖先到的，被覆盖的 Promise 永远等不到
 * 结果，界面就卡在「处理中 (1/3)」。所以同集群同类操作合并成一次确认、异类排队，
 * 别再退回单槽。
 */
const pendingQueue: PendingConfirm[] = []

function emitWriteConfirm() {
  window.dispatchEvent(new Event(WRITE_CONFIRM_EVENT))
}

/** 当前待确认的请求；弹窗未打开时为 null。 */
export function currentWriteConfirmRequest(): WriteConfirmPrompt | null {
  const head = pendingQueue[0]
  return head ? { request: head.request, count: head.resolvers.length } : null
}

/** 等用户点「确认执行」或「取消」；确认返回 true。 */
export function requestWriteConfirm(
  request: WriteConfirmRequest
): Promise<boolean> {
  return new Promise((resolve) => {
    // 同类（同集群 + 同操作类别）合并：批量重启只弹一次确认。
    const tail = pendingQueue[pendingQueue.length - 1]
    if (
      tail &&
      tail.request.cluster === request.cluster &&
      tail.request.kind === request.kind
    ) {
      tail.resolvers.push(resolve)
      if (pendingQueue.length === 1) {
        // 只有展示中的那一项变了条数才需要刷新弹窗。
        emitWriteConfirm()
      }
      return
    }

    pendingQueue.push({ request, resolvers: [resolve] })
    if (pendingQueue.length === 1) {
      emitWriteConfirm()
    }
  })
}

export function resolveWriteConfirm(confirmed: boolean) {
  const head = pendingQueue.shift()
  head?.resolvers.forEach((resolve) => resolve(confirmed))
  if (pendingQueue.length > 0) {
    // 排着下一个类别：让弹窗接着显示。
    emitWriteConfirm()
  }
}

/**
 * 该集群是否开启了**任意**一类写操作确认。
 *
 * 终端（交互式 kubectl 与 exec）走裸 WebSocket，不经过 api-client，所以拦不住具体命令；
 * 能做的只是在进入前提示一次「这里不受保护」（见 components/terminal-content.tsx）。
 */
export function hasAnyWriteConfirm(
  cluster: string | null | undefined
): boolean {
  if (!cluster) {
    return false
  }
  return Object.values(policies.get(cluster) ?? NEVER).some(Boolean)
}

/** 终端提示的「本会话已知晓」标记：按集群记，放 sessionStorage（关掉标签页即失效）。 */
const TERMINAL_ACK_KEY = 'aerolink:terminal-acknowledged-clusters'

function readAcknowledgedClusters(): string[] {
  try {
    const raw = window.sessionStorage.getItem(TERMINAL_ACK_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

/** 本次会话是否已经确认过该集群的终端风险提示。 */
export function isTerminalAcknowledged(
  cluster: string | null | undefined
): boolean {
  if (!cluster) {
    return true
  }
  return readAcknowledgedClusters().includes(cluster)
}

/** 记下「已知晓」，本次会话不再重复提示该集群。 */
export function acknowledgeTerminal(cluster: string | null | undefined) {
  if (!cluster) {
    return
  }
  const next = new Set(readAcknowledgedClusters())
  next.add(cluster)
  try {
    window.sessionStorage.setItem(TERMINAL_ACK_KEY, JSON.stringify([...next]))
  } catch {
    // storage 不可用（隐私模式等）：退化成每次提示，不影响功能。
  }
}

/** 测试用：清空缓存、待确认状态与终端知晓标记。 */
export function resetWriteConfirmForTest() {
  policies.clear()
  pendingQueue.length = 0
  try {
    window.sessionStorage.removeItem(TERMINAL_ACK_KEY)
  } catch {
    // 同上：清不掉也不影响其它状态。
  }
}
