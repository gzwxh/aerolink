import { useMemo } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { useQuery } from '@tanstack/react-query'

import { fetchBindingGroups, fetchUserBindingGroups } from '@/lib/api'
import { useCluster } from '@/hooks/use-cluster'

/**
 * 当前集群下「命名空间 → 权限绑定组名」的映射。
 *
 * - 管理员走 /admin/binding-groups 取当前集群的全部绑定（成员视角只能看到
 *   自己是成员的组，会造成列表/下拉里大量「未绑定」的假象）；
 * - 普通用户仍走 /projects（当前用户可见的组，成员身份过滤）。
 *
 * detached（集群已删除被保留）的组不参与授权，一律排除；同一集群内一个
 * 命名空间只会属于一个权限绑定组（数据库层有唯一约束）。
 */
export function useNamespaceBindingMap() {
  const { currentCluster } = useCluster()
  const { user } = useAuth()
  const isAdmin = user?.isAdmin() ?? false

  const { data: bindingGroups = [] } = useQuery({
    queryKey: isAdmin
      ? ['admin-binding-groups', currentCluster]
      : ['user-binding-groups'],
    queryFn: () =>
      isAdmin
        ? fetchBindingGroups(currentCluster ?? undefined)
        : fetchUserBindingGroups(),
    staleTime: 60_000,
    enabled: isAdmin ? !!currentCluster : true,
  })

  return useMemo(() => {
    const map = new Map<string, string>()
    bindingGroups.forEach((group) => {
      if (group.cluster !== currentCluster || group.detached) return
      ;(group.namespaces ?? []).forEach((n) => map.set(n.namespace, group.name))
    })
    return map
  }, [bindingGroups, currentCluster])
}
