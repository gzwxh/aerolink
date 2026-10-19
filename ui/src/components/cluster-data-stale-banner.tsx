import { useSyncExternalStore } from 'react'
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import {
  getClusterDataStaleness,
  subscribeClusterDataStaleness,
  type ClusterDataStaleness,
} from '@/lib/cluster-data-staleness'
import { formatDateTime } from '@/lib/date-time'
import { getServiceStatus, subscribeServiceStatus } from '@/lib/service-status'
import { Button } from '@/components/ui/button'

function useClusterDataStaleness(): ClusterDataStaleness {
  return useSyncExternalStore(
    subscribeClusterDataStaleness,
    getClusterDataStaleness,
    getClusterDataStaleness
  )
}

/**
 * 集群数据陈旧横幅。
 *
 * 集群 API 掉线时后端仍会照常返回缓存里的对象，响应体看不出任何异常——节点列表会停在
 * 掉线前的那一刻，"数据是旧的"这件事只能由响应头（见 lib/cluster-data-staleness.ts）说明。
 * 这里把它显式讲出来，并给一个手动重载入口。
 *
 * 与「服务不可用」横幅互斥：那条横幅出现时请求已经发不出去，也就读不到这两个头，
 * 两条横幅叠在同一位置只会互相遮挡。
 */
export function ClusterDataStaleBanner() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const staleness = useClusterDataStaleness()
  const serviceStatus = useSyncExternalStore(
    subscribeServiceStatus,
    getServiceStatus,
    getServiceStatus
  )

  if (!staleness.stale || serviceStatus.unavailable) {
    return null
  }

  const cluster =
    staleness.cluster || t('clusterStale.unknownCluster', '当前集群')
  const message =
    staleness.lastFreshAt === null
      ? t('clusterStale.messageUnknownTime', {
          cluster,
          defaultValue: '无法访问集群 {{cluster}}，页面数据可能已过期',
        })
      : t('clusterStale.message', {
          cluster,
          time: formatDateTime(new Date(staleness.lastFreshAt)),
          defaultValue:
            '无法访问集群 {{cluster}}，页面数据最后更新于 {{time}}，可能已过期',
        })

  return (
    <div
      role="status"
      className="bg-warning/10 text-warning border-warning/25 fixed inset-x-0 top-0 z-[100] flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b px-4 py-2 text-xs"
    >
      <IconAlertTriangle className="size-4 shrink-0" />
      <span className="font-medium">{message}</span>
      <Button
        size="sm"
        variant="outline"
        className="h-6 px-2 text-xs"
        onClick={() => {
          // 集群不可达时重新拉取拿到的还是同一份缓存数据，横幅不会消失——
          // 但它能把「平台侧确实又试了一次」这件事变成事实，而不是让用户干等。
          void queryClient.refetchQueries({ type: 'active' })
        }}
      >
        <IconRefresh className="size-3.5" />
        {t('clusterStale.retry', '重试')}
      </Button>
    </div>
  )
}
