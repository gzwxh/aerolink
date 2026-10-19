import { useEffect, useRef, useState } from 'react'
import { IconCheck, IconChevronDown } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import { statusBadge } from '@/lib/status-badge'
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

/** 只在文本真的被 truncate 裁掉时才挂原生 title：完整可见也弹提示的话，
 *  会盖住侧边栏后面的菜单内容（ResizeObserver 兜容器宽度变化）。 */
function useTruncatedTitle(text: string | undefined) {
  const ref = useRef<HTMLSpanElement>(null)
  const [truncated, setTruncated] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setTruncated(el.scrollWidth > el.clientWidth)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [text])

  return { ref, title: truncated ? text : undefined }
}

export function ClusterSelector() {
  const { t } = useTranslation()
  const {
    clusters,
    currentCluster,
    setCurrentCluster,
    isSwitching,
    isLoading,
  } = useCluster()

  const currentClusterData = clusters.find((c) => c.name === currentCluster)
  const currentDescription = currentClusterData?.description?.trim()
  const currentError = currentClusterData?.error

  const nameTitle = useTruncatedTitle(currentClusterData?.name)
  const descTitle = useTruncatedTitle(currentError || currentDescription)

  if (isLoading || isSwitching) {
    return (
      <div className="flex items-center justify-center">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary" />
        {isSwitching && (
          <span className="ml-2 text-sm text-sidebar-foreground/70">
            {t('cluster.switching', '切换集群中...')}
          </span>
        )}
      </div>
    )
  }

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
                ref={nameTitle.ref}
                className="truncate text-sm font-medium"
                title={nameTitle.title}
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
                ref={descTitle.ref}
                className={cn(
                  'truncate text-xs',
                  currentError
                    ? 'text-destructive'
                    : 'text-sidebar-foreground/70'
                )}
                title={descTitle.title}
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
                  <Badge
                    {...statusBadge('failure')}
                    className="shrink-0 text-xs"
                  >
                    {t('cluster.syncError', '同步异常')}
                  </Badge>
                )}
                {/* 数据可能过期不是错误：集群还是能切的，只是切过去看到的是旧数据。 */}
                {!cluster.error && cluster.stale && (
                  <Badge
                    {...statusBadge('warning')}
                    className="shrink-0 text-xs"
                  >
                    {t('cluster.dataStale', '数据可能过期')}
                  </Badge>
                )}
              </div>
              <span
                className={cn(
                  'text-xs truncate',
                  cluster.error
                    ? 'text-destructive'
                    : cluster.stale
                      ? 'text-warning'
                      : 'text-muted-foreground font-mono'
                )}
                title={
                  cluster.error ||
                  (cluster.stale
                    ? t(
                        'cluster.dataStaleHint',
                        '暂时无法访问该集群，展示的是缓存数据'
                      )
                    : undefined) ||
                  cluster.description ||
                  cluster.version
                }
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
