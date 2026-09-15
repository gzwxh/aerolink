import { useEffect, useMemo, useState } from 'react'
import {
  IconLoader2,
  IconPencil,
  IconPlus,
  IconSearch,
  IconTrash,
  IconUsers,
  IconX,
} from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import {
  createGroup,
  deleteGroup as deleteGroupApi,
  fetchKnownGroups,
  fetchUserList,
  renameGroup as renameGroupApi,
  updateUser,
  useRoleList,
} from '@/lib/api'
import { cn, formatDate } from '@/lib/utils'
import { useCluster } from '@/hooks/use-cluster'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DeleteConfirmationDialog } from '@/components/delete-confirmation-dialog'
import { MultiSelect } from '@/components/multi-select'

interface MemberInfo {
  id: number
  username: string
  displayName?: string
  enabled?: boolean
  provider: string
  lastLoginAt?: string
  groups: string[]
}

interface GroupEntry {
  name: string
  /** Local users whose profile carries this group and can be edited. */
  editableMembers: MemberInfo[]
  /** External (LDAP / OIDC) users; membership is directory-managed. */
  externalMembers: MemberInfo[]
  /** Granted via RBAC role assignments; may have no members. */
  hasRoleGrant: boolean
}

const isNative = (provider: string) => !provider || provider === 'password'

/**
 * Settings sub-tab for user groups: create local groups, manage members and
 * jump to the group's RBAC grants. Group membership lives on user profiles
 * (oidc_groups); external users are directory-managed and read-only here.
 */
