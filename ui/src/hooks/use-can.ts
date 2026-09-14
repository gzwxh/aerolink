import { useCallback } from 'react'
import { useAuth } from '@/contexts/auth-context'

import { roleCanAccessAnyNamespace } from '@/lib/rbac-permissions'
import { useCluster } from '@/hooks/use-cluster'

export interface CanOptions {
  namespace?: string
  cluster?: string | null
}

// useCan returns a permission predicate backed by the current user's roles.
// The active cluster is applied automatically unless the caller overrides it.
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
 * useCanAnyNamespace answers "may the user do this in at least one namespace?"
 * It backs entry points that are not scoped to a single namespace, such as a
 * list page's Create button or its bulk-delete action.
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
      return roleCanAccessAnyNamespace(user.roles, resource, verb, { cluster })
    },
    [user, currentCluster]
  )
}
