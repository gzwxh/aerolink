import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  IconLoader2,
  IconShieldCheck,
  IconUser,
  IconUsers,
  IconX,
} from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

import { Role, UserItem } from '@/types/api'
import {
  assignRole,
  createRole,
  fetchKnownGroups,
  fetchUserList,
  unassignRole,
  updateRole,
  useRoleList,
} from '@/lib/api'
import { translateError } from '@/lib/utils'
import { resourceCatalog } from '@/lib/resource-catalog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { MultiSelect } from '@/components/multi-select'

interface NamespacePermissionDialogProps {
  name: string
  /** Current cluster, added to the role's cluster scope when missing. */
  cluster?: string
  onClose: () => void
}

const USER_PAGE_SIZE = 500

const VERB_SUGGESTIONS = [
  '*',
  'get',
  'create',
  'update',
  'delete',
  'log',
  'exec',
]

const RESOURCE_SUGGESTIONS = [
  '*',
  ...resourceCatalog
    .filter((resource) => resource.type !== 'crs')
    .map((resource) => resource.type),
]

export function NamespacePermissionDialog({
  name,
  cluster,
  onClose,
}: NamespacePermissionDialogProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: roles = [], isLoading } = useRoleList()

  const [subjectType, setSubjectType] = useState<'user' | 'group'>('user')
  const [subjects, setSubjects] = useState<string[]>([])
  const [isSaving, setIsSaving] = useState(false)
  const [isRevoking, setIsRevoking] = useState(false)
  const [resources, setResources] = useState<string[]>(['*'])
  const [verbs, setVerbs] = useState<string[]>(['*'])
  // 'auto' creates/reuses a subject-named role; otherwise a picked role id.
  const [roleId, setRoleId] = useState<string>('auto')

  // Roles matching the selected subject type (system roles excluded).
  const selectableRoles = useMemo(
    () =>
      roles.filter(
        (r) =>
          !r.isSystem &&
          (subjectType === 'group'
            ? r.roleType === 'group'
            : r.roleType !== 'group')
      ),
    [roles, subjectType]
  )

  const [userOptions, setUserOptions] = useState<UserItem[]>([])
  const [groupOptions, setGroupOptions] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const collected: UserItem[] = []
        for (let page = 1; ; page++) {
          const res = await fetchUserList(page, USER_PAGE_SIZE, '')
          collected.push(...(res.users || []))
          if (collected.length >= res.total || (res.users || []).length === 0) {
            break
          }
        }
        if (!cancelled) setUserOptions(collected)
      } catch {
        if (!cancelled) setUserOptions([])
      }
      try {
        const groups = await fetchKnownGroups()
        if (!cancelled) setGroupOptions(groups)
      } catch {
        if (!cancelled) setGroupOptions([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Grants that currently reference this namespace.
  const currentGrants = useMemo(() => {
    const rows: Array<{
      key: string
      roleId: number
      roleName: string
      isSystem: boolean
      subjectType: 'user' | 'group'
      subject: string
    }> = []
    for (const role of roles) {
      if (!role.namespaces?.includes(name)) continue
      for (const assignment of role.assignments || []) {
        rows.push({
          key: `${role.id}-${assignment.id}`,
          roleId: role.id,
          roleName: role.name,
          isSystem: !!role.isSystem,
          subjectType: assignment.subjectType,
          subject: assignment.subject,
        })
      }
    }
    return rows
  }, [roles, name])

  const subjectOptions = useMemo(() => {
    const base =
      subjectType === 'user'
        ? userOptions.map((u) => u.username)
        : groupOptions
    return base.sort((a, b) => a.localeCompare(b))
  }, [subjectType, userOptions, groupOptions])

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['role-list'] }),
    [queryClient]
  )

  const handleGrant = async () => {
    if (subjects.length === 0) return

    setIsSaving(true)
    try {
      // 'auto' creates/reuses a role named after the subject itself (typed to
      // the subject kind); otherwise the picked role of the matching type is
      // reused and scoped to this namespace.
      const useAutoRole = roleId === 'auto'

      for (const subject of subjects) {
        let role: Role | undefined
        let roleIdForAssignment: number

        if (useAutoRole) {
          const roleName = subject
          const existing = roles.find((r) => r.name === roleName)
          if (existing?.isSystem) {
            throw new Error(
              t('nsPerm.systemRoleConflict', 'System roles cannot be modified.')
            )
          }

          if (!existing) {
            const resp = await createRole({
              name: roleName,
              description: t('nsPerm.autoRoleDescription', {
                namespace: name,
                defaultValue: 'Namespace grant for {{namespace}}',
              }),
              roleType: subjectType,
              clusters: cluster ? [cluster] : ['*'],
              namespaces: [name],
              resources,
              verbs,
            })
            roleIdForAssignment = resp.role.id
          } else {
            const namespaces = existing.namespaces.includes(name)
              ? existing.namespaces
              : [...existing.namespaces, name]
            const clusters =
              existing.clusters.includes('*') ||
              !cluster ||
              existing.clusters.includes(cluster)
                ? existing.clusters
                : [...existing.clusters, cluster]

            if (
              namespaces !== existing.namespaces ||
              clusters !== existing.clusters ||
              resources.join(',') !== existing.resources.join(',') ||
              verbs.join(',') !== existing.verbs.join(',')
            ) {
              await updateRole(existing.id, {
                name: existing.name,
                description: existing.description,
                roleType: existing.roleType,
                clusters,
                namespaces,
                resources,
                verbs,
              })
            }
            roleIdForAssignment = existing.id
          }
        } else {
          role = roles.find((r) => String(r.id) === roleId)
          if (!role) {
            throw new Error(t('nsPerm.roleNotFound', 'Role not found.'))
          }
          if (role.isSystem) {
            throw new Error(
              t('nsPerm.systemRoleConflict', 'System roles cannot be modified.')
            )
          }

          const namespaces = role.namespaces.includes(name)
            ? role.namespaces
            : [...role.namespaces, name]
          const clusters =
            role.clusters.includes('*') ||
            !cluster ||
            role.clusters.includes(cluster)
              ? role.clusters
              : [...role.clusters, cluster]

          if (
            namespaces !== role.namespaces ||
            clusters !== role.clusters ||
            resources.join(',') !== role.resources.join(',') ||
            verbs.join(',') !== role.verbs.join(',')
          ) {
            await updateRole(role.id, {
              name: role.name,
              description: role.description,
              roleType: role.roleType,
              clusters,
              namespaces,
              resources,
              verbs,
            })
          }
          roleIdForAssignment = role.id
        }

        await assignRole(roleIdForAssignment, { subjectType, subject })
      }

      await invalidate()
      toast.success(
        t('nsPerm.grantSaved', {
          count: subjects.length,
          defaultValue: 'Granted {{count}} subject(s)',
        })
      )
      setSubjects([])
      onClose()
    } catch (err) {
      toast.error(translateError(err, t))
    } finally {
      setIsSaving(false)
    }
  }

  const handleViewInRbac = () => {
    // Warn when the current selection has not been saved yet.
    if (
      subjects.length > 0 &&
      !window.confirm(
        t(
          'nsPerm.unsavedConfirm',
          'The current selection has not been saved yet. Leave anyway?'
        )
      )
    ) {
      return
    }

    const params = new URLSearchParams()
    if (cluster) params.set('cluster', cluster)
    params.set('namespace', name)
    // Deep-link to the subject being configured.
    const subject = subjects[0]
    if (subject) {
      params.set('tab', subjectType === 'user' ? 'user' : 'group')
      params.set('subject', subject)
    }
    navigate(`/rbac?${params.toString()}`)
  }

  const handleRevoke = async (
    revRoleId: number,
    revSubjectType: 'user' | 'group',
    subject: string
  ) => {
    setIsRevoking(true)
    try {
      await unassignRole(revRoleId, revSubjectType, subject)
      await invalidate()
      toast.success(t('common.messages.unassigned', 'Unassigned'))
    } catch (err) {
      toast.error(translateError(err, t))
    } finally {
      setIsRevoking(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IconShieldCheck className="h-5 w-5" />
            {t('nsPerm.title', {
              name,
              defaultValue: 'Namespace permissions - {{name}}',
            })}
          </DialogTitle>
          <DialogDescription>
            {t(
              'nsPerm.description',
              'Grant roles to users or groups for this namespace. Group members inherit the group grants automatically.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
          <div className="space-y-2">
            <Label>{t('nsPerm.currentGrants', 'Current grants')}</Label>
            {isLoading ? (
              <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
                <IconLoader2 className="h-4 w-4 animate-spin" />
                {t('common.messages.loading', 'Loading...')}
              </div>
            ) : currentGrants.length === 0 ? (
              <p className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
                {t('nsPerm.noGrants', 'No grants for this namespace yet.')}
              </p>
            ) : (
              <div className="max-h-48 overflow-y-auto rounded-md border">
                {currentGrants.map((grant) => (
                  <div
                    key={grant.key}
                    className="flex items-center justify-between gap-2 border-b px-3 py-1.5 text-sm last:border-b-0"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      {grant.subjectType === 'user' ? (
                        <IconUser className="h-4 w-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <IconUsers className="h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate" title={grant.subject}>
                        {grant.subject}
                      </span>
                      <Badge variant="secondary" className="shrink-0 text-xs">
                        {grant.roleName}
                      </Badge>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground hover:text-destructive"
                      disabled={isRevoking}
                      aria-label={`${t('common.actions.remove', 'Remove')} ${grant.subject}`}
                      onClick={() =>
                        void handleRevoke(
                          grant.roleId,
                          grant.subjectType,
                          grant.subject
                        )
                      }
                    >
                      <IconX className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              void handleGrant()
            }}
          >
            <div className="font-medium">
              {t('nsPerm.addGrant', 'Add grant')}
            </div>

            <div className="space-y-2">
              <Label>{t('common.fields.subjectType', 'Subject Type')}</Label>
              <Select
                value={subjectType}
                onValueChange={(v) => {
                  setSubjectType(v as 'user' | 'group')
                  setSubjects([])
                  setRoleId('auto')
                }}
                disabled={isSaving}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">
                    {t('common.fields.user', 'User')}
                  </SelectItem>
                  <SelectItem value="group">
                    {t('common.fields.oidcGroup', 'LDAP / OIDC Group')}
                  </SelectItem>
                </SelectContent>
              </Select>
              <div className="space-y-2">
                <Label>{t('common.fields.role', 'Role')}</Label>
                <Select
                  value={roleId}
                  onValueChange={setRoleId}
                  disabled={isSaving}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">
                      {t('nsPerm.autoRoleOption', {
                        defaultValue: 'Auto (named after subject)',
                      })}
                    </SelectItem>
                    {selectableRoles.map((role) => (
                      <SelectItem key={role.id} value={String(role.id)}>
                        {role.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {roleId === 'auto' ? (
                  <p className="text-xs text-muted-foreground">
                    {t(
                      'nsPerm.autoRoleHint',
                      'A role named after the selected user/group will be used or created automatically.'
                    )}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t(
                      'nsPerm.existingRoleHint',
                      'The namespace and selected resources/verbs will be applied to this role.'
                    )}
                  </p>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <Label>
                {subjectType === 'user'
                  ? t('common.fields.users', 'Users')
                  : t('common.fields.oidcGroups', 'LDAP / OIDC Groups')}
              </Label>
              <MultiSelect
                key={subjectType}
                value={subjects}
                onChange={setSubjects}
                options={subjectOptions}
                selectAllMode="all"
                allowAdd={false}
                disabled={isSaving}
                placeholder={
                  subjectType === 'user'
                    ? t('common.placeholders.selectUsers', 'Select users...')
                    : t('common.placeholders.selectGroups', 'Select groups...')
                }
                emptyText={t('common.messages.noOptionsFound', 'No options found')}
              />
              {subjectType === 'group' && (
                <p className="text-xs text-muted-foreground">
                  {t(
                    'nsPerm.groupInheritHint',
                    'Users in the group inherit this grant automatically.'
                  )}
                </p>
              )}
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <MultiSelect
                label={t('common.fields.resources', 'Resources')}
                value={resources}
                onChange={setResources}
                options={RESOURCE_SUGGESTIONS}
                placeholder={t(
                  'common.placeholders.resources',
                  'Select resources...'
                )}
                disabled={isSaving}
              />
              <MultiSelect
                label={t('common.fields.verbs', 'Verbs')}
                value={verbs}
                onChange={setVerbs}
                options={VERB_SUGGESTIONS}
                placeholder={t('common.placeholders.verbs', 'Select verbs...')}
                allowAdd={false}
                disabled={isSaving}
              />
            </div>
          </form>
        </div>

        <DialogFooter className="items-center justify-between gap-2 sm:justify-between">
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
            onClick={handleViewInRbac}
          >
            {t('nsPerm.viewInRbac', 'Open in RBAC management')}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={isSaving}>
              {t('common.actions.cancel', 'Cancel')}
            </Button>
            <Button
              onClick={() => void handleGrant()}
              disabled={subjects.length === 0 || isSaving}
            >
              {isSaving && <IconLoader2 className="h-4 w-4 animate-spin" />}
              {isSaving
                ? t('common.actions.saving', 'Saving...')
                : t('nsPerm.grant', 'Grant')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
