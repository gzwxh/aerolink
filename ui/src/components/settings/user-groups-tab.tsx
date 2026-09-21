import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSettingsSectionAccess } from '@/contexts/settings-section-context'
import {
  IconArrowLeft,
  IconLoader2,
  IconNotes,
  IconPencil,
  IconPlus,
  IconSearch,
  IconShieldCheck,
  IconTrash,
  IconUsers,
  IconX,
} from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import {
  ColumnDef,
  ColumnFiltersState,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  PaginationState,
  SortingState,
  useReactTable,
} from '@tanstack/react-table'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

import {
  addGroupMember,
  createGroup,
  deleteGroup as deleteGroupApi,
  fetchGroupMembers,
  fetchKnownGroupDetails,
  fetchUserList,
  removeGroupMember,
  renameGroup as renameGroupApi,
  updateGroupDescription,
  useRoleList,
  type GroupSource,
  type KnownGroupDetail,
} from '@/lib/api'
import { ApiError } from '@/lib/api-client'
import { formatDate, translateError } from '@/lib/utils'
import { useTableColumnVisibility } from '@/hooks/use-table-column-visibility'
import {
  useDraftDirty,
  useUnsavedChangesGuard,
} from '@/hooks/use-unsaved-changes-guard'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { DeleteConfirmationDialog } from '@/components/delete-confirmation-dialog'
import { MultiSelect } from '@/components/multi-select'
import { ResourceTableView } from '@/components/resource-table-view'
import { TableColumnToggle } from '@/components/table-column-toggle'
import { UnsavedChangesConfirmDialog } from '@/components/unsaved-changes-confirm-dialog'

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
  /** 组本身的来源：本地创建，还是目录同步发现（决定能不能在这里改名/删除）。 */
  source: GroupSource
  /** 控制台的本地备注：不参与授权，也不参与目录同步，目录组同样可以标注。 */
  description: string
  /** 资料中包含该组、且可编辑的本地用户。 */
  editableMembers: MemberInfo[]
  /** 外部（LDAP / OIDC）用户；成员关系由目录管理。 */
  externalMembers: MemberInfo[]
  /** 授予该组的 RBAC 角色名称。 */
  grantedRoleNames: string[]
}

// 详情页的成员表：用户名 / 状态 / 认证方式 / 最后登录 四列等宽平分（含表头），
// 末尾留一个固定宽度的操作列，内容统一居中。
const MEMBER_ROW_GRID =
  'grid grid-cols-[1fr_1fr_1fr_1fr_2.5rem] items-center gap-3'

const isNative = (provider: string) => !provider || provider === 'password'

// 详情页选中的用户组放在 URL 上（?tab=group&group=<组名>）：
// 设置页据此把组名接到面包屑末尾，刷新 / 前进后退也能停在同一组的详情上。
const GROUP_PARAM = 'group'

const memberCount = (group: GroupEntry) =>
  group.editableMembers.length + group.externalMembers.length

/**
 * 用户组的设置子标签页：创建本地组、管理成员，并
 * 跳转到该组的 RBAC 授权。组成员关系保存在用户资料上
 * （oidc_groups）；外部用户由目录管理，这里只读。
 */
