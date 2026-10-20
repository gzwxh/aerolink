import { useMemo } from 'react'
import { IconChevronDown, IconSpeakerphone } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import {
  ANNOUNCEMENT_LEVEL_ICONS,
  type AnnouncementLevel,
} from '@/lib/announcement-markup'
import { useAnnouncements } from '@/lib/api'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

import { AnnouncementContent } from './announcement-content'
import { AnnouncementTicker } from './announcement-ticker'

/**
 * 顶栏通知栏：管理员发布的公告在这里滚动输出。
 *
 * - 渲染在顶栏里、集群徽章之前（见 SiteHeader），占一小块区域，**没有外框**：
 *   就是一行滚动文字 + 一个级别色的喇叭图标；
 * - 滚动本身在 AnnouncementTicker 里（管理页的预览复用同一份，避免两处观感走偏）；
 * - 三种「读全」的手段（滚动只是其中一种，消息很长时用户可能来不及看完）：
 *   鼠标悬停暂停、按住拖动（横向拖看前后文）、右侧展开全文；
 * - **不受** `prefers-reduced-motion` 影响：滚不滚只看公告自己的配置（理由见
 *   styles/base.css 里那段说明）——管理员已按条决定过，被客户端偏好静默否决会得到
 *   「勾了横向滚动却没滚、也没人解释为什么」，比不尊重偏好更糟；
 * - 同时有多条时按优先级顺序串成一条，图标颜色取其中最高的级别。
 *
 * 见 plans/2026-09-21-顶部通知栏.md。
 */

// 多条公告同时生效时，整条通知栏取其中最高的级别。
const LEVEL_RANK: Record<AnnouncementLevel, number> = {
  info: 0,
  warning: 1,
  danger: 2,
}

export function AnnouncementBar() {
  const { t } = useTranslation()
  const { data } = useAnnouncements()
  // 用 useMemo 固定引用：直接写 `data?.items ?? []` 会让下面几处依赖每次渲染都变。
  const items = useMemo(() => data?.items ?? [], [data])

  if (items.length === 0) {
    return null
  }

  const level = items.reduce<AnnouncementLevel>(
    (highest, item) =>
      LEVEL_RANK[item.level] > LEVEL_RANK[highest] ? item.level : highest,
    'info'
  )

  return (
    <div
      role="region"
      aria-label={t('notifications.announcements.barLabel', '通知栏')}
      // 顶栏里的一行文字：没有外框、没有底色，只有级别色的喇叭图标；
      // 宽度有上限但可收缩，不会把顶栏挤变形。
      // 小屏顶栏本来就挤（语言/主题/铃铛都隐藏了），这里一并隐藏。
      // 宽度**跟着可用空间走**：`flex-1`（basis 0 + grow 1）吃掉面包屑之外的剩余宽度，
      // 所以屏幕越宽它越长、挤的时候自动变短；`max-w-*` 只是上限，避免超宽屏拉到离谱，
      // `min-w-0` 让它能被压到很窄而不是把顶栏撑变形。
      className="hidden min-w-0 flex-1 items-center gap-1 text-sm sm:flex sm:max-w-md lg:max-w-xl xl:max-w-2xl"
    >
      <AnnouncementTicker items={items} level={level} />
      {/* 「读全」的最后一道保险：展开成可换行的全文，不受顶栏单行与滚动速度限制，
          键盘与读屏器也能直接用（拖动那套只对鼠标友好）。 */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t('notifications.announcements.expand', '展开全文')}
            title={t('notifications.announcements.expand', '展开全文')}
            className="flex shrink-0 items-center justify-center rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            <IconChevronDown className="size-4" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="max-h-80 w-80 overflow-y-auto">
          <p className="mb-2 text-sm font-medium">
            {t('notifications.announcements.barLabel', '通知栏')}
          </p>
          <div className="space-y-3">
            {items.map((item) => (
              <div key={item.id} className="flex items-start gap-2">
                <IconSpeakerphone
                  className={`mt-0.5 size-4 shrink-0 ${ANNOUNCEMENT_LEVEL_ICONS[item.level]}`}
                />
                <div className="min-w-0 space-y-0.5">
                  {item.title.trim() === '' ? null : (
                    <p className="text-sm font-semibold break-words">
                      {item.title}
                    </p>
                  )}
                  {/* 这里不加 nowrap：弹层里就是要换行完整显示。 */}
                  <div className="text-sm text-muted-foreground">
                    <AnnouncementContent content={item.content} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
