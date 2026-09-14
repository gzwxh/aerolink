import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { fetchClusterNamespaces, useClusterList } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'

export interface GrantsScopeRole {
  clusters: string[]
  namespaces: string[]
}

/**
 * Shows the clusters a subject can access, with a cluster picker. Because the
 * same namespace name may exist in several clusters, namespaces are resolved
 * against the selected cluster at view time: the list reloads from the cluster
 * and is intersected with the granted namespace patterns.
 */
export function GrantsScopePanel({ roles }: { roles: GrantsScopeRole[] }) {
  const { t } = useTranslation()
  const { data: clusterList = [] } = useClusterList()
  const allClusterNames = useMemo(
    () =>
      (clusterList || [])
        .map((c) => c.name)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b)),
    [clusterList]
  )

  const grantsAllClusters = roles.some((r) => r.clusters.includes('*'))
  const grantedClusters = useMemo(() => {
    const set = new Set<string>()
    for (const role of roles) {
      for (const c of role.clusters) {
        if (c !== '*') set.add(c)
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [roles])

  // '*' expands to every configured cluster.
  const selectableClusters = grantsAllClusters
    ? allClusterNames
    : grantedClusters

  const [activeCluster, setActiveCluster] = useState<string | null>(null)

  useEffect(() => {
    if (selectableClusters.length === 0) {
      if (activeCluster !== null) setActiveCluster(null)
      return
    }
    if (!activeCluster || !selectableClusters.includes(activeCluster)) {
      setActiveCluster(selectableClusters[0])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectableClusters.join(',')])

  const {
    data: clusterNamespaces = [],
    isLoading: nsLoading,
  } = useQuery({
    queryKey: ['rbac-cluster-namespaces', activeCluster],
    queryFn: () => fetchClusterNamespaces(activeCluster!),
    enabled: !!activeCluster,
    staleTime: 60_000,
  })

  // Namespaces the subject can access on the selected cluster: reload from
  // the cluster, then intersect with granted namespace patterns. A role with
  // namespace "*" lifts the restriction entirely.
  const grantsAllNamespaces = roles.some((r) => r.namespaces.includes('*'))
  const grantedNamespacePatterns = useMemo(() => {
    const set = new Set<string>()
    for (const role of roles) {
      for (const n of role.namespaces) {
        if (n !== '*') set.add(n)
      }
    }
    return set
  }, [roles])

  const effectiveNamespaces = useMemo(() => {
    if (grantsAllNamespaces) return clusterNamespaces
    return clusterNamespaces.filter((ns) => grantedNamespacePatterns.has(ns))
  }, [clusterNamespaces, grantsAllNamespaces, grantedNamespacePatterns])

  if (roles.length === 0) {
    return null
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-2 text-xs font-semibold text-muted-foreground">
          {t('userGrants.clustersTitle', 'Granted Clusters')}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {selectableClusters.length === 0 ? (
            <span className="text-sm text-muted-foreground">-</span>
          ) : (
            selectableClusters.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setActiveCluster(c)}
                className={cn(
                  'rounded-full border px-3 py-1 text-sm transition-colors',
                  activeCluster === c
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'hover:bg-accent'
                )}
              >
                {c}
              </button>
            ))
          )}
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
          <span>
            {t('userGrants.namespacesTitle', {
              cluster: activeCluster ?? '',
              defaultValue: 'Namespaces on {{cluster}}',
            })}
          </span>
          {nsLoading && (
            <span>{t('common.messages.loading', 'Loading...')}</span>
          )}
        </div>
        {grantsAllNamespaces ? (
          <p className="text-sm text-muted-foreground">
            {t(
              'userGrants.allNamespacesGranted',
              'All namespaces on this cluster are granted (*).'
            )}
          </p>
        ) : effectiveNamespaces.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {nsLoading
              ? ''
              : t(
                  'userGrants.noNamespacesOnCluster',
                  'No granted namespaces exist on this cluster.'
                )}
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {effectiveNamespaces.map((ns) => (
              <Badge key={ns} variant="outline">
                {ns}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default GrantsScopePanel