export function UserGroupsTab() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { currentCluster } = useCluster()
  const { data: roles = [] } = useRoleList()

  const [allUsers, setAllUsers] = useState<MemberInfo[]>([])
  const [persistedGroups, setPersistedGroups] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string | null>(null)

  const [showAddGroup, setShowAddGroup] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [newGroupMembers, setNewGroupMembers] = useState<string[]>([])
  const [isCreating, setIsCreating] = useState(false)

  const [showAddMember, setShowAddMember] = useState(false)
  const [addMemberSelection, setAddMemberSelection] = useState<string[]>([])
  const [isMutating, setIsMutating] = useState(false)

  const [showRename, setShowRename] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [showDelete, setShowDelete] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const collected: MemberInfo[] = []
        for (let page = 1; ; page++) {
          const res = await fetchUserList(page, 500, '')
          collected.push(
            ...(res.users || []).map((u) => ({
              id: u.id,
              username: u.username,
              displayName: u.name,
              enabled: u.enabled,
              provider: u.provider,
              lastLoginAt: u.lastLoginAt,
              groups: u.oidc_groups || [],
            }))
          )
          if (collected.length >= res.total || (res.users || []).length === 0) {
            break
          }
        }
        if (!cancelled) setAllUsers(collected)
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Groups persisted as entities (visible even with no members or grants).
  const refreshPersistedGroups = async () => {
    try {
      setPersistedGroups(await fetchKnownGroups())
    } catch {
      // Non-fatal: derived groups from users/roles still render.
    }
  }

  useEffect(() => {
    void refreshPersistedGroups()
  }, [])

  const groups = useMemo<GroupEntry[]>(() => {
    const map = new Map<string, GroupEntry>()
    const ensure = (name: string) => {
      let entry = map.get(name)
      if (!entry) {
        entry = {
          name,
          editableMembers: [],
          externalMembers: [],
          hasRoleGrant: false,
        }
        map.set(name, entry)
      }
      return entry
    }

    for (const name of persistedGroups) {
      ensure(name)
    }

    for (const role of roles) {
      for (const assignment of role.assignments || []) {
        if (assignment.subjectType === 'group') {
          ensure(assignment.subject).hasRoleGrant = true
        }
      }
    }

    for (const user of allUsers) {
      for (const group of user.groups) {
        // 历史脏数据可能带空字符串组名，跳过避免出现"空名组"。
        if (!group.trim()) continue
        const entry = ensure(group)
        const member: MemberInfo = user
        if (isNative(user.provider)) {
          entry.editableMembers.push(member)
        } else {
          entry.externalMembers.push(member)
        }
      }
    }

    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name))
  }, [roles, allUsers, persistedGroups])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return groups
    return groups.filter((g) => g.name.toLowerCase().includes(q))
  }, [groups, search])

  const selectedGroup = filtered.find((g) => g.name === selected) ?? filtered[0]

  const allMembers = selectedGroup
    ? [...selectedGroup.editableMembers, ...selectedGroup.externalMembers]
    : []

  const nativeUserOptions = useMemo(
    () =>
      allUsers
        .filter((u) => isNative(u.provider))
        .map((u) => u.username)
        .sort((a, b) => a.localeCompare(b)),
    [allUsers]
  )

  const setMemberGroups = async (member: MemberInfo, nextGroups: string[]) => {
    // 后端 UpdateUser 的请求字段是 groups（oidc_groups 是用户列表的返回字段名，
    // 用错字段后端会静默忽略更新并返回 200，导致"添加成功"的假象）。
    await updateUser(member.id, { groups: nextGroups })
    setAllUsers((prev) =>
      prev.map((u) => (u.id === member.id ? { ...u, groups: nextGroups } : u))
    )
  }

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['user-list'] })
    queryClient.invalidateQueries({ queryKey: ['role-list'] })
    void refreshPersistedGroups()
  }

  const handleCreateGroup = async () => {
    const groupName = newGroupName.trim()
    if (!groupName) return
    if (groups.some((g) => g.name === groupName)) {
      toast.error(t('userManagement.groupExists', 'Group already exists'))
      return
    }

    setIsCreating(true)
    try {
      // Persist the group as an entity first so it stays visible even when
      // no members are selected (members are optional).
      try {
        await createGroup(groupName)
      } catch {
        // Tolerate duplicates: an implicitly existing group (referenced by
        // users or grants) may not be persisted yet but is equally valid.
      }
      for (const username of newGroupMembers) {
        const member = allUsers.find((u) => u.username === username)
        if (!member || !isNative(member.provider)) continue
        await setMemberGroups(member, [...member.groups, groupName])
      }
      await invalidate()
      toast.success(
        t('userManagement.groupCreated', {
          name: groupName,
          defaultValue: 'User group {{name}} created',
        })
      )
      setSelected(groupName)
      setShowAddGroup(false)
      setNewGroupName('')
      setNewGroupMembers([])
    } catch (err) {
      // 操作失败已由 API 客户端统一写入站内信，不再弹窗
    } finally {
      setIsCreating(false)
    }
  }

  const handleAddMembers = async () => {
    if (!selectedGroup || addMemberSelection.length === 0) return
    setIsMutating(true)
    try {
      for (const username of addMemberSelection) {
        const member = allUsers.find((u) => u.username === username)
        if (!member || member.groups.includes(selectedGroup.name)) continue
        await setMemberGroups(member, [...member.groups, selectedGroup.name])
      }
      await invalidate()
      toast.success(t('userManagement.memberAdded', 'Members added'))
      setShowAddMember(false)
      setAddMemberSelection([])
    } catch (err) {
      // 操作失败已由 API 客户端统一写入站内信，不再弹窗
    } finally {
      setIsMutating(false)
    }
  }

  const handleRemoveMember = async (member: MemberInfo) => {
    if (!selectedGroup) return
    setIsMutating(true)
    try {
      await setMemberGroups(
        member,
        member.groups.filter((g) => g !== selectedGroup.name)
      )
      await invalidate()
      toast.success(t('userManagement.memberRemoved', 'Member removed'))
    } catch (err) {
      // 操作失败已由 API 客户端统一写入站内信，不再弹窗
    } finally {
      setIsMutating(false)
    }
  }

  const addMemberOptions = nativeUserOptions.filter(
    (username) => !allMembers.some((m) => m.username === username)
  )

  // Roles that currently carry a group-subject grant for the selected group.
  const grantedRoles = useMemo(() => {
    if (!selectedGroup) return []
    const result: { id: number; name: string }[] = []
    for (const role of roles) {
      if (
        (role.assignments || []).some(
          (a) => a.subjectType === 'group' && a.subject === selectedGroup.name
        )
      ) {
        result.push({ id: role.id, name: role.name })
      }
    }
    return result
  }, [roles, selectedGroup])

  const handleRenameGroup = async () => {
    if (!selectedGroup) return
    const oldName = selectedGroup.name
    const newName = renameValue.trim()
    if (!newName || newName === oldName) return
    if (groups.some((g) => g.name === newName)) {
      toast.error(t('userManagement.groupExists', 'Group already exists'))
      return
    }

    setIsMutating(true)
    try {
      // Backend renames the entity plus every reference (user profiles and
      // role assignments) in one transaction.
      await renameGroupApi(oldName, newName)
      setAllUsers((prev) =>
        prev.map((u) => ({
          ...u,
          groups: u.groups.map((g) => (g === oldName ? newName : g)),
        }))
      )
      await invalidate()
      toast.success(
        t('userManagement.groupRenamed', {
          oldName,
          newName,
          defaultValue: 'Group renamed to {{newName}}',
        })
      )
      setSelected(newName)
      setShowRename(false)
    } catch (err) {
      await invalidate()
      // 操作失败已由 API 客户端统一写入站内信，不再弹窗
    } finally {
      setIsMutating(false)
    }
  }

  const handleDeleteGroup = async () => {
    if (!selectedGroup) return
    const groupName = selectedGroup.name
    setIsMutating(true)
    try {
      // Backend deletes the entity and cleans up every reference (memberships
      // on user profiles and group-subject role assignments) atomically.
      await deleteGroupApi(groupName)
      setAllUsers((prev) =>
        prev.map((u) => ({
          ...u,
          groups: u.groups.filter((g) => g !== groupName),
        }))
      )
      await invalidate()
      toast.success(
        t('userManagement.groupDeleted', {
          name: groupName,
          defaultValue: 'Group {{name}} deleted',
        })
      )
      setSelected(null)
      setShowDelete(false)
    } catch (err) {
      await invalidate()
      // 操作失败已由 API 客户端统一写入站内信，不再弹窗
    } finally {
      setIsMutating(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      <Card className="shrink-0 lg:w-64">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <IconUsers className="h-4 w-4" />
            {t('userManagement.groupsTabTitle', 'User Groups')}
            <Badge variant="secondary" className="ml-auto">
              {groups.length}
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
          <Button
            variant="outline"
            size="sm"
            className="w-full gap-2"
            onClick={() => {
              setNewGroupName('')
              setNewGroupMembers([])
              setShowAddGroup(true)
            }}
          >
            <IconPlus className="h-4 w-4" />
            {t('userManagement.addGroup', 'Add User Group')}
          </Button>
        </CardHeader>
        <CardContent className="p-2 pt-0">
          <nav className="space-y-1">
            {filtered.map((group) => (
              <button
                key={group.name}
                type="button"
                onClick={() => setSelected(group.name)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left transition-colors hover:bg-accent',
                  (selectedGroup?.name || '') === group.name && 'bg-accent'
                )}
              >
                <IconUsers className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span
                  className="min-w-0 flex-1 truncate font-medium"
                  title={group.name}
                >
                  {group.name}
                </span>
                <Badge variant="secondary" className="shrink-0 text-xs">
                  {group.editableMembers.length + group.externalMembers.length}
                </Badge>
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="px-3 py-4 text-sm text-muted-foreground">
                {isLoading
                  ? t('common.messages.loading', 'Loading...')
                  : t(
                      'userManagement.groupsEmpty',
                      'No groups found. Groups come from LDAP / OIDC sync or user profiles.'
                    )}
              </div>
            )}
          </nav>
        </CardContent>
      </Card>

      <div className="min-w-0 flex-1 space-y-4">
        {!selectedGroup ? (
          <div className="flex items-center justify-center rounded-md border border-dashed py-16 text-muted-foreground">
            {t(
              'userManagement.selectGroupHint',
              'Select a group to view its members.'
            )}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <IconUsers className="h-5 w-5 text-muted-foreground" />
              <h2 className="text-xl font-semibold">{selectedGroup.name}</h2>
              <Badge variant="secondary">
                {t('userManagement.membersCount', {
                  count: allMembers.length,
                  defaultValue: '{{count}} member(s)',
                })}
              </Badge>
              <Button
                variant="outline"
                size="sm"
                className="ml-auto"
                onClick={() => {
                  setAddMemberSelection([])
                  setShowAddMember(true)
                }}
              >
                <IconPlus className="h-4 w-4" />
                {t('userManagement.addMember', 'Add Members')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  window.location.href = `/settings/rbac?rbacTab=group&subject=${encodeURIComponent(selectedGroup.name)}${
                    currentCluster
                      ? `&cluster=${encodeURIComponent(currentCluster)}`
                      : ''
                  }`
                }}
              >
                {t('userManagement.groupGrantsLink', 'View group grants')}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                disabled={isMutating}
                aria-label={t('common.actions.rename', 'Rename')}
                title={t('common.actions.rename', 'Rename')}
                onClick={() => {
                  setRenameValue(selectedGroup.name)
                  setShowRename(true)
                }}
              >
                <IconPencil className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                disabled={isMutating}
                aria-label={t('common.actions.delete', 'Delete')}
                title={t('common.actions.delete', 'Delete')}
                onClick={() => setShowDelete(true)}
              >
                <IconTrash className="h-4 w-4" />
              </Button>
            </div>

            <p className="text-sm text-muted-foreground">
              {t(
                'userManagement.groupsInheritHint',
                'Members inherit the roles granted to this group in RBAC management.'
              )}
            </p>

            <div className="overflow-hidden rounded-md border">
              <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-3 border-b bg-muted/40 px-3 py-2 text-xs font-semibold text-muted-foreground">
                <span>{t('common.fields.username', 'Username')}</span>
                <span>{t('common.fields.status', 'Status')}</span>
                <span>{t('common.fields.provider', 'Provider')}</span>
                <span>{t('common.fields.lastLoginAt', 'Last Login')}</span>
              </div>
              {allMembers.length === 0 ? (
                <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                  {selectedGroup.hasRoleGrant
                    ? t(
                        'userManagement.noMembers',
                        'No members. Add local users to this group.'
                      )
                    : t('userManagement.noMembers', 'No members.')}
                </div>
              ) : (
                allMembers.map((member) => (
                  <div
                    key={member.username}
                    className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto_auto] items-center gap-3 border-b px-3 py-2 text-sm last:border-b-0"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="font-medium">{member.username}</span>
                      {member.displayName && (
                        <span className="text-xs text-muted-foreground">
                          {member.displayName}
                        </span>
                      )}
                      {!isNative(member.provider) && (
                        <span
                          className="text-xs text-muted-foreground"
                          title={t(
                            'userManagement.externalMemberHint',
                            'Managed by the directory'
                          )}
                        >
                          <IconLoader2 className="h-3 w-3 opacity-60" />
                        </span>
                      )}
                    </div>
                    <Badge
                      variant={
                        member.enabled === false ? 'secondary' : 'default'
                      }
                      className="text-xs"
                    >
                      {member.enabled === false
                        ? t('status.disabled', 'Disabled')
                        : t('status.enabled', 'Enabled')}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {member.provider || '-'}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {member.lastLoginAt
                        ? formatDate(member.lastLoginAt)
                        : '-'}
                    </span>
                    {isNative(member.provider) ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground hover:text-destructive"
                        disabled={isMutating}
                        aria-label={`${t('userManagement.removeMember', 'Remove')} ${member.username}`}
                        onClick={() => void handleRemoveMember(member)}
                      >
                        <IconX className="h-3.5 w-3.5" />
                      </Button>
                    ) : (
                      <span />
                    )}
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>

      {showAddGroup && (
        <Dialog open onOpenChange={(open) => !open && setShowAddGroup(false)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>
                {t('userManagement.addGroupTitle', 'Add User Group')}
              </DialogTitle>
              <DialogDescription>
                {t(
                  'userManagement.addGroupDescription',
                  'Creates a local group and optionally adds members. Members inherit the roles granted to this group.'
                )}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="group-name">
                  {t('userManagement.groupName', 'Group Name')} *
                </Label>
                <Input
                  id="group-name"
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  placeholder={t(
                    'userManagement.groupNamePlaceholder',
                    'Enter group name'
                  )}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-2">
                <Label>
                  {t('userManagement.membersOptional', 'Members (optional)')}
                </Label>
                <MultiSelect
                  value={newGroupMembers}
                  onChange={setNewGroupMembers}
                  options={nativeUserOptions}
                  selectAllMode="all"
                  allowAdd={false}
                  disabled={isCreating}
                  placeholder={t(
                    'common.placeholders.selectUsers',
                    'Select users...'
                  )}
                  emptyText={t(
                    'common.messages.noOptionsFound',
                    'No options found'
                  )}
                />
                <p className="text-xs text-muted-foreground">
                  {t(
                    'userManagement.localMembersOnlyHint',
                    'Only local (password) users can be added; external users are managed by the directory.'
                  )}
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setShowAddGroup(false)}
                disabled={isCreating}
              >
                {t('common.actions.cancel', 'Cancel')}
              </Button>
              <Button
                onClick={() => void handleCreateGroup()}
                disabled={isCreating || !newGroupName.trim()}
              >
                {isCreating && <IconLoader2 className="h-4 w-4 animate-spin" />}
                {isCreating
                  ? t('common.actions.creating', 'Creating...')
                  : t('common.actions.create', 'Create')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {showAddMember && selectedGroup && (
        <Dialog open onOpenChange={(open) => !open && setShowAddMember(false)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>
                {t('userManagement.addMemberTitle', {
                  name: selectedGroup.name,
                  defaultValue: 'Add members to {{name}}',
                })}
              </DialogTitle>
              <DialogDescription>
                {t(
                  'userManagement.addMemberDescription',
                  'Only local (password) users can be added; external users are managed by the directory.'
                )}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label>{t('common.fields.users', 'Users')}</Label>
              <MultiSelect
                value={addMemberSelection}
                onChange={setAddMemberSelection}
                options={addMemberOptions}
                selectAllMode="all"
                allowAdd={false}
                disabled={isMutating}
                placeholder={t(
                  'common.placeholders.selectUsers',
                  'Select users...'
                )}
                emptyText={t(
                  'common.messages.noOptionsFound',
                  'No options found'
                )}
              />
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setShowAddMember(false)}
                disabled={isMutating}
              >
                {t('common.actions.cancel', 'Cancel')}
              </Button>
              <Button
                onClick={() => void handleAddMembers()}
                disabled={addMemberSelection.length === 0 || isMutating}
              >
                {isMutating && <IconLoader2 className="h-4 w-4 animate-spin" />}
                {isMutating
                  ? t('common.actions.saving', 'Saving...')
                  : t('userManagement.addMember', 'Add Members')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {showRename && selectedGroup && (
        <Dialog open onOpenChange={(open) => !open && setShowRename(false)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>
                {t('userManagement.renameGroupTitle', {
                  name: selectedGroup.name,
                  defaultValue: 'Rename group {{name}}',
                })}
              </DialogTitle>
              <DialogDescription>
                {t(
                  'userManagement.renameGroupDescription',
                  'The new name is applied to local members and RBAC role grants. External (directory) members are not affected.'
                )}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="rename-group">
                {t('userManagement.groupName', 'Group Name')} *
              </Label>
              <Input
                id="rename-group"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                placeholder={t(
                  'userManagement.groupNamePlaceholder',
                  'Enter group name'
                )}
                autoComplete="off"
              />
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setShowRename(false)}
                disabled={isMutating}
              >
                {t('common.actions.cancel', 'Cancel')}
              </Button>
              <Button
                onClick={() => void handleRenameGroup()}
                disabled={
                  isMutating ||
                  !renameValue.trim() ||
                  renameValue.trim() === selectedGroup.name
                }
              >
                {isMutating && <IconLoader2 className="h-4 w-4 animate-spin" />}
                {isMutating
                  ? t('common.actions.saving', 'Saving...')
                  : t('common.actions.save', 'Save')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {showDelete && selectedGroup && (
        <DeleteConfirmationDialog
          open
          onOpenChange={(open) => !open && setShowDelete(false)}
          resourceName={selectedGroup.name}
          resourceType={t('userManagement.groupType', 'user group')}
          isDeleting={isMutating}
          onConfirm={() => void handleDeleteGroup()}
          additionalNote={t('userManagement.deleteGroupImpact', {
            members: selectedGroup.editableMembers.length,
            external: selectedGroup.externalMembers.length,
            grants: grantedRoles.length,
            defaultValue:
              '{{members}} local member(s) will be removed from this group, {{external}} external reference(s) and {{grants}} RBAC role grant(s) will be deleted.',
          })}
        />
      )}
    </div>
  )
}

export default UserGroupsTab
