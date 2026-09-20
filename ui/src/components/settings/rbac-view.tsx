import { useSearchParams } from 'react-router-dom'

import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsContent } from '@/components/ui/tabs'
import { RequireSettingsAccess } from '@/components/require-admin'

import {
  AdministratorManagement,
  AuditorManagement,
  SecurityAdminManagement,
} from './administrator-management'
import {
  BINDING_GROUP_NEW_PARAM,
  BINDING_GROUP_PARAM,
  BindingGroupManagement,
} from './binding-group-management'
import { RBACManagement, ROLE_PARAM } from './rbac-management'
import { RBACPermissionCatalog } from './rbac-permission-catalog'
import { SeparationOfDutiesBanner } from './separation-of-duties-banner'

// 只有「权限绑定」跟随顶栏所选集群（它的作用域就是集群 + 命名空间）；角色、权限、系统管理员、
// 审计管理员与安全管理员都是全局的。
type RbacTab =
  | 'roles'
  | 'privileges'
  | 'binding-groups'
  | 'administrators'
  | 'auditors'
  | 'security-admins'

const RBAC_TABS: readonly RbacTab[] = [
  'roles',
  'privileges',
  'binding-groups',
  'administrators',
  'auditors',
  'security-admins',
]

// RBAC 现在是系统设置下的一个分区，因此它的标签页需要自己的查询
// 参数，而不是共用设置分区参数（`tab`）。
const RBAC_TAB_PARAM = 'rbacTab'

export function RBACView() {
  const [searchParams, setSearchParams] = useSearchParams()

  const tabParam = searchParams.get(RBAC_TAB_PARAM)
  const tab: RbacTab = RBAC_TABS.includes(tabParam as RbacTab)
    ? (tabParam as RbacTab)
    : 'roles'

  const handleTabChange = (next: string) => {
    const nextParams = new URLSearchParams(searchParams)
    // 角色详情（?role=…）与权限绑定的新增/详情（?bindingGroup=… / ?newBindingGroup=1）
    // 都是页签内部的视图：切页签时清掉，避免切回来又停在旧的详情上。
    nextParams.delete(ROLE_PARAM)
    nextParams.delete(BINDING_GROUP_PARAM)
    nextParams.delete(BINDING_GROUP_NEW_PARAM)
    if (next === 'roles') {
      nextParams.delete(RBAC_TAB_PARAM)
    } else {
      nextParams.set(RBAC_TAB_PARAM, next)
    }
    setSearchParams(nextParams)
  }

  return (
    <RequireSettingsAccess section="rbac">
      <Card>
        <CardContent>
          {/* 职责分离冲突提示放在容器上：两个页签都要看得到（解绑动作通常发生在
              权限绑定页，而不是角色页）。 */}
          <div className="mb-4">
            <SeparationOfDutiesBanner />
          </div>
          <Tabs
            value={tab}
            onValueChange={handleTabChange}
            className="flex flex-row gap-4 space-y-0 [&>[role=tabpanel]]:min-w-0 [&>[role=tabpanel]]:flex-1"
          >
            <TabsContent value="roles">
              <RBACManagement />
            </TabsContent>
            <TabsContent value="privileges">
              <RBACPermissionCatalog />
            </TabsContent>
            <TabsContent value="binding-groups">
              <BindingGroupManagement />
            </TabsContent>
            <TabsContent value="administrators">
              <AdministratorManagement />
            </TabsContent>
            <TabsContent value="auditors">
              <AuditorManagement />
            </TabsContent>
            <TabsContent value="security-admins">
              <SecurityAdminManagement />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </RequireSettingsAccess>
  )
}
