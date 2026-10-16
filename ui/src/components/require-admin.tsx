import type { ReactNode } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { IconLoader2, IconShieldLock } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { ClusterLink } from '@/components/cluster-link'

function LoadingState() {
  const { t } = useTranslation()

  return (
    <div className="flex items-center justify-center py-16 text-muted-foreground">
      <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
      {t('common.messages.loading', 'Loading...')}
    </div>
  )
}

function AccessDenied({
  title,
  message,
}: {
  title?: string
  message?: string
} = {}) {
  const { t } = useTranslation()

  return (
    <div className="flex items-center justify-center py-16">
      <Card className="max-w-md text-center">
        <CardHeader>
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
            <IconShieldLock className="h-6 w-6 text-destructive" />
          </div>
          <CardTitle>
            {title ?? t('accessDenied.title', 'Access Denied')}
          </CardTitle>
          <CardDescription>
            {message ??
              t(
                'accessDenied.message',
                'You do not have permission to view this page. Contact an administrator if you believe this is a mistake.'
              )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline">
            <ClusterLink to="/">
              {t('accessDenied.backToHome', 'Back to Home')}
            </ClusterLink>
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

/**
 * 仅管理员页面的路由守卫。真正的安全边界在后端
 * （管理接口会给非管理员返回 403）；这个组件只是通过渲染
 * 无权限页面而不是白屏来改善体验。
 */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth()

  if (isLoading) {
    return <LoadingState />
  }

  if (!user?.isAdmin()) {
    return <AccessDenied />
  }

  return <>{children}</>
}

/**
 * 单个控制台设置分区的路由守卫。现在每个分区都带自己的
 * 授权（settings.<section>），因此该守卫接收分区参数，
 * 与 pkg/middleware/system_settings.go 中的 middleware.RequireSettingsSection 保持一致。
 *
 * 省略 `section` 表示守护整个设置区（任意可读分区），
 * 设置区自身的导航正是以此为准。当页面承载多个分区的内容时，
 * 传一个列表：其中任意一个授权即可访问。
 */
export function RequireSettingsAccess({
  children,
  section,
}: {
  children: ReactNode
  section?: string | string[]
}) {
  const { user, isLoading } = useAuth()
  const { t } = useTranslation()

  if (isLoading) {
    return <LoadingState />
  }

  // 职责分离冲突会被后端整体拒绝（管理面 403 role_conflict）：直接说明原因与
  // 冲突的角色，比笼统的「无权限」可排查得多。
  const conflict = user?.roleConflict()
  if (conflict?.conflict) {
    return (
      <AccessDenied
        title={t('accessDenied.roleConflictTitle', '管理员角色冲突')}
        message={t('accessDenied.roleConflictMessage', {
          defaultValue:
            '当前账号同时持有互斥的管理员角色（{{roles}}），系统无法对其做职责分离，因此管理面已整体关闭。请由安全管理员移除其中一个角色后再试。',
          roles: conflict.roles.join(' / '),
        })}
      />
    )
  }

  const allowed =
    section === undefined
      ? user?.canViewSettings()
      : (Array.isArray(section) ? section : [section]).some((item) =>
          user?.canViewSettingsSection(item)
        )
  if (!allowed) {
    return <AccessDenied />
  }

  return <>{children}</>
}

export default RequireAdmin
