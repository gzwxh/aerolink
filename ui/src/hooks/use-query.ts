// 一个基于 useLocation 解析查询参数的自定义 hook

import React from 'react'
import { useLocation } from 'react-router-dom'

export function useQuery() {
  const { search } = useLocation()

  return React.useMemo(() => new URLSearchParams(search), [search])
}
