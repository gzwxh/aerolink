// 一个基于 useLocation 解析查询参数的自定义 hook

import React from 'react'

import { useClusterLocation } from '@/lib/cluster-path'

export function useQuery() {
  const { search } = useClusterLocation()

  return React.useMemo(() => new URLSearchParams(search), [search])
}
