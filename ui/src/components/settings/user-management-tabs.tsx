import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent } from '@/components/ui/tabs'

import { UserGroupsTab } from './user-groups-tab'
import { UserManagement } from './user-management'

/**
 * 用户管理容器：/settings/user?tab=users | ?tab=group
 * 子导航在左侧侧边栏的「用户管理」下，内容区只渲染当前页签。
 */
export function UserManagementTabs() {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const tab = searchParams.get('tab') === 'group' ? 'group' : 'users'

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {t('settings.tabs.user', 'User Management')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs
          value={tab}
          onValueChange={(value) => setSearchParams({ tab: value })}
          className="space-y-4"
        >
          <TabsContent value="users">
            <UserManagement />
          </TabsContent>
          <TabsContent value="group">
            <UserGroupsTab />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}
