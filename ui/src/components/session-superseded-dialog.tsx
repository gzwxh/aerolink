import { useEffect, useState } from 'react'
import { IconAlertTriangle } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import {
  resetSessionSupersededNotice,
  SESSION_SUPERSEDED_EVENT,
} from '@/lib/session-events'
import { withSubPath } from '@/lib/subpath'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'

/**
 * 账号被顶下线的提示（单点登录）：后端拒绝旧会话时给出明确的解释，而不是
 * 直接把用户丢回登录页。会话已经失效，所以弹窗不可关闭，只能「重新登录」。
 */
export function SessionSupersededDialog() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const handle = () => setOpen(true)
    window.addEventListener(SESSION_SUPERSEDED_EVENT, handle)
    return () => window.removeEventListener(SESSION_SUPERSEDED_EVENT, handle)
  }, [])

  if (!open) {
    return null
  }

  return (
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        // 会话已失效，逃逸键/点击遮罩都不该把提示关掉（关了也做不了任何操作）。
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        className="max-w-md"
      >
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-warning/10">
            <IconAlertTriangle className="h-5 w-5 text-warning" />
          </div>
          <div className="space-y-2">
            <h2 className="text-base font-semibold">
              {t('session.supersededTitle', '账号已在其他设备登录')}
            </h2>
            <p className="text-sm whitespace-pre-line text-muted-foreground">
              {t(
                'session.supersededMessage',
                '你的账号刚刚在其他设备登录，出于安全考虑，当前页面的登录状态已自动退出。\n\n如果这是你本人的操作，重新登录即可继续使用；如果不是你本人操作，说明密码可能已经泄露，请立即修改密码并联系管理员。'
              )}
            </p>
            <div className="pt-2">
              <Button
                onClick={() => {
                  resetSessionSupersededNotice()
                  // forced=1 让登录页忽略「已登录就跳首页」的默认行为：同一浏览器里可能
                  // 还留着新会话的 cookie，不带这个参数就看不到登录页。
                  window.location.href = withSubPath('/login?forced=1')
                }}
              >
                {t('session.signInAgain', '重新登录')}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default SessionSupersededDialog
