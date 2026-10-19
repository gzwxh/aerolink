/**
 * 集群数据陈旧信号：后端在集群作用域请求的响应头上带
 * `X-Cluster-Data-Stale`（陈旧时为 `1`）与 `X-Cluster-Data-Age`（距最后一次成功访问
 * 集群 API 的秒数），这里聚合成一个可订阅状态，让界面提示「本页数据可能已过期」。
 *
 * 三条约束（都是踩过的坑）：
 *   1. 只在「响应确实带了这两个头之一」时更新。只有集群作用域路由（`/_clusters/:cluster`
 *      与默认集群那组）才会带头，`/api/v1/clusters`、会话探活、公告这类不带头的响应
 *      若也参与清除，提示会随它们的节奏反复闪。
 *   2. 带头但不带 stale，就是后端确认「这份数据是新的」：立刻清除。恢复不需要额外的回调。
 *   3. 记的是「数据最后一次是新的时刻」（绝对时间戳）而不是秒数：秒数是响应到达那一刻的
 *      快照，直接展示会随每次渲染漂移。
 *   4. 「现在」优先取响应头 `Date`（服务器时间）而不是浏览器时钟：时钟没同步的机器上
 *      按 `Date.now() - Age` 反推会把「最后更新于」算偏（实测偏差过 2 分钟）；
 *      `Date` 头缺失或解析失败时才回落浏览器时钟。
 */

/** 与 pkg/middleware/cluster.go 的 ClusterDataStaleHeader 一致。 */
export const CLUSTER_DATA_STALE_HEADER = 'X-Cluster-Data-Stale'
/** 与 pkg/middleware/cluster.go 的 ClusterDataAgeHeader 一致。 */
export const CLUSTER_DATA_AGE_HEADER = 'X-Cluster-Data-Age'

export interface ClusterDataStaleness {
  /** 后端是否声明本次响应所依据的集群数据可能已过期。 */
  stale: boolean
  /** 判定陈旧的集群名；响应头不带集群名，取这次请求的集群上下文。 */
  cluster: string
  /** 后端最近一次成功访问该集群 API 的时刻（epoch ms）；从未成功过时为 null。 */
  lastFreshAt: number | null
}

const EMPTY: ClusterDataStaleness = {
  stale: false,
  cluster: '',
  lastFreshAt: null,
}

const listeners = new Set<() => void>()
let state: ClusterDataStaleness = EMPTY

function publish(next: ClusterDataStaleness) {
  if (
    next.stale === state.stale &&
    next.cluster === state.cluster &&
    next.lastFreshAt === state.lastFreshAt
  ) {
    return
  }
  state = next
  listeners.forEach((listener) => listener())
}

export function getClusterDataStaleness(): ClusterDataStaleness {
  return state
}

export function subscribeClusterDataStaleness(
  listener: () => void
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * 上报一次响应上的陈旧信号。cluster 是这次请求的集群名（拿不到时传 null）。
 *
 * 两个头都不带时不动状态：那不是集群作用域的响应，它证明不了集群数据的新鲜度。
 */
export function reportClusterDataStaleness(
  headers: Headers,
  cluster?: string | null
) {
  const staleHeader = headers.get(CLUSTER_DATA_STALE_HEADER)
  const ageHeader = headers.get(CLUSTER_DATA_AGE_HEADER)
  if (staleHeader === null && ageHeader === null) {
    return
  }

  const name = cluster?.trim() ?? ''
  if (staleHeader !== '1') {
    publish({ stale: false, cluster: name, lastFreshAt: null })
    return
  }

  const ageSeconds = Number.parseInt(ageHeader ?? '', 10)
  publish({
    stale: true,
    cluster: name,
    lastFreshAt: Number.isFinite(ageSeconds)
      ? responseClock(headers) - ageSeconds * 1000
      : null,
  })
}

/**
 * 「现在」的基准：优先用响应头 `Date`（服务器发出响应那一刻的 UTC 时间），
 * 按 `Date.now() - Age` 反推时不再受浏览器时钟漂移影响；
 * `Date` 头缺失或解析失败时回落浏览器时钟。
 */
function responseClock(headers: Headers): number {
  const dateHeader = headers.get('Date')
  if (dateHeader) {
    const serverNow = Date.parse(dateHeader)
    if (Number.isFinite(serverNow)) {
      return serverNow
    }
  }
  return Date.now()
}

/**
 * 清除当前提示（切换集群时调用）：旧集群的提示不该继续挂在已经换掉的页面上，
 * 新集群的状态由它自己的集群作用域响应给出。
 */
export function clearClusterDataStaleness() {
  publish(EMPTY)
}

/** 测试用：重置模块状态。 */
export function resetClusterDataStalenessForTest() {
  state = EMPTY
}
