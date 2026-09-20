import { IconCheck, IconChevronDown } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'
import { useCluster } from '@/hooks/use-cluster'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ClusterBadgeIcon } from '@/components/cluster-badge'

export function ClusterSelector() {
  const { t } = useTranslation()
  const {
    clusters,
    currentCluster,
    setCurrentCluster,
    isSwitching,
    isLoading,
  } = useCluster()

  if (isLoading || isSwitching) {
    return (
      <div className="flex items-center justify-center">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-blue-600" />
        {isSwitching && (
          <span className="ml-2 text-sm text-sidebar-foreground/70">
            {t('cluster.switching', '切换集群中...')}
          </span>
        )}
      </div>
    )
  }

  const currentClusterData = clusters.find((c) => c.name === currentCluster)
  const currentDescription = currentClusterData?.description?.trim()
  const currentError = currentClusterData?.error

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="flex h-auto max-w-full items-center gap-2 px-3 py-1 focus-visible:ring-0 focus-visible:border-transparent"
          disabled={isSwitching}
        >
          {/* 收起态与下拉项同构：首行「图标 + 名称 + 默认徽章」，次行描述或同步错误。
              这样切换前后两处排版一致，也避免收起时丢失默认/异常信息。 */}
          <span className="flex min-w-0 flex-1 flex-col text-left">
            <span className="flex min-w-0 items-center gap-2">
              <ClusterBadgeIcon cluster={currentClusterData} />
              <span
                className="truncate text-sm font-medium"
                title={currentClusterData?.name}
              >
                {isSwitching
                  ? t('cluster.switchingShort', '切换中...')
                  : currentClusterData?.name || t('cluster.select', '选择集群')}
              </span>
              {!isSwitching && currentClusterData?.isDefault && (
                <Badge className="shrink-0 text-xs">
                  {t('cluster.default', '默认')}
                </Badge>
              )}
            </span>
            {!isSwitching && (currentError || currentDescription) && (
              <span
                className={cn(
                  'truncate text-xs',
                  currentError
                    ? 'text-red-500'
                    : 'text-sidebar-foreground/70'
                )}
                title={currentError || currentDescription}
              >
                {currentError || currentDescription}
              </span>
            )}
          </span>
          <IconChevronDown className="h-3 w-3 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      {/* 下拉项要放下「名称 + 描述」两行，窄了描述会被切掉。 */}
      <DropdownMenuContent align="end" className="w-72">
        {clusters.map((cluster) => (
          <DropdownMenuItem
            key={cluster.name}
            onClick={() => setCurrentCluster(cluster.name)}
            disabled={!!cluster.error}
            className="flex items-center justify-between"
          >
            <div className="flex min-w-0 flex-col overflow-hidden">
              <div className="flex min-w-0 items-center gap-2">
                <ClusterBadgeIcon cluster={cluster} size="sm" />
                <span className="font-medium truncate" title={cluster.name}>
                  {cluster.name}
                </span>
                {cluster.isDefault && (
                  <Badge className="shrink-0 text-xs">
                    {t('cluster.default', '默认')}
                  </Badge>
                )}
                {cluster.error && (
                  <Badge variant="destructive" className="shrink-0 text-xs">
                    {t('cluster.syncError', '同步异常')}
                  </Badge>
                )}
              </div>
              <span
                className={cn(
                  'text-xs truncate',
                  cluster.error
                    ? 'text-red-500'
                    : 'text-muted-foreground font-mono'
                )}
                title={cluster.error || cluster.description || cluster.version}
              >
                {cluster.error || cluster.description || cluster.version}
              </span>
            </div>
            {currentCluster === cluster.name && (
              <IconCheck className="h-4 w-4 shrink-0" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