export function UserGroupsTab() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  // 只读章节（只有 settings.<章节> 的读权限）时不渲染任何写入口。
  const { readOnly } = useSettingsSectionAccess()
  const { data: roles = [] } = useRoleList()

  const [allUsers, setAllUsers] = useState<MemberInfo[]>([])
  // 已知用户组实体：来源（本地 / LDAP / OIDC）+ 控制台描述。目录组也只改目录，
  // 不是在这里改名或删除的对象。
  const [knownGroups, setKnownGroups] = useState<
    Record<string, KnownGroupDetail>
  >({})
  const [isLoading, setIsLoading] = useState(true)
  const [search, setSearch] = useState('')
  // 详情页当前打开的用户组（null = 停留在列表页）：点击组名进入，点「返回列表」或改名/删除成功后退回列表。
  const [searchParams, setSearchParams] = useSearchParams()
  const detailGroupName = searchParams.get(GROUP_PARAM)
  // 用 useCallback 包起来：列定义（useMemo）依赖它，普通函数每次渲染都换身份，
  // 会让列定义无法复用（并被 react-hooks 提示缺少依赖）。
  const setDetailGroupName = useCallback(
    (name: string | null) => {
      const next = new URLSearchParams(searchParams)
      if (name) {
        next.set(GROUP_PARAM, name)
      } else {
        next.delete(GROUP_PARAM)
      }
      // replace：列表 ↔ 详情之间切换不堆历史记录，浏览器的后退语义仍是「离开设置页」。
      setSearchParams(next, { replace: true })
    },
    [searchParams, setSearchParams]
  )
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 20,
  })
  const [sorting, setSorting] = useState<SortingState>([])
  // 列过滤（目前只有「来源」一列）：数据是整表载入的，沿用资源列表的分面过滤。
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  // 列显示偏好：与资源列表（/deployments 等）一致，用齿轮菜单勾选，并持久化。
  // 用户组列表是全局数据，不带集群前缀。
  const [columnVisibility, setColumnVisibility] = useTableColumnVisibility(
    'kite-user-groups-columnVisibility'
  )

  const [showAddGroup, setShowAddGroup] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [newGroupDescription, setNewGroupDescription] = useState('')
  const [newGroupMembers, setNewGroupMembers] = useState<string[]>([])
  const [isCreating, setIsCreating] = useState(false)

  const [showAddMember, setShowAddMember] = useState(false)
  const [addMemberSelection, setAddMemberSelection] = useState<string[]>([])
  const [isMutating, setIsMutating] = useState(false)
  // 展开组的成员关系来源（用户名 → local / ldap / oidc）：决定能不能在这里移除。
  const [memberSources, setMemberSources] = useState<Record<string, string>>({})

  const [showRename, setShowRename] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [showDescription, setShowDescription] = useState(false)
  const [descriptionValue, setDescriptionValue] = useState('')
  const [showDelete, setShowDelete] = useState(false)

  const loadUsers = useCallback(async () => {
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
      setAllUsers(collected)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadUsers().catch(() => setIsLoading(false))
  }, [loadUsers])

  // 作为实体持久化的组（即使没有成员或授权也可见）。
  const refreshPersistedGroups = async () => {
    try {
      setKnownGroups(await fetchKnownGroupDetails())
    } catch {
      // 非致命：从用户/角色推导出的组仍会渲染。
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
          source: knownGroups[name]?.source ?? 'local',
          description: knownGroups[name]?.description ?? '',
          editableMembers: [],
          externalMembers: [],
          grantedRoleNames: [],
        }
        map.set(name, entry)
      }
      return entry
    }

    for (const name of Object.keys(knownGroups)) {
      ensure(name)
    }

    for (const role of roles) {
      for (const assignment of role.assignments || []) {
        if (assignment.subjectType === 'group') {
          const entry = ensure(assignment.subject)
          if (!entry.grantedRoleNames.includes(role.name)) {
            entry.grantedRoleNames.push(role.name)
          }
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
  }, [roles, allUsers, knownGroups])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return groups
    return groups.filter((g) => g.name.toLowerCase().includes(q))
  }, [groups, search])

  useEffect(() => {
    setPagination((prev) => ({ ...prev, pageIndex: 0 }))
  }, [search, sorting])

  const activeGroup = groups.find((g) => g.name === detailGroupName) ?? null
  const allMembers = activeGroup
    ? [...activeGroup.editableMembers, ...activeGroup.externalMembers]
    : []

  // 可选成员：**所有**账号（含 LDAP / OIDC）。目录账号被加进本地组时记为「本地附加」
  // 成员关系（group_members.source = local），目录同步不会把它移除，
  // 因此可以在这里直接维护。
  const memberUserOptions = useMemo(
    () => allUsers.map((u) => u.username).sort((a, b) => a.localeCompare(b)),
    [allUsers]
  )

  const loadGroupMembers = useCallback(async (groupName: string | null) => {
    if (!groupName) {
      setMemberSources({})
      return
    }
    try {
      const members = await fetchGroupMembers(groupName)
      setMemberSources(
        Object.fromEntries(members.map((m) => [m.username, m.source]))
      )
    } catch {
      // 非致命：拿不到来源时按账号类型兜底判断可否移除。
      setMemberSources({})
    }
  }, [])

  useEffect(() => {
    void loadGroupMembers(detailGroupName)
  }, [detailGroupName, allUsers, loadGroupMembers])

  // 成员关系是否为本地来源（可在此移除）：
  // 有来源记录时以它为准（目录同步来的组关系不能在这里删）；没有记录时
  // 目录账号宁可保守处理，本地账号的成员关系一定是本地来源。
  const isLocalMembership = (member: MemberInfo) => {
    const source = memberSources[member.username]
    if (source) return source === 'local'
    return isNative(member.provider)
  }

  const invalidate = async () => {
    queryClient.invalidateQueries({ queryKey: ['user-list'] })
    queryClient.invalidateQueries({ queryKey: ['role-list'] })
    void refreshPersistedGroups()
    // 组的成员列表由 users.oidc_groups 推导，成员关系改完必须重拉用户列表，
    // 否则界面停留在旧数据上（曾经表现为"保存成功但看不到"）。
    await loadUsers()
    await loadGroupMembers(detailGroupName)
  }

  // 四个弹窗各自持有草稿，关闭即丢弃：逐个拦截遮罩点击 / Esc / 右上角 X，有改动时先确认。
  // 四个草稿都在打开时被重置（Add Group / Add Members 置空，Rename / Description 写入
  // 当前组名 / 原描述），所以基线显式给出，不依赖「首次渲染」那份值。
  const isAddGroupDirty = useDraftDirty(
    {
      name: newGroupName,
      description: newGroupDescription,
      members: newGroupMembers,
    },
    { name: '', description: '', members: [] }
  )
  const closeAddGroup = useCallback(() => setShowAddGroup(false), [])
  const addGroupGuard = useUnsavedChangesGuard({
    dirty: isAddGroupDirty,
    onClose: closeAddGroup,
  })

  const isAddMemberDirty = useDraftDirty(addMemberSelection, [])
  const closeAddMember = useCallback(() => setShowAddMember(false), [])
  const addMemberGuard = useUnsavedChangesGuard({
    dirty: isAddMemberDirty,
    onClose: closeAddMember,
  })

  const isRenameDirty = useDraftDirty(renameValue, activeGroup?.name ?? '')
  const closeRename = useCallback(() => setShowRename(false), [])
  const renameGuard = useUnsavedChangesGuard({
    dirty: isRenameDirty,
    onClose: closeRename,
  })

  const isDescriptionDirty = useDraftDirty(
    descriptionValue,
    activeGroup?.description ?? ''
  )
  const closeDescription = useCallback(() => setShowDescription(false), [])
  const descriptionGuard = useUnsavedChangesGuard({
    dirty: isDescriptionDirty,
    onClose: closeDescription,
  })

  const handleCreateGroup = async () => {
    const groupName = newGroupName.trim()
    if (!groupName) return
    if (groups.some((g) => g.name === groupName)) {
      toast.error(t('userManagement.groupExists', 'Group already exists'))
      return
    }

    setIsCreating(true)
    try {
      // 先把该组作为实体持久化，这样即使没有选择任何成员
      // 它也能保持可见（成员是可选的）。
      try {
        await createGroup(groupName, newGroupDescription.trim())
      } catch {
        // 容忍重复：一个隐式已存在的组（被用户或授权引用）
        // 可能尚未持久化，但同样合法。
      }
      for (const username of newGroupMembers) {
        await addGroupMember(groupName, username)
      }
      await invalidate()
      toast.success(
        t('userManagement.groupCreated', {
          name: groupName,
          defaultValue: 'User group {{name}} created',
        })
      )
      closeAddGroup()
      setNewGroupName('')
      setNewGroupDescription('')
      setNewGroupMembers([])
    } catch (error) {
      toast.error(translateError(error, t))
    } finally {
      setIsCreating(false)
    }
  }

  const handleAddMembers = async () => {
    if (!activeGroup || addMemberSelection.length === 0) return
    setIsMutating(true)
    try {
      // 走逐成员接口而不是整份更新用户：目录账号的 groups 字段会被后端
      // 静默忽略（源系统管辖），旧写法对 LDAP / OIDC 用户表现为「保存成功但没加上」。
      for (const username of addMemberSelection) {
        await addGroupMember(activeGroup.name, username)
      }
      await invalidate()
      toast.success(t('userManagement.memberAdded', 'Members added'))
      closeAddMember()
      setAddMemberSelection([])
    } catch (error) {
      toast.error(translateError(error, t))
    } finally {
      setIsMutating(false)
    }
  }

  const handleRemoveMember = async (groupName: string, member: MemberInfo) => {
    setIsMutating(true)
    try {
      await removeGroupMember(groupName, member.username)
      await invalidate()
      toast.success(t('userManagement.memberRemoved', 'Member removed'))
    } catch (error) {
      // 目录同步来的成员关系只能在目录里改，把后端的原因说清楚，
      // 不要让界面看起来像成功了。
      if (
        error instanceof ApiError &&
        error.code === 'group_member_directory_managed'
      ) {
        toast.error(
          t('userManagement.memberDirectoryManaged', {
            username: member.username,
            defaultValue:
              "{{username}}'s membership comes from the directory; remove it there.",
          })
        )
      } else {
        toast.error(translateError(error, t))
      }
    } finally {
      setIsMutating(false)
    }
  }

  const addMemberOptions = memberUserOptions.filter(
    (username) => !allMembers.some((m) => m.username === username)
  )

  // 当前为展开的组持有"组主体"授权的角色。
  const grantedRoles = (activeGroup?.grantedRoleNames ?? []).map((name) => ({
    name,
  }))

  const handleRenameGroup = async () => {
    if (!activeGroup) return
    const oldName = activeGroup.name
    const newName = renameValue.trim()
    if (!newName || newName === oldName) return
    if (groups.some((g) => g.name === newName)) {
      toast.error(t('userManagement.groupExists', 'Group already exists'))
      return
    }

    setIsMutating(true)
    try {
      // 后端在一个事务中重命名该实体及其每一处引用（用户资料与
      // 角色授权）。
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
      // 改名后回到列表页：名字已经变了，继续停在旧名字的详情上会让人以为没生效。
      setDetailGroupName(null)
      closeRename()
    } catch (error) {
      await invalidate()
      toast.error(translateError(error, t))
    } finally {
      setIsMutating(false)
    }
  }

  // 描述只是控制台的本地备注：不改名、不动授权、不参与目录同步，因此目录组也能标注。
  const handleUpdateDescription = async () => {
    if (!activeGroup) return
    const description = descriptionValue.trim()
    if (description === activeGroup.description) {
      closeDescription()
      return
    }

    setIsMutating(true)
    try {
      await updateGroupDescription(activeGroup.name, description)
      await invalidate()
      toast.success(
        t('userManagement.groupDescriptionUpdated', 'Description updated')
      )
      closeDescription()
    } catch (error) {
      toast.error(translateError(error, t))
    } finally {
      setIsMutating(false)
    }
  }

  const handleDeleteGroup = async () => {
    if (!activeGroup) return
    const groupName = activeGroup.name
    setIsMutating(true)
    try {
      // 后端原子地删除该实体并清理每一处引用（用户资料上的成员关系
      // 与以组为主体的角色授权）。
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
      setDetailGroupName(null)
      setShowDelete(false)
    } catch (error) {
      await invalidate()
      toast.error(translateError(error, t))
    } finally {
      setIsMutating(false)
    }
  }

  const columns = useMemo<ColumnDef<GroupEntry>[]>(
    () => [
      {
        accessorKey: 'name',
        header: t('userManagement.groupName', 'Group Name'),
        cell: ({ row }) => {
          const group = row.original
          return (
            <div className="min-w-0">
              <button
                type="button"
                className="flex items-center gap-2 text-left hover:text-primary"
                onClick={() => setDetailGroupName(group.name)}
              >
                <IconUsers className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span
                  className="min-w-0 truncate font-medium"
                  title={group.name}
                >
                  {group.name}
                </span>
              </button>
            </div>
          )
        },
      },
      {
        accessorKey: 'description',
        header: t('userManagement.groupDescription', 'Description'),
        cell: ({ row }) => {
          const description = row.original.description
          if (!description) {
            return <span className="text-sm text-muted-foreground">-</span>
          }
          return (
            <div
              className="line-clamp-2 max-w-[24rem] text-sm break-words text-muted-foreground"
              title={description}
            >
              {description}
            </div>
          )
        },
      },
      {
        id: 'source',
        header: t('userManagement.groupSource', 'Source'),
        accessorFn: (group) => group.source,
        enableColumnFilter: true,
        filterFn: 'equalsString',
        cell: ({ row }) => {
          const source = row.original.source
          return (
            <Badge
              variant={source === 'local' ? 'outline' : 'secondary'}
              className="text-xs"
            >
              {source === 'local'
                ? t('userManagement.groupSourceLocal', 'Local')
                : source.toUpperCase()}
            </Badge>
          )
        },
      },
      {
        id: 'members',
        header: t('userManagement.members', 'Members'),
        accessorFn: (group) => memberCount(group),
        cell: ({ row }) => (
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Badge variant="secondary" className="text-xs">
              {memberCount(row.original)}
            </Badge>
            {row.original.externalMembers.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {t('userManagement.membersBreakdown', {
                  local: row.original.editableMembers.length,
                  external: row.original.externalMembers.length,
                  defaultValue: '{{local}} local · {{external}} external',
                })}
              </span>
            )}
          </div>
        ),
      },
      {
        id: 'roles',
        header: t('userManagement.grantedRoles', 'Granted roles'),
        enableSorting: false,
        cell: ({ row }) => {
          const names = row.original.grantedRoleNames
          if (names.length === 0) {
            return <span className="text-sm text-muted-foreground">-</span>
          }
          const shown = names.slice(0, 2)
          return (
            <div
              className="flex flex-wrap items-center justify-center gap-1"
              title={names.join(', ')}
            >
              {shown.map((name) => (
                <Badge key={name} variant="outline" className="text-xs">
                  {name}
                </Badge>
              ))}
              {names.length > shown.length && (
                <span className="text-xs text-muted-foreground">
                  +{names.length - shown.length}
                </span>
              )}
            </div>
          )
        },
      },
    ],
    [setDetailGroupName, t]
  )

  const table = useReactTable<GroupEntry>({
    data: filtered,
    columns,
    state: { pagination, sorting, columnVisibility, columnFilters },
    onPaginationChange: setPagination,
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
  })

  // 「来源」过滤器的候选项：与资源列表一致，取当前数据里实际出现过的值。
  const sourceColumn = table.getColumn('source')
  const sourceOptions = sourceColumn
    ? Array.from(sourceColumn.getFacetedUniqueValues().keys())
        .filter(Boolean)
        .map(String)
        .sort((a, b) => a.localeCompare(b))
    : []

  // 某个组的成员列表，渲染在它的可展开行中。
  const renderMembers = (group: GroupEntry) => {
    const members = [...group.editableMembers, ...group.externalMembers]
    return (
      <div className="overflow-hidden rounded-md border bg-background">
        <div
          className={`${MEMBER_ROW_GRID} border-b bg-muted/40 px-3 py-2 text-xs font-semibold text-muted-foreground`}
        >
          <span className="text-center">
            {t('common.fields.username', 'Username')}
          </span>
          <span className="text-center">
            {t('common.fields.status', 'Status')}
          </span>
          <span className="text-center">
            {t('common.fields.provider', 'Provider')}
          </span>
          <span className="text-center">
            {t('common.fields.lastLoginAt', 'Last Login')}
          </span>
          <span />
        </div>
        {members.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">
            {t(
              'userManagement.noMembers',
              'No members. Add local users to this group.'
            )}
          </div>
        ) : (
          members.map((member) => (
            <div
              key={member.username}
              className={`${MEMBER_ROW_GRID} border-b px-3 py-2 text-sm last:border-b-0`}
            >
              <div className="flex min-w-0 items-center justify-center gap-2">
                <span className="truncate font-medium">{member.username}</span>
                {member.displayName && (
                  <span className="truncate text-xs text-muted-foreground">
                    {member.displayName}
                  </span>
                )}
              </div>
              <div className="flex justify-center">
                <Badge
                  variant={member.enabled === false ? 'secondary' : 'default'}
                  className="text-xs"
                >
                  {member.enabled === false
                    ? t('status.disabled', 'Disabled')
                    : t('status.enabled', 'Enabled')}
                </Badge>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-1">
                <span className="text-xs text-muted-foreground">
                  {member.provider || '-'}
                </span>
                {!isNative(member.provider) &&
                  (isLocalMembership(member) ? (
                    <Badge variant="outline" className="text-[10px]">
                      {t('userManagement.memberSourceLocal', 'Added locally')}
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="text-[10px]">
                      {t(
                        'userManagement.memberSourceDirectory',
                        'From directory'
                      )}
                    </Badge>
                  ))}
              </div>
              <span className="text-center text-xs text-muted-foreground">
                {member.lastLoginAt ? formatDate(member.lastLoginAt) : '-'}
              </span>
              <div className="flex justify-center">
                {isLocalMembership(member) ? (
                  !readOnly && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground hover:text-destructive"
                      disabled={isMutating}
                      aria-label={`${t('userManagement.removeMember', 'Remove')} ${member.username}`}
                      onClick={() =>
                        void handleRemoveMember(group.name, member)
                      }
                    >
                      <IconX className="h-3.5 w-3.5" />
                    </Button>
                  )
                ) : (
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
            </div>
          ))
        )}
      </div>
    )
  }

  const emptyState = (() => {
    if (isLoading) {
      return (
        <div className="flex items-center justify-center py-8">
          <div className="text-muted-foreground">
            {t('common.messages.loading', 'Loading...')}
          </div>
        </div>
      )
    }
    if (groups.length === 0) {
      return (
        <div className="py-8 text-center text-muted-foreground">
          <IconUsers className="mx-auto mb-4 h-12 w-12 opacity-50" />
          <p>
            {t(
              'userManagement.groupsEmpty',
              'No groups found. Groups come from LDAP / OIDC sync or user profiles.'
            )}
          </p>
        </div>
      )
    }
    return null
  })()

  return (
    <div>
      <Card>
        {activeGroup ? (
          <>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="-ml-2 gap-2 text-muted-foreground"
                    onClick={() => setDetailGroupName(null)}
                  >
                    <IconArrowLeft className="h-4 w-4" />
                    {t('common.actions.backToList', '返回列表')}
                  </Button>
                  <CardTitle className="flex flex-wrap items-center gap-2">
                    <IconUsers className="h-5 w-5" />
                    <span className="min-w-0 truncate">{activeGroup.name}</span>
                    <Badge
                      variant={
                        activeGroup.source === 'local' ? 'outline' : 'secondary'
                      }
                      className="text-xs"
                    >
                      {activeGroup.source === 'local'
                        ? t('userManagement.groupSourceLocal', 'Local')
                        : activeGroup.source.toUpperCase()}
                    </Badge>
                  </CardTitle>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm text-muted-foreground">
                      {activeGroup.description ||
                        t(
                          'userManagement.noGroupDescription',
                          'No description yet.'
                        )}
                    </p>
                    {!readOnly && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1.5 px-2 text-xs"
                        onClick={() => {
                          setDescriptionValue(activeGroup.description)
                          setShowDescription(true)
                        }}
                      >
                        <IconNotes className="h-3.5 w-3.5" />
                        {t(
                          'userManagement.editGroupDescription',
                          'Edit description'
                        )}
                      </Button>
                    )}
                  </div>
                </div>
                {!readOnly && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-2"
                      disabled={isMutating}
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
                      className="gap-2"
                      // 目录同步过来的组（LDAP / OIDC）不能在控制台改名：
                      // 改了下次登录或同步就会被目录里的名字覆盖，还会留下两边不一致的组。
                      disabled={activeGroup.source !== 'local'}
                      title={
                        activeGroup.source === 'local'
                          ? undefined
                          : t(
                              'userManagement.renameDirectoryGroupHint',
                              'Groups synced from the directory can only be renamed there; a rename here would be overwritten by the next sync.'
                            )
                      }
                      onClick={() => {
                        setRenameValue(activeGroup.name)
                        setShowRename(true)
                      }}
                    >
                      <IconPencil className="h-4 w-4" />
                      {t('userManagement.renameGroup', 'Rename group')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-2 text-destructive"
                      onClick={() => setShowDelete(true)}
                    >
                      <IconTrash className="h-4 w-4" />
                      {t('common.actions.delete', 'Delete')}
                    </Button>
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <IconShieldCheck className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="text-muted-foreground">
                    {t('userManagement.grantedRoles', 'Granted roles')}
                  </span>
                  {grantedRoles.length === 0 ? (
                    <span className="text-muted-foreground">
                      {t('userManagement.noGrantedRoles', 'None')}
                    </span>
                  ) : (
                    grantedRoles.map((role) => (
                      <Badge
                        key={role.name}
                        variant="outline"
                        className="text-xs"
                      >
                        {role.name}
                      </Badge>
                    ))
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {t(
                    'userManagement.groupsInheritHint',
                    'Members inherit the roles granted to this group in RBAC management.'
                  )}
                </p>
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <IconUsers className="h-4 w-4" />
                  {t('userManagement.members', 'Members')}
                  <Badge variant="secondary" className="text-xs">
                    {memberCount(activeGroup)}
                  </Badge>
                </div>
                {renderMembers(activeGroup)}
              </div>
            </CardContent>
          </>
        ) : (
          <>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <IconUsers className="h-5 w-5" />
                  {t('userManagement.groupsTabTitle', 'User Groups')}
                  <Badge variant="secondary">{groups.length}</Badge>
                </CardTitle>
                <div className="flex flex-wrap items-center justify-end gap-3">
                  {sourceOptions.length > 0 && sourceColumn && (
                    <Select
                      value={(sourceColumn.getFilterValue() as string) || 'all'}
                      onValueChange={(value) =>
                        sourceColumn.setFilterValue(
                          value === 'all' ? '' : value
                        )
                      }
                    >
                      <SelectTrigger className="w-40">
                        <SelectValue
                          placeholder={t(
                            'common.values.allSources',
                            'All sources'
                          )}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">
                          {t('common.values.allSources', 'All sources')}
                        </SelectItem>
                        {sourceOptions.map((source) => (
                          <SelectItem key={source} value={source}>
                            {source === 'local'
                              ? t('userManagement.groupSourceLocal', 'Local')
                              : source.toUpperCase()}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <div className="relative">
                    <IconSearch className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      placeholder={t(
                        'common.placeholders.searchGroups',
                        'Search user groups...'
                      )}
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      className="pl-9 w-64"
                    />
                  </div>
                  {!readOnly && (
                    <Button
                      className="gap-2"
                      onClick={() => {
                        setNewGroupName('')
                        setNewGroupDescription('')
                        setNewGroupMembers([])
                        setShowAddGroup(true)
                      }}
                    >
                      <IconPlus className="h-4 w-4" />
                      {t('userManagement.addGroup', 'Add User Group')}
                    </Button>
                  )}
                  {/* 与资源列表一致：最右侧的齿轮菜单用来勾选要显示的列。 */}
                  <TableColumnToggle table={table} />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <ResourceTableView
                table={table}
                columnCount={columns.length}
                isLoading={isLoading}
                data={filtered}
                allPageSize={filtered.length}
                emptyState={emptyState}
                hasActiveFilters={Boolean(search) || columnFilters.length > 0}
                filteredRowCount={table.getFilteredRowModel().rows.length}
                totalRowCount={groups.length}
                searchQuery={search}
                pagination={pagination}
                setPagination={setPagination}
                maxBodyHeightClassName="max-h-[600px]"
              />
            </CardContent>
          </>
        )}
      </Card>

      {showAddGroup && (
        <Dialog open onOpenChange={addGroupGuard.handleOpenChange}>
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
                <Label htmlFor="group-description">
                  {t('userManagement.groupDescription', 'Description')}
                </Label>
                <Textarea
                  id="group-description"
                  value={newGroupDescription}
                  onChange={(e) => setNewGroupDescription(e.target.value)}
                  placeholder={t(
                    'userManagement.groupDescriptionPlaceholder',
                    'Enter a description (optional)'
                  )}
                  rows={2}
                  disabled={isCreating}
                />
              </div>
              <div className="space-y-2">
                <Label>
                  {t('userManagement.membersOptional', 'Members (optional)')}
                </Label>
                <MultiSelect
                  value={newGroupMembers}
                  onChange={setNewGroupMembers}
                  options={memberUserOptions}
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
                onClick={() => addGroupGuard.handleOpenChange(false)}
                disabled={isCreating}
              >
                {t('common.actions.cancel', 'Cancel')}
              </Button>
              <Button
                onClick={() => void handleCreateGroup()}
                disabled={readOnly || isCreating || !newGroupName.trim()}
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

      {showAddMember && activeGroup && (
        <Dialog open onOpenChange={addMemberGuard.handleOpenChange}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>
                {t('userManagement.addMemberTitle', {
                  name: activeGroup.name,
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
                onClick={() => addMemberGuard.handleOpenChange(false)}
                disabled={isMutating}
              >
                {t('common.actions.cancel', 'Cancel')}
              </Button>
              <Button
                onClick={() => void handleAddMembers()}
                disabled={
                  readOnly || addMemberSelection.length === 0 || isMutating
                }
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
      {showRename && activeGroup && (
        <Dialog open onOpenChange={renameGuard.handleOpenChange}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>
                {t('userManagement.renameGroupTitle', {
                  name: activeGroup.name,
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
                onClick={() => renameGuard.handleOpenChange(false)}
                disabled={isMutating}
              >
                {t('common.actions.cancel', 'Cancel')}
              </Button>
              <Button
                onClick={() => void handleRenameGroup()}
                disabled={
                  readOnly ||
                  isMutating ||
                  !renameValue.trim() ||
                  renameValue.trim() === activeGroup.name
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

      {showDescription && activeGroup && (
        <Dialog open onOpenChange={descriptionGuard.handleOpenChange}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>
                {t('userManagement.editGroupDescriptionTitle', {
                  name: activeGroup.name,
                  defaultValue: 'Edit the description of {{name}}',
                })}
              </DialogTitle>
              <DialogDescription>
                {t(
                  'userManagement.editGroupDescriptionHint',
                  'The description is a console note: it does not affect authorization and is not synced from the directory.'
                )}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="group-description-edit">
                {t('userManagement.groupDescription', 'Description')}
              </Label>
              <Textarea
                id="group-description-edit"
                value={descriptionValue}
                onChange={(e) => setDescriptionValue(e.target.value)}
                placeholder={t(
                  'userManagement.groupDescriptionPlaceholder',
                  'Enter a description (optional)'
                )}
                rows={3}
                disabled={isMutating}
              />
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => descriptionGuard.handleOpenChange(false)}
                disabled={isMutating}
              >
                {t('common.actions.cancel', 'Cancel')}
              </Button>
              <Button
                onClick={() => void handleUpdateDescription()}
                disabled={readOnly || isMutating}
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

      {showDelete && activeGroup && (
        <DeleteConfirmationDialog
          open
          onOpenChange={(open) => !open && setShowDelete(false)}
          resourceName={activeGroup.name}
          resourceType={t('userManagement.groupType', 'user group')}
          isDeleting={isMutating}
          onConfirm={() => void handleDeleteGroup()}
          additionalNote={t('userManagement.deleteGroupImpact', {
            members: activeGroup.editableMembers.length,
            external: activeGroup.externalMembers.length,
            grants: grantedRoles.length,
            defaultValue:
              '{{members}} local member(s) will be removed from this group, {{external}} external reference(s) and {{grants}} RBAC role grant(s) will be deleted.',
          })}
        />
      )}

      <UnsavedChangesConfirmDialog {...addGroupGuard.confirmDialogProps} />
      <UnsavedChangesConfirmDialog {...addMemberGuard.confirmDialogProps} />
      <UnsavedChangesConfirmDialog {...renameGuard.confirmDialogProps} />
      <UnsavedChangesConfirmDialog {...descriptionGuard.confirmDialogProps} />
    </div>
  )
}

export default UserGroupsTab
