import { ReactNode } from 'react'
import { useAuth } from '@/contexts/auth-context'
// 登录重定向必须用完整路由地址（含集群前缀）记录回跳目标，且发生在渲染期，
// 不能走集群包装版（会被再补一层前缀）——这里保留原始 API。
/* eslint-disable-next-line no-restricted-imports */
import { Navigate, useLocation } from 'react-router-dom'

interface ProtectedRouteProps {
  children: ReactNode
}

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, isLoading } = useAuth()
  const location = useLocation()

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-primary"></div>
      </div>
    )
  }

  if (!user) {
    const href = location.pathname + location.search + location.hash
    return <Navigate to={`/login?href=${encodeURIComponent(href)}`} replace />
  }

  const pendingRedirect = sessionStorage.getItem('loginRedirectHref')
  if (pendingRedirect) {
    sessionStorage.removeItem('loginRedirectHref')
    return <Navigate to={pendingRedirect} replace />
  }

  return <>{children}</>
}
