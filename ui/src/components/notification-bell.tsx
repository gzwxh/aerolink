import { useState } from 'react'
import { IconBell } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import {
  useClearNotifications,
  useMarkNotificationsRead,
  useNotifications,
  useUnreadNotificationCount,
  type InAppNotification,
} from '@/lib/api'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

/**
 * 站内信入口：顶栏铃铛 + 未读红点 + 消息列表。
 * 未读数每 60 秒刷新一次（见 useUnreadNotificationCount）。
 */
export function NotificationBell() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const { data: unread } = useUnreadNotificationCount(true)
  const { data, isLoading } = useNotifications(1, 20, open)
  const markRead = useMarkNotificationsRead()
  const clearAll = useClearNotifications()

  const count = unread?.count ?? 0
  const items: InAppNotification[] = data?.items ?? []

  const handleClearAll = () => {
    // 两段式确认：第一次点击进入确认态，再次点击才真正清空，防止误触。
    if (!confirmingClear) {
      setConfirmingClear(true)
      return
    }
    setConfirmingClear(false)
    clearAll.mutate()
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('notifications.inbox.title', '通知')}
          title={t('notifications.inbox.title', '通知')}
          className="relative flex items-center justify-center rounded-sm p-1 text-muted-foreground transition-colors hover:text-foreground"
        >
          <IconBell className="h-5 w-5" />
          {count > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium leading-none text-white">
              {count > 99 ? '99+' : count}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 overflow-hidden p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-medium">
            {t('notifications.inbox.title', '通知')}
          </span>
          {items.length > 0 && (
            <div className="flex items-center gap-3">
              {count > 0 && (
                <button
                  type="button"
                  className="text-xs text-primary hover:underline"
                  onClick={() => markRead.mutate({ all: true })}
                >
                  {t('notifications.inbox.markAllRead', '全部已读')}
                </button>
              )}
              <button
                type="button"
                disabled={clearAll.isPending}
                className={`text-xs hover:underline ${
                  confirmingClear
                    ? 'text-destructive font-medium'
                    : 'text-muted-foreground'
                }`}
                onClick={handleClearAll}
                onMouseLeave={() => setConfirmingClear(false)}
              >
                {confirmingClear
                  ? t('notifications.inbox.confirmClear', '确认清空？')
                  : t('notifications.inbox.clearAll', '清空全部')}
              </button>
            </div>
          )}
        </div>
        <div className="max-h-80 overflow-y-auto">
          {isLoading && (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              {t('common.messages.loading', '加载中...')}
            </p>
          )}
          {!isLoading && items.length === 0 && (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              {t('notifications.inbox.empty', '暂无通知')}
            </p>
          )}
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                if (!item.read) {
                  markRead.mutate({ id: item.id })
                }
              }}
              className="block w-full border-b px-3 py-2 text-left last:border-b-0 hover:bg-muted/60"
            >
              <div className="flex items-center gap-2">
                {!item.read && (
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" />
                )}
                <span className="truncate text-sm font-medium">
                  {item.title}
                </span>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                {item.content}
              </p>
              <div className="mt-1 text-[10px] text-muted-foreground">
                {new Date(item.createdAt).toLocaleString()}
              </div>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
