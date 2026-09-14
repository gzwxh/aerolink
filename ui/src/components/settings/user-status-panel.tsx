import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'

import { setUserEnabled } from '@/lib/api'
import { fetchAPI } from '@/lib/api/shared'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

interface AutoDisabledUser {
  id: number
  username: string
  disabledReason?: string
  disabledAt?: string
}

/**
 * 「用户状态」：列出被「不活跃自动禁用」策略关闭的账号，并支持手动恢复。
 * 数据来自 GET /admin/notification-setting/disabled-users，
 * 恢复复用 POST /admin/users/:id/enable。
 */
export function UserStatusPanel() {
  const { t } = useTranslation()
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['auto-disabled-users'],
    queryFn: () =>
      fetchAPI<{ users: AutoDisabledUser[] }>(
        '/admin/notification-setting/disabled-users'
      ),
    staleTime: 15000,
  })

  const users = data?.users ?? []

  const handleRestore = async (user: AutoDisabledUser) => {
    try {
      await setUserEnabled(user.id, true)
      toast.success(
        t('securitySettings.userStatus.restored', '已恢复 {{name}}', {
          name: user.username,
        })
      )
      await refetch()
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t('securitySettings.userStatus.restoreFailed', '恢复失败')
      )
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {t('securitySettings.userStatus.title', '用户状态')}
        </CardTitle>
        <CardDescription>
          {t(
            'securitySettings.userStatus.description',
            '被「不活跃用户自动禁用」关闭的账号会列在这里，可手动恢复；恢复后用户需要重新登录。'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading && (
          <p className="text-sm text-muted-foreground">
            {t('common.messages.loading', '加载中...')}
          </p>
        )}
        {!isLoading && users.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {t('securitySettings.userStatus.empty', '暂无被自动禁用的账号')}
          </p>
        )}
        {users.map((user) => (
          <div
            key={user.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium">
                {user.username}
                <Badge variant="destructive">
                  {t('common.fields.disabled', '已禁用')}
                </Badge>
              </div>
              <div className="text-xs text-muted-foreground">
                {t('securitySettings.userStatus.reason', '原因')}：
                {t(
                  `securitySettings.userStatus.reasons.${user.disabledReason ?? 'unknown'}`,
                  '长期未登录（自动禁用）'
                )}
                {user.disabledAt &&
                  ` · ${new Date(user.disabledAt).toLocaleString()}`}
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleRestore(user)}
            >
              {t('securitySettings.userStatus.restore', '恢复')}
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
