import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { useBootstrap } from '@/lib/api/bootstrap'
import { migrateLegacyKiteStorageKey } from '@/lib/storage-migration'

// 已提示过的会话序号：同一个会话刷新页面不重复提示。
const SEEN_KEY = 'aerolink-session-takeover-notice'

/**
 * 新设备上的提示：单点登录下，这次登录会把其他设备上的会话顶下线，这里告诉用户
 * 「其他设备已退出」，方便本人确认；不是本人操作时提示改密码。
 *
 * 老设备那边由 SessionSupersededDialog 负责（那里是强制退出）。
 * 按产品要求用红色加粗显示，突出安全提醒。
 */
export function useSessionTakeoverNotice() {
  const { t } = useTranslation()
  const { data } = useBootstrap()
  const session = data?.session

  useEffect(() => {
    if (!session?.superseded || !session.seq) {
      return
    }
    const seq = String(session.seq)
    try {
      // 旧产品名时期的键：本次会话内先搬到新键，避免重复弹同一条提示。
      migrateLegacyKiteStorageKey(sessionStorage, SEEN_KEY)
      if (sessionStorage.getItem(SEEN_KEY) === seq) {
        return
      }
      sessionStorage.setItem(SEEN_KEY, seq)
    } catch {
      // 隐私模式等场景下 sessionStorage 不可用：退化为每次加载都提示一次。
    }
    toast.error(
      <span className="font-semibold text-destructive">
        {t(
          'session.takeoverNotice',
          '本次登录已让其他设备上的会话退出。如果这不是你本人的操作，请立即修改密码。'
        )}
      </span>,
      { id: 'session-takeover-notice' }
    )
  }, [session, t])
}
