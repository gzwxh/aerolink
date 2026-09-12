import { useEffect, useMemo, useState } from 'react'
import {
  IconPencil,
  IconPlus,
  IconShieldCheck,
  IconUser,
  IconUsers,
} from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { Role } from '@/types/api'
import { fetchClusterNamespaces, useClusterList, useRoleList } from '@/lib/api'
import { splitResourcesByScope } from '@/lib/resource-catalog'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { NamespacePermissionDialog } from '@/components/namespace-permission-dialog'

import { RBACRoleDetail } from './rbac-role-detail'

interface NamespaceGrantsViewProps {
  initialCluster?: string
  initialNamespace?: string
}

interface GrantRow {
  key: string
  roleId: number
  roleName: string
  isSystem: boolean
  subjectType: 'user' | 'group' | null
  subject: string | null
  resources: string[]
  verbs: string[]
  hasClusterScoped: boolean
  allClusters: boolean
}

function GrantTable({
  rows,
  cluster,
  showClusterScopedBadge = false,
  onEditRole,
}: {
  rows: GrantRow[]
  cluster: string | null
  showClusterScopedBadge?: boolean
  /** When provided, every row gets an action to edit the underlying role. */
  onEditRole?: (roleId: number) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="overflow-hidden rounded-md border">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_minmax(0,1fr)_auto_auto] items-center gap-3 border-b bg-muted/40 px-3 py-2 text-xs font-semibold text-muted-foreground">
        <span>{t('common.fields.name', 'Name')}</span>
        <span>{t('common.fields.subjectType', 'Subject Type')}</span>
        <span>{t('common.fields.role', 'Role')}</span>
        <span>
          {t('common.fields.resources', 'Resources')} /{' '}
          {t('common.fields.verbs', 'Verbs')}
        </span>
        <span>{t('common.fields.clusters', 'Clusters')}</span>
        <span />
      </div>
      {rows.map((grant) => (
        <div
          key={grant.key}
          className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_minmax(0,1fr)_auto_auto] items-center gap-3 border-b px-3 py-2 text-sm last:border-b-0"
        >
          <div className="flex min-w-0 items-center gap-2">
            {grant.subjectType === 'group' ? (
              <IconUsers className="h-4 w-4 shrink-0 text-muted-foreground" />
            ) : (
              <IconUser className="h-4 w-4 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate" title={grant.subject ?? undefined}>
              {grant.subject ||
                t('namespaceGrants.unassigned', 'No subject assigned')}
            </span>
          </div>
          <span className="text-xs text-muted-foreground">
            {grant.subjectType
              ? grant.subjectType === 'user'
                ? t('common.fields.user', 'User')
                : t('common.fields.oidcGroup', 'LDAP / OIDC Group')
              : '-'}
          </span>
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate" title={grant.roleName}>
              {grant.roleName}
            </span>
            {grant.isSystem && (
              <Badge variant="secondary" className="shrink-0 text-xs">
                System
              </Badge>
            )}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="truncate">
              {grant.resources.includes('*')
                ? '*'
                : grant.resources.join(', ') || '-'}{' '}
              /{' '}
              {grant.verbs.includes('*') ? '*' : grant.verbs.join(', ') || '-'}
            </span>
            {showClusterScopedBadge && grant.hasClusterScoped && (
              <Badge variant="outline" className="shrink-0 text-[10px]">
                {t(
                  'namespaceGrants.includesClusterScoped',
                  'incl. cluster-scoped'
                )}
              </Badge>
            )}
          </span>
          <Badge variant="outline" className="text-xs">
            {grant.allClusters
              ? t('common.values.all', 'All')
              : (cluster ?? '-')}
          </Badge>
          {onEditRole ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-primary"
              title={t('namespaceGrants.editRole', 'Edit')}
              aria-label={t('namespaceGrants.editRole', 'Edit')}
              onClick={() => onEditRole(grant.roleId)}
            >
              <IconPencil className="h-3.5 w-3.5" />
              {t('namespaceGrants.editRole', 'Edit')}
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  )
}

/**
 * Shows every role grant that covers a given namespace, resolved against the
 * selected cluster. Deep-linked from the namespace pages via
 * /rbac?cluster=X&namespace=Y and also reachable from the tabs.
 */
export function NamespaceGrantsView({
  initialCluster,
  initialNamespace,
}: NamespaceGrantsViewProps) {
  const { t } = useTranslation()
  const { data: roles = [], isLoading, error } = useRoleList()
  const { data: clusterList = [] } = useClusterList()

  const allClusterNames = useMemo(
    () =>
      (clusterList || [])
        .map((c) => c.name)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b)),
    [clusterList]
  )

  const [cluster, setCluster] = useState<string | null>(initialCluster ?? null)
  const [namespace, setNamespace] = useState(initialNamespace ?? '')
  // Granting reuses the same dialog the namespace list exposes: it shows the
  // existing grants for the namespace and can add or revoke them.
  const [showPermissionDialog, setShowPermissionDialog] = useState(false)
  // Role currently opened in the inline editor (one per grant row).
  const [editingRole, setEditingRole] = useState<Role | null>(null)

  useEffect(() => {
    if (allClusterNames.length === 0) return
    if (!cluster || !allClusterNames.includes(cluster)) {
      setCluster(initialCluster ?? allClusterNames[0])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allClusterNames.join(',')])

  const { data: clusterNamespaces = [], isLoading: nsLoading } = useQuery({
    queryKey: ['rbac-cluster-namespaces', cluster],
    queryFn: () => fetchClusterNamespaces(cluster!),
    enabled: !!cluster,
    staleTime: 60_000,
  })

  // Switching the cluster changes which namespaces exist, so a namespace picked
  // for the previous cluster is dropped once the new list has loaded; the first
  // namespace of the new cluster is selected instead so the page stays useful.
  useEffect(() => {
    if (!cluster || nsLoading) return
    if (namespace && clusterNamespaces.includes(namespace)) return
    setNamespace(clusterNamespaces[0] ?? '')
  }, [cluster, clusterNamespaces, nsLoading, namespace])

  const namespaceOptions = useMemo(() => {
    const set = new Set(clusterNamespaces)
    // Keep a deep-linked namespace visible until its cluster list has loaded;
    // afterwards only namespaces that really exist stay in the list.
    if (namespace && (nsLoading || clusterNamespaces.includes(namespace))) {
      set.add(namespace)
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [clusterNamespaces, namespace, nsLoading])

  const handleEditRole = (roleId: number) => {
    const role = roles.find((r) => r.id === roleId)
    if (role) setEditingRole(role)
  }

  const { namespaceGrants, clusterScopedGrants } = useMemo(() => {
    const nsRows: GrantRow[] = []
    const csRows: GrantRow[] = []
    if (!namespace || !cluster) {
      return { namespaceGrants: nsRows, clusterScopedGrants: csRows }
    }
    for (const role of roles) {
      const clusterMatch =
        role.clusters.includes('*') || role.clusters.includes(cluster)
      const nsMatch =
        role.namespaces.includes('*') || role.namespaces.includes(namespace)
      if (!clusterMatch || !nsMatch) continue

      const split = splitResourcesByScope(role.resources || [])
      // Only namespaced resources make a role relevant to this namespace. A role
      // granting only cluster-scoped resources (e.g. nodes) is reported apart,
      // because its namespace list does not constrain those resources.
      const hasNamespacedAccess =
        split.hasWildcard || split.namespaced.length > 0
      const base = {
        roleId: role.id,
        roleName: role.name,
        isSystem: !!role.isSystem,
        verbs: role.verbs || [],
        allClusters: role.clusters.includes('*'),
        hasClusterScoped: split.hasWildcard || split.clusterScoped.length > 0,
        resources: hasNamespacedAccess
          ? split.hasWildcard
            ? ['*']
            : split.namespaced
          : split.clusterScoped,
      }
      const target = hasNamespacedAccess ? nsRows : csRows
      const assignments = role.assignments || []
      if (assignments.length === 0) {
        target.push({
          key: `${role.id}-unassigned`,
          ...base,
          subjectType: null,
          subject: null,
        })
      } else {
        for (const a of assignments) {
          target.push({
            key: `${role.id}-${a.id}`,
            ...base,
            subjectType: a.subjectType,
            subject: a.subject,
          })
        }
      }
    }
    return { namespaceGrants: nsRows, clusterScopedGrants: csRows }
  }, [roles, cluster, namespace])

  if (error) {
    return (
      <div className="flex items-center justify-center py-8 text-destructive">
        {t('common.messages.failedToLoad', {
          resource: t('common.fields.roles', 'roles'),
          defaultValue: 'Failed to load roles',
        })}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-col gap-4 py-4 sm:flex-row">
          <div className="min-w-0 flex-1 space-y-2">
            <div className="text-xs font-semibold text-muted-foreground">
              {t('userGrants.clustersTitle', 'Granted Clusters')}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {allClusterNames.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCluster(c)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-sm transition-colors',
                    cluster === c
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'hover:bg-accent'
                  )}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
          <div className="w-full space-y-2 sm:w-72">
            <div className="text-xs font-semibold text-muted-foreground">
              {t('namespaceGrants.namespaceLabel', 'Namespace')}
            </div>
            <Select
              value={namespace}
              onValueChange={setNamespace}
              disabled={nsLoading || namespaceOptions.length === 0}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={
                    nsLoading
                      ? t('common.messages.loading', 'Loading...')
                      : t('common.placeholders.select', 'Select...')
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {namespaceOptions.map((ns) => (
                  <SelectItem key={ns} value={ns}>
                    {ns}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <IconShieldCheck className="h-4 w-4" />
              {t('namespaceGrants.title', {
                namespace,
                defaultValue: 'Grants for {{namespace}}',
              })}
            </CardTitle>
            {namespace && cluster ? (
              <Button size="sm" onClick={() => setShowPermissionDialog(true)}>
                <IconPlus className="h-4 w-4" />
                {t('namespaceGrants.grantAccess', 'Grant access')}
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              {t('common.messages.loading', 'Loading...')}
            </div>
          ) : !namespace ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              {t(
                'namespaceGrants.selectNamespaceHint',
                'Select a cluster and namespace to view its grants.'
              )}
            </div>
          ) : namespaceGrants.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              {clusterScopedGrants.length > 0
                ? t(
                    'namespaceGrants.noNamespacedGrants',
                    'No namespaced role grants cover this namespace.'
                  )
                : t(
                    'namespaceGrants.noGrants',
                    'No role grants cover this namespace.'
                  )}
            </div>
          ) : (
            <GrantTable
              rows={namespaceGrants}
              cluster={cluster}
              showClusterScopedBadge
              onEditRole={handleEditRole}
            />
          )}
        </CardContent>
      </Card>

      {!isLoading && namespace && clusterScopedGrants.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <IconShieldCheck className="h-4 w-4" />
              {t('namespaceGrants.clusterScopedTitle', 'Cluster-scoped grants')}
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              {t(
                'namespaceGrants.clusterScopedHint',
                'These roles grant cluster-scoped resources (nodes, persistent volumes, storage classes, ...) and are not limited by the selected namespace.'
              )}
            </p>
          </CardHeader>
          <CardContent>
            <GrantTable
              rows={clusterScopedGrants}
              cluster={cluster}
              onEditRole={handleEditRole}
            />
          </CardContent>
        </Card>
      )}

      {showPermissionDialog && namespace && cluster ? (
        <NamespacePermissionDialog
          name={namespace}
          cluster={cluster}
          onClose={() => setShowPermissionDialog(false)}
        />
      ) : null}

      {editingRole ? (
        <Dialog open onOpenChange={(open) => !open && setEditingRole(null)}>
          <DialogContent className="flex max-h-[90dvh] flex-col overflow-hidden sm:max-w-4xl">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <IconShieldCheck className="h-5 w-5" />
                {t('namespaceGrants.editRoleTitle', {
                  name: editingRole.name,
                  defaultValue: 'Edit role - {{name}}',
                })}
              </DialogTitle>
              <DialogDescription>
                {t(
                  'namespaceGrants.editRoleHint',
                  'Changes apply to every namespace and subject this role covers.'
                )}
              </DialogDescription>
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              <RBACRoleDetail
                key={editingRole.id}
                role={editingRole}
                initialCluster={cluster ?? undefined}
                initialNamespace={namespace}
                onSaved={() => setEditingRole(null)}
                onDeleted={() => setEditingRole(null)}
              />
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  )
}

export default NamespaceGrantsView
