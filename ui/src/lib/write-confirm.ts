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

import { getCurrentCluster } from '@/lib/current-cluster'
import { getResourceCatalogEntry } from '@/lib/resource-catalog'
import type { Cluster } from '@/types/api'

/** 参与二次确认的操作类别，与后端 model.Cluster 的 Confirm* 列一一对应。 */
export type WriteOperationKind =
  | 'create'
  | 'update'
  | 'delete'
  | 'restart'
  | 'nodeMaintenance'

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
const ACTION_PATH_SUFFIXES: Array<{ pattern: RegExp; kind: WriteOperationKind }> = [
  { pattern: /\/(drain|cordon|uncordon|taint|untaint)$/, kind: 'nodeMaintenance' },
]

function stripQuery(url: string): string {
  const index = url.indexOf('?')
  return index === -1 ? url : url.slice(0, index)
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

  const path = stripQuery(url)
  if (path.startsWith('/admin/') || path.startsWith('/auth/')) {
    return null
  }

  const normalized = method.toUpperCase()
  if (normalized !== 'POST' && normalized !== 'PUT' && normalized !== 'PATCH' && normalized !== 'DELETE') {
    return null
  }

  for (const entry of ACTION_PATH_SUFFIXES) {
    if (entry.pattern.test(path)) {
      return entry.kind
    }
  }

  // YAML apply 与 Helm release 是 k8s 写操作，但路径首段不是资源复数名。
  if (path.startsWith('/resources/apply') || path.startsWith('/helmrelease/')) {
    return normalized === 'DELETE' ? 'delete' : normalized === 'POST' ? 'create' : 'update'
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
  const segments = stripQuery(path).split('/').filter(Boolean)
  const resource = segments[0] ?? ''

  if (resource === 'resources' || resource === 'helmrelease') {
    return { resource, name: segments[2] || segments[1], namespace: segments[1] }
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
  if (!requiresWriteConfirm(cluster, kind)) {
    return null
  }
  return {
    cluster: cluster as string,
    kind,
    method: method.toUpperCase(),
    target: parseWriteTarget(path),
  }
}

// ---- 与弹窗组件之间的桥梁（写法同 lib/mfa-prompt.ts） ----

export const WRITE_CONFIRM_EVENT = 'aerolink:write-confirm'

let pending: {
  request: WriteConfirmRequest
  resolve: (confirmed: boolean) => void
} | null = null

/** 当前待确认的请求；弹窗未打开时为 null。 */
export function currentWriteConfirmRequest(): WriteConfirmRequest | null {
  return pending?.request ?? null
}

/** 等用户点「确认执行」或「取消」；确认返回 true。 */
export function requestWriteConfirm(
  request: WriteConfirmRequest
): Promise<boolean> {
  return new Promise((resolve) => {
    pending = { request, resolve }
    window.dispatchEvent(new Event(WRITE_CONFIRM_EVENT))
  })
}

export function resolveWriteConfirm(confirmed: boolean) {
  pending?.resolve(confirmed)
  pending = null
}

/**
 * 该集群是否开启了**任意**一类写操作确认。
 *
 * 终端（交互式 kubectl 与 exec）走裸 WebSocket，不经过 api-client，所以拦不住具体命令；
 * 能做的只是在进入前提示一次「这里不受保护」（见 components/terminal-content.tsx）。
 */
export function hasAnyWriteConfirm(cluster: string | null | undefined): boolean {
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
  pending = null
  try {
    window.sessionStorage.removeItem(TERMINAL_ACK_KEY)
  } catch {
    // 同上：清不掉也不影响其它状态。
  }
}
