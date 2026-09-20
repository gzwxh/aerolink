import { useCallback } from 'react'
import { useAuth } from '@/contexts/auth-context'

import {
  permissionRoles,
  roleCanAccessAnyNamespace,
} from '@/lib/rbac-permissions'
import { useCluster } from '@/hooks/use-cluster'

export interface CanOptions {
  namespace?: string
  cluster?: string | null
}

// useCan 返回一个由当前用户角色支撑的权限判定函数。
// 除非调用方覆盖，否则会自动应用当前集群。
export function useCan() {
  const { user } = useAuth()
  const { currentCluster } = useCluster()

  return useCallback(
    (resource: string, verb: string, options?: CanOptions) => {
      if (!user) {
        return false
      }
      const cluster =
        options?.cluster !== undefined ? options.cluster : currentCluster
      return user.can(resource, verb, {
        cluster,
        namespace: options?.namespace,
      })
    },
    [user, currentCluster]
  )
}

/**
 * useCanAnyNamespace 回答"用户是否至少能在某个命名空间里做这件事？"
 * 它支撑那些不限定单个命名空间的入口，例如
 * 列表页的创建按钮或批量删除操作。
 */
export function useCanAnyNamespace() {
  const { user } = useAuth()
  const { currentCluster } = useCluster()

  return useCallback(
    (resource: string, verb: string, options?: { cluster?: string | null }) => {
      if (!user) {
        return false
      }
      const cluster =
        options?.cluster !== undefined ? options.cluster : currentCluster
      return roleCanAccessAnyNamespace(
        permissionRoles(user.roles, user.namespaceScopedRoles),
        resource,
        verb,
        { cluster, isAdmin: user.isAdmin() }
      )
    },
    [user, currentCluster]
  )
}
