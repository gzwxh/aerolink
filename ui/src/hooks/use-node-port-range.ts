import { useQuery } from '@tanstack/react-query'

import { fetchNodePortRange } from '@/lib/api'
import { knownNodePortRange } from '@/lib/node-port-range'
import { useCluster } from '@/hooks/use-cluster'

/**
 * 当前集群真实的 NodePort 范围（`--service-node-port-range`）；读不到时为 null。
 *
 * 拿不到时不要拿 K8s 默认值当集群事实去校验用户输入（判定口径见
 * `lib/node-port-range.ts`）：调用方据此决定「提示范围并按它校验」还是「不做范围校验」。
 *
 * 接口本身要求管理员，普通用户会 403；这里 `retry: false`，失败即视为「不知道」。
 */
export function useNodePortRange(): { min: number; max: number } | null {
  const { currentCluster } = useCluster()
  const { data } = useQuery({
    queryKey: ['nodeport-range', currentCluster],
    queryFn: () => fetchNodePortRange(currentCluster || ''),
    enabled: !!currentCluster,
    staleTime: 10 * 60 * 1000,
    retry: false,
  })

  return knownNodePortRange(data)
}
