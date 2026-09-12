import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'

import {
  NODE_RESOURCE,
  NODE_ROLE_NAME_PREFIX,
  nodePermissionPresets,
} from '@/lib/node-permissions'
import { usePageTitle } from '@/hooks/use-page-title'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { RequireAdmin } from '@/components/require-admin'
import { GroupGrantsView } from '@/components/settings/group-grants-view'
import { NamespaceGrantsView } from '@/components/settings/namespace-grants-view'
import { RBACManagement } from '@/components/settings/rbac-management'
import { UserGrantsView } from '@/components/settings/user-grants-view'

type RbacTab = 'roles' | 'user' | 'group' | 'namespace' | 'node'

export function RBACPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const tabParam = searchParams.get('tab')
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
      nextParams.delete('tab')
    } else {
      nextParams.set('tab', next)
    }
    nextParams.delete('subject')
    setSearchParams(nextParams)
  }

  const openGroup = (group: string) => {
    navigate(`/rbac?tab=group&subject=${encodeURIComponent(group)}`)
  }

  usePageTitle('RBAC')

  return (
    <RequireAdmin>
      <div className="space-y-2">
        <div className="mb-4">
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-3xl">{t('rbac.title', 'RBAC Management')}</h1>
          </div>
          <p className="text-muted-foreground">
            {t('rbac.description', 'Manage roles, permissions and members')}
          </p>
        </div>

        <Tabs value={tab} onValueChange={handleTabChange}>
          <TabsList>
            <TabsTrigger value="roles">
              {t('rbac.rolesViewTab', 'Roles')}
            </TabsTrigger>
            <TabsTrigger value="user">
              {t('rbac.usersViewTab', 'Users')}
            </TabsTrigger>
            <TabsTrigger value="group">
              {t('rbac.groupsViewTab', 'Groups')}
            </TabsTrigger>
            <TabsTrigger value="namespace">
              {t('rbac.namespaceViewTab', 'Namespace Grants')}
            </TabsTrigger>
            <TabsTrigger value="node">
              {t('rbac.nodeViewTab', 'Node Permissions')}
            </TabsTrigger>
          </TabsList>
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
            <GroupGrantsView key={subject || 'all'} initialSubject={subject} />
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
      </div>
    </RequireAdmin>
  )
}

export default RBACPage
