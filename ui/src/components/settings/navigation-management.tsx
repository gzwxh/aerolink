import { useSettingsSectionAccess } from '@/contexts/settings-section-context'
import { IconLayoutSidebar } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { SidebarCustomizer } from '@/components/sidebar-customizer'

/**
 * 左侧导航配置：分组、条目、顺序与显隐，以及把当前布局发布为全局导航。
 *
 * 复用 SidebarCustomizer 的内嵌形态，与头像菜单里的对话框共用同一份实现；
 * 发布按钮只看 settings.general 的写权限（全局侧边栏接口的门禁也是它）。
 */
export function NavigationManagement() {
  const { t } = useTranslation()
  const { readOnly } = useSettingsSectionAccess()

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <IconLayoutSidebar className="h-5 w-5" />
          {t('settings.tabs.navigation', '侧边栏导航')}
        </CardTitle>
        <CardDescription>
          {t(
            'settings.descriptions.navigation',
            '配置左侧导航显示哪些分组与条目：可以调整顺序、隐藏条目或新建分组；发布为全局导航后对没有自定义导航的用户生效。'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <SidebarCustomizer inline canPublishGlobal={!readOnly} />
      </CardContent>
    </Card>
  )
}
