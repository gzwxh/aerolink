import { IconServer } from '@tabler/icons-react'

import { useCluster } from '@/hooks/use-cluster'

/**
 * Compact badge for the site header that always shows which cluster the user
 * is operating on, along with its custom description, to avoid accidental
 * actions against the wrong cluster.
 */
export function CurrentClusterBadge() {
  const { clusters, currentCluster, isLoading, isSwitching } = useCluster()

  if (isLoading || isSwitching) return null

  const cluster = clusters.find((c) => c.name === currentCluster)
  if (!cluster) return null

  return (
    <div
      className="hidden md:flex max-w-64 shrink-0 items-center gap-1.5 rounded-md border border-primary/20 bg-primary/5 px-2.5 py-1 text-sm"
      title={cluster.description || cluster.name}
    >
      <IconServer className="h-4 w-4 shrink-0 text-primary" />
      <span className="font-medium">{cluster.name}</span>
      {cluster.description && (
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {cluster.description}
        </span>
      )}
      {cluster.error && (
        <span className="min-w-0 truncate text-xs text-destructive">
          {cluster.error}
        </span>
      )}
    </div>
  )
}
