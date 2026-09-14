import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { IconPlus, IconShieldCheck } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'

import { Role } from '@/types/api'
import { useRoleList } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

import { RBACRoleDetail, type PermissionPreset } from './rbac-role-detail'

export function RBACManagement({
  resourceFilter,
  defaultResources,
  lockedResources,
  hideNamespacePanel,
  permissionHint,
  permissionPresets,
  permissionPanelTitle,
  namePrefix,
  startInViewMode,
}: {
  /** When set, only roles granting this resource are listed. */
  resourceFilter?: string
  /** Resources preselected when creating a new role. */
  defaultResources?: string[]
  /** Resources fixed (picker hidden) in the role editor. */
  lockedResources?: string[]
  /** Hide the namespace picker in the role editor. */
  hideNamespacePanel?: boolean
  /** Hint rendered with the locked resource list. */
  permissionHint?: ReactNode
  /** Action-oriented permission items replacing the raw verb list. */
  permissionPresets?: PermissionPreset[]
  /** Title for the permissions panel when presets are used. */
  permissionPanelTitle?: string
  /** Prefix enforced on role names, e.g. "node-" for the node permission tab. */
  namePrefix?: string
  /** Open existing roles read-only; the edit form is revealed by the Edit button. */
  startInViewMode?: boolean
} = {}) {
  const { t } = useTranslation()
  const { data: roles = [], isLoading, error } = useRoleList()

  // Deep-link support: /settings/rbac?cluster=X&namespace=Y preselects the
  // cluster and filters the namespace list (used by the namespace list
  // "Permissions" action).
  const [searchParams] = useSearchParams()
  const initialCluster = searchParams.get('cluster') || undefined
  const initialNamespace = searchParams.get('namespace') || undefined

  // Selected entry: role id as string, or 'new' for the create form.
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [pendingRole, setPendingRole] = useState<Role | null>(null)

  const visibleRoles = useMemo(
    () =>
      resourceFilter
        ? roles.filter((role) =>
            (role.resources || []).includes(resourceFilter)
          )
        : roles,
    [resourceFilter, roles]
  )

  // Auto-select the first role once the list is loaded.
  useEffect(() => {
    if (selectedKey === null && visibleRoles.length > 0) {
      setSelectedKey(String(visibleRoles[0].id))
    }
  }, [visibleRoles, selectedKey])

  // Remembers the role that was open before entering the create form, so
  // cancelling can restore it.
  const lastRoleKeyRef = useRef<string | null>(null)

  const selectRole = (key: string) => {
    if (key !== 'new') lastRoleKeyRef.current = key
    setSelectedKey(key)
    setPendingRole(null)
  }

  const handleCancelForm = () => {
    setPendingRole(null)
    setSelectedKey(
      lastRoleKeyRef.current ??
        (visibleRoles.length > 0 ? String(visibleRoles[0].id) : null)
    )
  }

  const selectedRole = useMemo(
    () =>
      selectedKey && selectedKey !== 'new'
        ? (visibleRoles.find((r) => String(r.id) === selectedKey) ?? null)
        : null,
    [visibleRoles, selectedKey]
  )

  // While the role list refetches after create, fall back to the saved role
  // so the detail pane does not flash an empty state.
  const detailRole =
    selectedRole ??
    (pendingRole && selectedKey === String(pendingRole.id) ? pendingRole : null)

  const handleSaved = (saved: Role) => {
    setPendingRole(saved)
    setSelectedKey(String(saved.id))
  }

  const handleDeleted = () => {
    lastRoleKeyRef.current = null
    setPendingRole(null)
    setSelectedKey(null)
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-muted-foreground">
          {t('common.messages.loading', 'Loading...')}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-destructive">
          {t('common.messages.failedToLoad', {
            resource: t('common.fields.roles', 'roles'),
            defaultValue: 'Failed to load roles',
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      <Card className="shrink-0 lg:w-64">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <IconShieldCheck className="h-4 w-4" />
            {t('rbac.rolesTitle', 'Roles')}
            <Badge variant="secondary" className="ml-auto">
              {visibleRoles.length}
            </Badge>
          </CardTitle>
          <Button
            onClick={() => selectRole('new')}
            variant={selectedKey === 'new' ? 'default' : 'outline'}
            className="w-full gap-2"
          >
            <IconPlus className="h-4 w-4" />
            {t('rbac.addRole', 'Add Role')}
          </Button>
        </CardHeader>
        <CardContent className="p-2 pt-0">
          <nav className="space-y-1" data-testid="rbac-role-list">
            {visibleRoles.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => selectRole(String(r.id))}
                className={cn(
                  'w-full rounded-md px-3 py-2 text-left transition-colors hover:bg-accent',
                  selectedKey === String(r.id) && 'bg-accent'
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-medium" title={r.name}>
                    {r.name}
                  </span>
                  {r.isSystem ? (
                    <Badge variant="secondary" className="shrink-0">
                      System
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="shrink-0 text-xs">
                      {r.roleType === 'group'
                        ? t('rbac.roleTypeGroup', 'Group Role')
                        : t('rbac.roleTypeUser', 'User Role')}
                    </Badge>
                  )}
                </div>
                {r.description && (
                  <div
                    className="truncate text-xs text-muted-foreground"
                    title={r.description}
                  >
                    {r.description}
                  </div>
                )}
              </button>
            ))}
            {visibleRoles.length === 0 && (
              <div className="px-3 py-4 text-sm text-muted-foreground">
                {t('common.messages.noItemsConfigured', {
                  resource: t('common.fields.roles', 'roles'),
                  defaultValue: 'No roles configured',
                })}
              </div>
            )}
          </nav>
        </CardContent>
      </Card>

      <div className="min-w-0 flex-1">
        {selectedKey === 'new' || detailRole ? (
          <RBACRoleDetail
            key={detailRole ? detailRole.id : 'new'}
            role={detailRole}
            onSaved={handleSaved}
            onDeleted={handleDeleted}
            initialCluster={initialCluster}
            initialNamespace={initialNamespace}
            defaultResources={defaultResources}
            lockedResources={lockedResources}
            hideNamespacePanel={hideNamespacePanel}
            permissionHint={permissionHint}
            permissionPresets={permissionPresets}
            permissionPanelTitle={permissionPanelTitle}
            namePrefix={namePrefix}
            startInViewMode={startInViewMode}
            onCancelForm={handleCancelForm}
          />
        ) : (
          <div className="flex items-center justify-center rounded-md border border-dashed py-16 text-muted-foreground">
            {t(
              'rbac.selectRoleHint',
              'Select a role from the list on the left, or create a new role.'
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default RBACManagement
