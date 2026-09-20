import { Boxes } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useCluster } from '@/hooks/use-cluster'
import { Badge } from '@/components/ui/badge'

/**
 * 创建页头部标注「将要建到哪个集群」。
 *
 * 这些页面围绕集群级资源展开，页面里没有任何命名空间上下文能暗示目标集群，切错集群时
 * 用户不会察觉（名字填对了就直接建出去了），所以把目标集群显式标出来。
 */
export function CurrentClusterBadge() {
  const { t } = useTranslation()
  const { currentCluster } = useCluster()

  if (!currentCluster) {
    return null
  }

  return (
    <Badge variant="outline" className="gap-1 font-normal">
      <Boxes className="h-3.5 w-3.5" />
      {t('common.currentCluster', '当前集群')}：{currentCluster}
    </Badge>
  )
}
