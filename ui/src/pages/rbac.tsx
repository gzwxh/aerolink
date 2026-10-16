import { useSearchParams } from 'react-router-dom'

import { ClusterNavigate } from '@/components/cluster-link'

/**
 * RBAC 现在位于系统设置中。这样旧的 /rbac 深链
 * 仍然可用（命名空间权限对话框、用户组授权、书签），同时把
 * `tab` 重命名为嵌套的 RBAC 标签页参数，使其不会与
 * 设置分区参数冲突。
 */
export function RBACRedirect() {
  const [searchParams] = useSearchParams()
  const params = new URLSearchParams()
  searchParams.forEach((value, key) => {
    params.set(key === 'tab' ? 'rbacTab' : key, value)
  })
  const query = params.toString()

  return (
    <ClusterNavigate to={`/settings/rbac${query ? `?${query}` : ''}`} replace />
  )
}

export default RBACRedirect
