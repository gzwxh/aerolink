import { useSyncExternalStore } from 'react'
import {
  IconAlertTriangle,
  IconCloudOff,
  IconLogin2,
  IconRefresh,
} from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  getServiceStatus,
  retryService,
  subscribeServiceStatus,
  type ServiceStatus,
} from '@/lib/service-status'
import { withSubPath } from '@/lib/subpath'

function useServiceStatus(): ServiceStatus {
  return useSyncExternalStore(
    subscribeServiceStatus,
    getServiceStatus,
    getServiceStatus
  )
}

/**
 * 服务异常横幅：请求连续失败（5xx / 连不上）时贴在顶部，说明"已暂停自动刷新"，
 * 并给一个手动重试入口。不做整页跳转——那正是要消灭的行为。
 */
function ServiceUnavailableBanner({ status }: { status: ServiceStatus }) {
  const { t } = useTranslation()
  const offline =
    typeof navigator !== 'undefined' && navigator.onLine === false

  const message = offline
    ? t('serviceStatus.offline', '网络已断开，已暂停自动刷新')
    : status.reason === 'server'
      ? t('serviceStatus.serverUnavailable', '服务暂时不可用，已暂停自动刷新')
      : t('serviceStatus.networkUnavailable', '无法连接到服务，已暂停自动刷新')

  return (
    <div
      role="status"
      className="bg-warning/10 text-warning border-warning/25 fixed inset-x-0 top-0 z-[100] flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b px-4 py-2 text-xs"
    >
      <IconCloudOff className="size-4 shrink-0" />
      <span className="font-medium">{message}</span>
      <span className="text-warning/80">
        {t('serviceStatus.attempts', {
          count: status.attempts,
          defaultValue: '连续失败 {{count}} 次',
        })}
      </span>
      <Button
        size="sm"
        variant="outline"
        className="h-6 px-2 text-xs"
        onClick={retryService}
      >
        <IconRefresh className="size-3.5" />
        {t('serviceStatus.retry', '重试')}
      </Button>
    </div>
  )
}

/**
 * 登录跳转成环时的阻断页。
 *
 * 只有它必须阻断交互：这种情况页面本身在反复整页加载，任何"横幅"都会被下一次加载冲掉，
 * 唯一能让用户读到信息、并手动脱困的办法就是停在原地不再跳转。
 */
function RedirectLoopBlock() {
  const { t } = useTranslation()

  return (
    <div className="bg-background fixed inset-0 z-[100] flex items-center justify-center p-6">
      <div className="bg-card w-full max-w-md space-y-4 rounded-lg border p-6 text-center">
        <IconAlertTriangle className="text-destructive mx-auto h-10 w-10" />
        <div className="space-y-1">
          <p className="text-sm font-semibold">
            {t('serviceStatus.redirectLoopTitle', '登录状态异常，已停止自动跳转')}
          </p>
          <p className="text-muted-foreground text-xs">
            {t(
              'serviceStatus.redirectLoopHint',
              '检测到会话反复失效：页面已停止在首页与登录页之间来回跳转。请重新登录；若仍失败，请联系管理员核对登录来源限制与会话策略。'
            )}
          </p>
        </div>
        <div className="flex justify-center gap-2">
          <Button
            size="sm"
            onClick={() => {
              // 先清掉成环标记，再走一次带 forced 的登录页（该参数让登录页忽略
              // 「已登录就跳首页」，见 pages/login.tsx）。
              retryService()
              window.location.href = withSubPath('/login?forced=1')
            }}
          >
            <IconLogin2 className="size-4" />
            {t('serviceStatus.relogin', '重新登录')}
          </Button>
          <Button size="sm" variant="outline" onClick={retryService}>
            <IconRefresh className="size-4" />
            {t('serviceStatus.retry', '重试')}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** 全局唯一的服务异常展示位：主界面与独立 AI 页共用。 */
export function ServiceStatusOverlay() {
  const status = useServiceStatus()

  if (!status.unavailable) {
    return null
  }
  if (status.reason === 'redirectLoop') {
    return <RedirectLoopBlock />
  }
  return <ServiceUnavailableBanner status={status} />
}
