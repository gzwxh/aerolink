import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { useAnnouncements } from '@/lib/api'

import { AnnouncementTicker } from './announcement-ticker'

/**
 * 顶栏通知栏：管理员发布的公告在这里滚动输出。
 *
 * - 渲染在顶栏里、集群徽章之前（见 SiteHeader），占一小块区域，**没有外框**：
 *   就是一行滚动文字 + 一个级别色的喇叭图标；
 * - 滚动本身在 AnnouncementTicker 里（管理页的预览复用同一份，避免两处观感走偏）；
 * - 内容太长时：鼠标悬停暂停、按住拖动（横向拖看前后文）；
 * - **不受** `prefers-reduced-motion` 影响：滚不滚只看公告自己的配置（理由见
 *   styles/base.css 里那段说明）——管理员已按条决定过，被客户端偏好静默否决会得到
 *   「勾了横向滚动却没滚、也没人解释为什么」，比不尊重偏好更糟；
 * - 通知栏同一时间只展示一条：后端只返回当前启用的那一条（见
 *   model.ListActiveAnnouncements）。
 *
 * 见 plans/2026-09-21-顶部通知栏.md。
 */

export function AnnouncementBar() {
  const { t } = useTranslation()
  const { data } = useAnnouncements()
  // 用 useMemo 固定引用：直接写 `data?.items ?? []` 会让下面几处依赖每次渲染都变。
  const items = useMemo(() => data?.items ?? [], [data])

  if (items.length === 0) {
    return null
  }

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
      <AnnouncementTicker items={items} level={items[0].level} />
    </div>
  )
}
