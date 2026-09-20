import { useAuth } from '@/contexts/auth-context'
import { IconShieldLock } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import { requestMFASetup } from '@/lib/mfa-prompt'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

/**
 * 超级管理员的 MFA 绑定引导（等保三级 D4）。
 *
 * 超级管理员不再允许被停用，它的保护手段改成**强制绑定 MFA**：这个卡片只对「当前登录者
 * 是超级管理员且尚未绑定」显示，点「立即绑定」直接打开「账号设置 → 安全」的绑定流程
 * （绑定需要再次验证当前密码，所以只能由本人完成，管理员代绑是做不到的）。
 *
 * 强制生效由安全策略负责：安全设置里的「MFA 策略」设为「管理员」时，后端会对未绑定的
 * 超级管理员返回 403 mfa_setup_required，前端由 MFAEnrollmentGate 拦截并引导绑定。
 */
export function SuperAdminMFAGuide() {
  const { t } = useTranslation()
  const { user } = useAuth()

  if (!user?.isSuperAdmin || user.mfa_enabled) {
    return null
  }

  return (
    <Card className="border-amber-500/40 bg-amber-500/5">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <IconShieldLock className="h-4 w-4 text-amber-600" />
          {t('superAdminMFA.title', '请为超级管理员账号绑定 MFA（多因素认证）')}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <span>
          {t(
            'superAdminMFA.description',
            '超级管理员拥有系统的全部权限。为保护这个最高权限账号，建议绑定身份验证器；绑定后登录与敏感操作需要动态码。如果需要回收它，请先确保还有别的启用账号能进入控制台管理面，再停用。'
          )}
        </span>
        <Button size="sm" className="shrink-0" onClick={requestMFASetup}>
          <IconShieldLock className="h-4 w-4" />
          {t('superAdminMFA.action', '立即绑定')}
        </Button>
      </CardContent>
    </Card>
  )
}
