const CURRENT_CLUSTER_STORAGE_KEY = 'current-cluster'
const CURRENT_CLUSTER_HEADER_KEY = 'x-cluster-name'

export function getCurrentCluster() {
  return (
    sessionStorage.getItem(CURRENT_CLUSTER_STORAGE_KEY) ||
    localStorage.getItem(CURRENT_CLUSTER_STORAGE_KEY)
  )
}

export function setCurrentCluster(clusterName: string) {
  sessionStorage.setItem(CURRENT_CLUSTER_STORAGE_KEY, clusterName)
  localStorage.setItem(CURRENT_CLUSTER_STORAGE_KEY, clusterName)
}

export function clearCurrentCluster() {
  sessionStorage.removeItem(CURRENT_CLUSTER_STORAGE_KEY)
  localStorage.removeItem(CURRENT_CLUSTER_STORAGE_KEY)
}

export function appendCurrentClusterParam(
  params: URLSearchParams,
  currentCluster = getCurrentCluster()
) {
  if (currentCluster) {
    params.append(CURRENT_CLUSTER_HEADER_KEY, currentCluster)
  }
}

/**
 * 把当前集群写进请求头，并返回所用的集群名（没有当前集群时为 null）。
 * 返回值让调用方在响应回来时还能说清「这是哪个集群的响应」——响应到达时
 * 用户可能已经切到别的集群了。
 */
export function appendCurrentClusterHeader(
  headers: Record<string, string>
): string | null {
  const currentCluster = getCurrentCluster()
  if (currentCluster) {
    headers[CURRENT_CLUSTER_HEADER_KEY] = encodeURIComponent(currentCluster)
  }
  return currentCluster
}

/**
 * 展示用：把集群名还原成可读文本。
 *
 * 历史审计记录（以及归档里的副本）存的是 URL 编码后的集群名——写审计时漏了解码（已修），
 * 这些记录不会重写，所以在展示端做容错解码；没编码过或解不开时原样返回。
 */
export function decodeClusterName(name: string | null | undefined): string {
  if (!name) {
    return ''
  }
  if (!name.includes('%')) {
    return name
  }
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

export function withCurrentClusterPath(
  path: string,
  currentCluster: string | null = getCurrentCluster()
) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  if (!currentCluster) {
    return normalizedPath
  }
  return `/_clusters/${encodeURIComponent(currentCluster)}${normalizedPath}`
}

export function getClusterScopedStorageKey(key: string) {
  const currentCluster = getCurrentCluster()
  return `${currentCluster || ''}${key}`
}
