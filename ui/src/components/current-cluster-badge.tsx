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
 *
 * 只用在创建页（含克隆页）的标题区：编辑页的对象已经落在某个集群里，没有「会不会建错
 * 集群」的问题，再标一遍只是重复顶栏与侧边栏已有的信息。
 *
 * `showName=false` 供顶栏使用：顶栏旁边就是侧边栏的集群选择器，集群名在那里已经写着，
 * 再标一遍只是重复；自定义说明保留，切错集群时仍能一眼看出来。
 * `showIcon=false` 同样只给顶栏：切换器就在旁边，图标（图片或图标文本）在那里已经显示过，
 * 顶栏再画一遍只是一块重复的色块。
 */
export function CurrentClusterBadge({
  showName = true,
  showIcon = true,
}: {
  showName?: boolean
  showIcon?: boolean
}) {
  const { t } = useTranslation()
  const { currentCluster, clusters } = useCluster()

  if (!currentCluster) {
    return null
  }

  const currentClusterData = clusters.find((c) => c.name === currentCluster)

  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {showIcon && <ClusterBadgeIcon cluster={currentClusterData} size="sm" />}
      <ClusterBadge cluster={currentClusterData} />
      {showName && (
        <Badge
          variant="outline"
          // 前缀不上界面，悬停时仍然能知道这个徽章是「当前集群」。
          title={t('common.currentCluster', '当前集群')}
          className="text-sm font-semibold"
        >
          {currentCluster}
        </Badge>
      )}
    </span>
  )
}
