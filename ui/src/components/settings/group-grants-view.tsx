import { useEffect, useMemo, useState } from 'react'
import { IconSearch, IconUser, IconUsers } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import { fetchUserList, useRoleList } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

import { GrantsScopePanel } from './grants-scope-panel'

interface RoleGrant {
  id: number
  name: string
  isSystem: boolean
  clusters: string[]
  namespaces: string[]
  resources: string[]
  verbs: string[]
}

interface GroupEntry {
  subject: string
  roles: RoleGrant[]
}

export function GroupGrantsView({
  initialSubject,
}: {
  initialSubject?: string
}) {
  const { t } = useTranslation()
  const { data: roles = [], isLoading, error } = useRoleList()

  const [search, setSearch] = useState('')
  const [selectedKey, setSelectedKey] = useState<string | null>(
    initialSubject ? `group:${initialSubject}` : null
  )
  const [groupMembers, setGroupMembers] = useState<
    Record<string, Array<{ username: string; name?: string }>>
  >({})

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const collected: Array<{
          username: string
          name?: string
          groups: string[]
        }> = []
        for (let page = 1; ; page++) {
          const res = await fetchUserList(page, 500, '')
          collected.push(
            ...(res.users || []).map((u) => ({
              username: u.username,
              name: u.name,
              groups: u.oidc_groups || [],
            }))
          )
          if (collected.length >= res.total || (res.users || []).length === 0) {
            break
          }
        }
        if (!cancelled) {
          const next: Record<
            string,
            Array<{ username: string; name?: string }>
          > = {}
          for (const u of collected) {
            for (const group of u.groups) {
              next[group] = [
                ...(next[group] || []),
                { username: u.username, name: u.name },
              ]
            }
          }
          setGroupMembers(next)
        }
      } catch {
        // Member info is optional for this view.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const subjects = useMemo<GroupEntry[]>(() => {
    const map = new Map<string, GroupEntry>()
    for (const role of roles) {
      // User-typed roles belong to the users view.
      if (role.roleType === 'user') continue
      for (const assignment of role.assignments || []) {
        if (assignment.subjectType !== 'group') continue
        const key = `group:${assignment.subject}`
        let entry = map.get(key)
        if (!entry) {
          entry = { subject: assignment.subject, roles: [] }
          map.set(key, entry)
        }
        entry.roles.push({
          id: role.id,
          name: role.name,
          isSystem: !!role.isSystem,
          clusters: role.clusters || [],
          namespaces: role.namespaces || [],
          resources: role.resources || [],
          verbs: role.verbs || [],
        })
      }
    }
    return Array.from(map.values()).sort((a, b) =>
      a.subject.localeCompare(b.subject)
    )
  }, [roles])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return subjects
    return subjects.filter((s) => s.subject.toLowerCase().includes(q))
  }, [subjects, search])

  const selected =
    filtered.find((s) => `group:${s.subject}` === selectedKey) ?? filtered[0]

  const members = selected ? groupMembers[selected.subject] || [] : []

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        {t('common.messages.loading', 'Loading...')}
      </div>
    )
  }

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
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      <Card className="shrink-0 lg:w-64">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <IconUsers className="h-4 w-4" />
            {t('userGrants.groupsPageTitle', 'Groups')}
            <Badge variant="secondary" className="ml-auto">
              {subjects.length}
            </Badge>
          </CardTitle>
          <div className="relative">
            <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('common.placeholders.searchItems', 'Search...')}
              className="h-8 pl-8 text-sm"
            />
          </div>
        </CardHeader>
        <CardContent className="p-2 pt-0">
          <nav className="space-y-1">
            {filtered.map((s) => {
              const key = `group:${s.subject}`
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSelectedKey(key)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left transition-colors hover:bg-accent',
                    selected &&
                      `group:${selected.subject}` === key &&
                      'bg-accent'
                  )}
                >
                  <IconUsers className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span
                    className="min-w-0 flex-1 truncate font-medium"
                    title={s.subject}
                  >
                    {s.subject}
                  </span>
                  <Badge variant="secondary" className="shrink-0 text-xs">
                    {s.roles.length}
                  </Badge>
                </button>
              )
            })}
            {filtered.length === 0 && (
              <div className="px-3 py-4 text-sm text-muted-foreground">
                {t('userGrants.noGroups', 'No granted groups.')}
              </div>
            )}
          </nav>
        </CardContent>
      </Card>

      <div className="min-w-0 flex-1 space-y-4">
        {!selected ? (
          <div className="flex items-center justify-center rounded-md border border-dashed py-16 text-muted-foreground">
            {t(
              'userGrants.selectGroupHint',
              'Select a group to view its members and granted clusters and namespaces.'
            )}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <IconUsers className="h-5 w-5 text-muted-foreground" />
              <h2 className="text-xl font-semibold">{selected.subject}</h2>
              <Badge variant="secondary">
                {t('common.fields.oidcGroup', 'LDAP / OIDC Group')}
              </Badge>
              <Badge variant="outline" className="ml-auto">
                {t('userGrants.rolesCount', {
                  count: selected.roles.length,
                  defaultValue: '{{count}} role(s)',
                })}
              </Badge>
            </div>

            <div>
              <div className="mb-2 text-xs font-semibold text-muted-foreground">
                {t('userGrants.membersTitle', 'Members')}
              </div>
              {members.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t(
                    'userGrants.noMembersSeen',
                    'No members found in synced users.'
                  )}
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {members.map((member) => (
                    <Badge
                      key={member.username}
                      variant="outline"
                      title={member.name || member.username}
                    >
                      <IconUser className="mr-1 h-3 w-3" />
                      {member.username}
                      {member.name && (
                        <span className="ml-1 font-normal text-muted-foreground">
                          {member.name}
                        </span>
                      )}
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            {selected.roles.length === 0 ? (
              <div className="rounded-md border border-dashed py-10 text-center text-sm text-muted-foreground">
                {t('userGrants.noGrants', 'This subject has no role grants.')}
              </div>
            ) : (
              selected.roles.map((role) => (
                <Card key={role.id}>
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-base">
                      {role.name}
                      {role.isSystem && (
                        <Badge variant="secondary">System</Badge>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <GrantsScopePanel roles={[role]} />
                    <div className="text-xs text-muted-foreground">
                      {t('common.fields.resources', 'Resources')}:{' '}
                      {role.resources.includes('*')
                        ? '*'
                        : role.resources.join(', ') || '-'}{' '}
                      · {t('common.fields.verbs', 'Verbs')}:{' '}
                      {role.verbs.includes('*')
                        ? '*'
                        : role.verbs.join(', ') || '-'}
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default GroupGrantsView
