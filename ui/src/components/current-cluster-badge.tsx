import { useTranslation } from 'react-i18next'

import { useCluster } from '@/hooks/use-cluster'
import { Badge } from '@/components/ui/badge'
import { ClusterBadge, ClusterBadgeIcon } from '@/components/cluster-badge'

/**
 * 页面头部标注「将要建到哪个集群」。
 *
 * 这些页面围绕集群级资源展开，页面里没有任何命名空间上下文能暗示目标集群，切错集群时
 * 用户不会察觉（名字填对了就直接建出去了），所以把目标集群显式标出来。
 *
 * 徽章（图标 + 自定义说明）整体排在最前面：切错集群时它比集群名更快认出来。集群名用
 * 加大字号的徽章紧跟其后，不写「当前集群：」前缀——前缀只是重复的标签，字小又要多看
 * 一眼，真正要认的只有名字本身。
 */
export function CurrentClusterBadge() {
  const { t } = useTranslation()
  const { currentCluster, clusters } = useCluster()

  if (!currentCluster) {
    return null
  }

  const currentClusterData = clusters.find((c) => c.name === currentCluster)

  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <ClusterBadgeIcon cluster={currentClusterData} size="sm" />
      <ClusterBadge cluster={currentClusterData} />
      <Badge
        variant="outline"
        // 前缀不上界面，悬停时仍然能知道这个徽章是「当前集群」。
        title={t('common.currentCluster', '当前集群')}
        className="text-sm font-semibold"
      >
        {currentCluster}
      </Badge>
    </span>
  )
}
