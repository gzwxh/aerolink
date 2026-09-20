import { useEffect } from 'react'
import { useAuth } from '@/contexts/auth-context'

import { authApiClient } from '@/lib/api-client'

/**
 * 会话心跳：单点登录把旧会话顶下线时，其它已登录页面要等「下一次请求发起 401」才知道。
 * 这里每 10 秒打一次轻量接口（页面重新获得焦点时也立即打一次）：
 * - 会话被顶替 → 401 + code=session_superseded，api-client 已负责弹出「账号在其他设备登录」；
 * - 普通 401（空闲/超时）→ 由 api-client 走刷新/跳登录的既有流程。
 */
export function useSessionHeartbeat() {
  const { user } = useAuth()

  useEffect(() => {
    if (!user) {
      return
    }
    let active = true
    const check = () => {
      if (!active) {
        return
      }
      authApiClient.get<void>('/auth/session').catch(() => {
        // 401 的提示/跳转由 api-client 统一接管，这里只需发起请求。
      })
    }
    check()
    const interval = window.setInterval(check, 10_000)
    const onFocus = () => check()
    window.addEventListener('focus', onFocus)
    return () => {
      active = false
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [user])
}
