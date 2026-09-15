import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'

import {
  NODE_RESOURCE,
  NODE_ROLE_NAME_PREFIX,
  nodePermissionPresets,
} from '@/lib/node-permissions'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent } from '@/components/ui/tabs'
import { RequireAdmin } from '@/components/require-admin'

import { GroupGrantsView } from './group-grants-view'
import { NamespaceGrantsView } from './namespace-grants-view'
import { RBACManagement } from './rbac-management'
import { UserGrantsView } from './user-grants-view'

type RbacTab = 'roles' | 'user' | 'group' | 'namespace' | 'node'

// RBAC is a section of System Settings now, so its tabs need their own query
// param instead of sharing the settings section param (`tab`).
const RBAC_TAB_PARAM = 'rbacTab'

export function RBACView() {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()

  const tabParam = searchParams.get(RBAC_TAB_PARAM)
  const hasNamespace = !!searchParams.get('namespace')
  // A cluster/namespace deep link without an explicit tab lands on the
  // per-namespace grants view.
  const tab: RbacTab =
    tabParam === 'user'
      ? 'user'
      : tabParam === 'group'
        ? 'group'
        : tabParam === 'node'
          ? 'node'
          : tabParam === 'namespace' || (!tabParam && hasNamespace)
            ? 'namespace'
            : 'roles'
  const subject = searchParams.get('subject') || undefined

  const handleTabChange = (next: string) => {
    const nextParams = new URLSearchParams(searchParams)
    if (next === 'roles') {
      nextParams.delete(RBAC_TAB_PARAM)
    } else {
      nextParams.set(RBAC_TAB_PARAM, next)
    }
    nextParams.delete('subject')
    setSearchParams(nextParams)
  }

  const openGroup = (group: string) => {
    const nextParams = new URLSearchParams(searchParams)
    nextParams.set(RBAC_TAB_PARAM, 'group')
    nextParams.set('subject', group)
    setSearchParams(nextParams)
  }

  return (
    <RequireAdmin>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {t('rbac.title', 'RBAC 管理')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs
            value={tab}
            onValueChange={handleTabChange}
            className="flex flex-row gap-4 space-y-0 [&>[role=tabpanel]]:min-w-0 [&>[role=tabpanel]]:flex-1"
          >
            <TabsContent value="roles">
              <RBACManagement />
            </TabsContent>
            <TabsContent value="user">
              <UserGrantsView
                key={subject || 'all'}
                initialSubject={subject}
                onOpenGroup={openGroup}
              />
            </TabsContent>
            <TabsContent value="group">
              <GroupGrantsView
                key={subject || 'all'}
                initialSubject={subject}
              />
            </TabsContent>
            <TabsContent value="namespace">
              <NamespaceGrantsView
                key={`${searchParams.get('cluster') || 'all'}-${searchParams.get('namespace') || 'all'}`}
                initialCluster={searchParams.get('cluster') || undefined}
                initialNamespace={searchParams.get('namespace') || undefined}
              />
            </TabsContent>
            <TabsContent value="node">
              <RBACManagement
                resourceFilter={NODE_RESOURCE}
                defaultResources={[NODE_RESOURCE]}
                lockedResources={[NODE_RESOURCE]}
                hideNamespacePanel
                namePrefix={NODE_ROLE_NAME_PREFIX}
                startInViewMode
                permissionPanelTitle={t(
                  'rbac.nodePermissions.panelTitle',
                  'Node permissions'
                )}
                permissionHint={t(
                  'rbac.nodePermissionHint',
                  'Buttons on the node pages are shown only when the matching permission is granted.'
                )}
                permissionPresets={nodePermissionPresets(t)}
              />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </RequireAdmin>
  )
}
