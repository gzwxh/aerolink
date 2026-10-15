import { useCallback, useMemo, useState } from 'react'
import { useSettingsSectionAccess } from '@/contexts/settings-section-context'
import { IconPlus, IconTrash } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import {
  fetchBindingGroups,
  fetchKnownGroups,
  fetchUserList,
  setBindingGroupMembers,
  useRoleList,
  type BindingGroup,
} from '@/lib/api'
import { ApiError } from '@/lib/api-client'
import { systemRoleLabel } from '@/lib/system-roles'
import {
  useDraftDirty,
  useUnsavedChangesGuard,
} from '@/hooks/use-unsaved-changes-guard'
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { MultiSelect } from '@/components/multi-select'
import { UnsavedChangesConfirmDialog } from '@/components/unsaved-changes-confirm-dialog'

// 成员候选来自系统用户列表，分页拉取一次取全（与权限绑定页一致）。
const MEMBER_PAGE_SIZE = 500

interface MemberPayload {
  subjectType: 'user' | 'group'
  subject: string
  namespace: string
  roleIds: number[]
}

interface MemberRow {
  key: string
  subjectType: 'user' | 'group'
  subject: string
  roleLabels: string[]
  protected: boolean
}

const memberKey = (subjectType: string, subject: string) =>
  `${subjectType}:${subject}`

/** 添加弹窗里选中的主体：用户与用户组都可以。 */
type SelectedSubject = Pick<MemberPayload, 'subjectType' | 'subject'>

// 后端对职责分离冲突只回机器码（role_conflict），这里翻译成能看懂的原因。
function describeError(t: TFunction, err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.code === 'role_conflict' || err.status === 409) {
      return t(
        'consoleRoles.roleConflict',
        '该变更会让某个账号同时持有互斥的管理员角色（职责分离冲突），请先调整其角色后再试。'
      )
    }
    if (err.message) return err.message
  }
  return fallback
}

/** 三个页签各自的文案兜底（i18n 缺键时使用）。 */
const PAGE_DEFAULTS = {
  admin: {
    title: '系统管理员',
    member: '管理员',
    description:
      '维护「系统管理员」与「只读管理员」两个控制台角色：系统管理员拥有全部集群与全部设置章节；只读管理员只能只读查看全部资源（不含 secrets）与控制台。两者的规则都由代码维护，因此只能在这里增删成员，不能改权限。',
    add: '添加管理员',
    addDescription:
      '选择用户或用户组并指定角色：系统管理员拥有全部权限，只读管理员只有只读权限。',
  },
  auditor: {
    title: '审计管理员',
    member: '审计管理员',
    description:
      '维护「审计管理员」角色：成员只能查看审计日志，并配置审计记录的保留策略与 syslog 外发；审计记录本身只读，没有任何手工删除入口。',
    add: '添加审计管理员',
    addDescription: '选中的用户或用户组将获得审计管理员（auditor）角色。',
  },
  securityAdmin: {
    title: '安全管理员',
    member: '安全管理员',
    description:
      '维护「安全管理员」角色：成员负责身份与授权（用户与用户组、角色与权限绑定、安全策略、认证源）以及集群里的主体与授权对象，不碰业务资源与审计日志。',
    add: '添加安全管理员',
    addDescription:
      '选中的用户或用户组将获得安全管理员（security-admin）角色。',
  },
} as const

type ConsoleRolePage = keyof typeof PAGE_DEFAULTS

interface ConsoleRoleMembersProps {
  /** 页签标识，同时作为 i18n 键前缀（consoleRoles.<page>.*）。 */
  page: ConsoleRolePage
  /** 本页维护的内置角色名（后端 roles.name）。 */
  roleNames: string[]
  /**
   * 添加时是否让用户选择角色。多角色页（「系统管理员」= 系统管理员 + 只读管理员）
   * 需要选择；单角色页直接用本页角色。
   */
  selectRole?: boolean
}

/**
 * 控制台角色成员页：维护受保护全局组（「超级权限绑定」）里持有本页角色的成员。
 *
 * 这些内置角色（系统管理员 / 只读管理员 / 审计管理员 / 安全管理员）的规则由代码维护，
 * 因此在「权限绑定」里不可选，只能在这里增删成员。超级管理员是**控制台级别**的概念，
 * 不跟随顶栏所选集群：这里取全部集群的权限绑定组，收敛成一份全局名单；保存时把同一份
 * 变更逐份写入每个受保护组（各集群各有一份同名组，都是全局作用域）。
 */
export function ConsoleRoleMembers({
  page,
  roleNames,
  selectRole = false,
}: ConsoleRoleMembersProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  // 只读章节（只有 settings.rbac 的读权限）时不渲染任何写入口。
  const { readOnly } = useSettingsSectionAccess()
  const { data: roles = [] } = useRoleList()

  const text = PAGE_DEFAULTS[page]
  const pageTitle = t(`consoleRoles.${page}.title`, text.title)
  const pageMember = t(`consoleRoles.${page}.member`, text.member)

  const [addOpen, setAddOpen] = useState(false)
  const [selectedUsers, setSelectedUsers] = useState<string[]>([])
  const [selectedGroups, setSelectedGroups] = useState<string[]>([])
  const [selectedRoleNames, setSelectedRoleNames] = useState<string[]>([])
  const [removal, setRemoval] = useState<MemberRow | null>(null)

  // 不带 cluster 查询：拉全部集群的权限绑定组，由前端收敛成全局名单。
  // 查询键刻意不用字符串（避免与权限绑定页的「集群名」键碰撞），但仍以 binding-groups
  // 开头，这样两处的失效逻辑都能覆盖到它。
  const {
    data: allGroups = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ['binding-groups', { global: true }],
    queryFn: () => fetchBindingGroups(),
  })

  const superGroups = useMemo(
    () => allGroups.filter((group) => group.protected === true),
    [allGroups]
  )

  // 本页维护的角色（按后端定义的顺序），用于过滤成员行、添加时的角色选择与保存。
  const pageRoles = useMemo(
    () => roles.filter((role) => roleNames.includes(role.name)),
    [roles, roleNames]
  )
  const pageRoleIds = useMemo(
    () => pageRoles.map((role) => role.id),
    [pageRoles]
  )

  // 「添加成员」弹窗打开时会把下面的选择重置成这份默认值，所以草稿基线取它，
  // 而不是组件首次渲染的空值（弹窗常驻挂载，基线不跟着 open 走）。
  const defaultAddRoleNames = useMemo(() => {
    if (!selectRole) return pageRoles.map((role) => role.name)
    const preferred = pageRoles.find((role) => role.name === 'admin')
    return preferred
      ? [preferred.name]
      : pageRoles.slice(0, 1).map((role) => role.name)
  }, [selectRole, pageRoles])

  // 添加成员弹窗的草稿：选中用户 / 用户组 / 角色；有改动时先确认再关闭。
  const isAddDirty = useDraftDirty(
    {
      users: selectedUsers,
      groups: selectedGroups,
      roles: selectedRoleNames,
    },
    { users: [], groups: [], roles: defaultAddRoleNames }
  )
  // 原有的关闭动作除了收起弹窗，还会清空选中项，这里一并保留。
  const closeAdd = useCallback(() => {
    setAddOpen(false)
    setSelectedUsers([])
    setSelectedGroups([])
  }, [])
  const addGuard = useUnsavedChangesGuard({
    dirty: isAddDirty,
    onClose: closeAdd,
  })

  // 同一主体可能有多行（每行一个角色），按主体合并成表格里的一条；
  // 多个集群的「超级权限绑定」也在这里合并成一份全局名单。
  const rows = useMemo(() => {
    const merged = new Map<string, MemberRow>()
    for (const group of superGroups) {
      for (const member of group.members ?? []) {
        if (!pageRoleIds.includes(member.roleId)) continue
        const key = memberKey(member.subjectType, member.subject)
        const label = member.role
          ? systemRoleLabel(t, member.role)
          : `#${member.roleId}`
        const existing = merged.get(key)
        if (existing) {
          if (!existing.roleLabels.includes(label))
            existing.roleLabels.push(label)
          existing.protected = existing.protected || member.protected === true
        } else {
          merged.set(key, {
            key,
            subjectType: member.subjectType,
            subject: member.subject,
            roleLabels: [label],
            protected: member.protected === true,
          })
        }
      }
    }
    return [...merged.values()].sort((a, b) =>
      a.subject.localeCompare(b.subject)
    )
  }, [superGroups, pageRoleIds, t])

  // 已经持有本页角色的主体（用户与用户组只按主体去重，与已有行为一致）。
  const existingSubjects = useMemo(() => {
    const users = new Set<string>()
    const groups = new Set<string>()
    for (const group of superGroups) {
      for (const member of group.members ?? []) {
        if (!pageRoleIds.includes(member.roleId)) continue
        if (member.subjectType === 'group') {
          groups.add(member.subject)
        } else {
          users.add(member.subject)
        }
      }
    }
    return { user: users, group: groups }
  }, [superGroups, pageRoleIds])

  // 只在打开「添加」时拉全量用户与用户组，避免每次进入本页都多一轮请求。
  const { data: userOptions = [] } = useQuery({
    queryKey: ['console-role-user-options'],
    queryFn: async () => {
      const collected: string[] = []
      for (let index = 1; ; index++) {
        const res = await fetchUserList(index, MEMBER_PAGE_SIZE, '')
        const users = res.users || []
        collected.push(...users.map((user) => user.username))
        if (collected.length >= res.total || users.length === 0) break
      }
      return collected.sort((a, b) => a.localeCompare(b))
    },
    enabled: addOpen,
  })
  const { data: groupOptions = [] } = useQuery({
    queryKey: ['console-role-group-options'],
    queryFn: async () =>
      (await fetchKnownGroups()).sort((a, b) => a.localeCompare(b)),
    enabled: addOpen,
  })

  const candidateUsers = userOptions.filter(
    (name) => !existingSubjects.user.has(name)
  )
  const candidateGroups = groupOptions.filter(
    (name) => !existingSubjects.group.has(name)
  )

  // 角色选择器用展示名（系统管理员 / 只读管理员）作选项值：MultiSelect 只接受字符串选项，
  // 这里在展示名与角色名之间来回映射，状态里存的始终是角色名。
  const roleLabelOf = (name: string) =>
    systemRoleLabel(t, { name, isSystem: true })
  const roleNameOfLabel = (label: string) =>
    pageRoles.find((role) => roleLabelOf(role.name) === label)?.name

  const saveMutation = useMutation({
    mutationFn: async ({
      removedKeys,
      addedSubjects,
      addedRoleIds,
    }: {
      removedKeys: Set<string>
      addedSubjects: SelectedSubject[]
      addedRoleIds: number[]
    }) => {
      // 这些角色是全局的：同一份变更逐份写入每个集群的「超级权限绑定」组，
      // 否则改动只落在其中一个集群，换集群后看起来就像丢了人。
      for (const group of superGroups) {
        await setBindingGroupMembers(
          group.id,
          buildMembers(group, removedKeys, addedSubjects, addedRoleIds)
        )
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['binding-groups'] })
      toast.success(t('consoleRoles.saved', '已更新'))
      closeAdd()
      setRemoval(null)
    },
    onError: (err: unknown) =>
      toast.error(
        describeError(t, err, t('consoleRoles.saveFailed', '保存失败'))
      ),
  })

  // setBindingGroupMembers 是全量替换，所以提交的是「该组完整成员名单」：
  //   - 其它页签维护的角色行原样保留；
  //   - 本页角色里被移除的主体整行去掉；
  //   - 新加的用户 / 用户组按所选角色补行。
  // 受保护成员（初始化创建的超级管理员）由后端按快照恢复，这里一并带上，
  // 避免请求变成空列表被拒。
  const buildMembers = (
    group: BindingGroup,
    removedKeys: Set<string>,
    addedSubjects: SelectedSubject[],
    addedRoleIds: number[]
  ): MemberPayload[] => {
    const members: MemberPayload[] = []
    const seen = new Set<string>()
    for (const member of group.members ?? []) {
      const key = memberKey(member.subjectType, member.subject)
      if (pageRoleIds.includes(member.roleId) && removedKeys.has(key)) continue
      members.push({
        subjectType: member.subjectType,
        subject: member.subject,
        namespace: member.namespace ?? '',
        roleIds: [member.roleId],
      })
      seen.add(`${key}#${member.roleId}`)
    }
    for (const { subjectType, subject } of addedSubjects) {
      const key = memberKey(subjectType, subject)
      for (const roleId of addedRoleIds) {
        if (seen.has(`${key}#${roleId}`)) continue
        seen.add(`${key}#${roleId}`)
        members.push({
          subjectType,
          subject,
          // 空作用域 = 该组覆盖的全部命名空间（全局组的成员即全集群生效）。
          namespace: '',
          roleIds: [roleId],
        })
      }
    }
    return members
  }

  const openAdd = () => {
    setSelectedUsers([])
    setSelectedGroups([])
    // 多角色页默认选系统管理员（列表第一个不一定是它）。
    setSelectedRoleNames(defaultAddRoleNames)
    setAddOpen(true)
  }

  const handleAdd = () => {
    const addedSubjects: SelectedSubject[] = [
      ...selectedUsers.map((subject) => ({
        subjectType: 'user' as const,
        subject,
      })),
      ...selectedGroups.map((subject) => ({
        subjectType: 'group' as const,
        subject,
      })),
    ]
    if (addedSubjects.length === 0) return
    const addedRoleIds = pageRoles
      .filter((role) => selectedRoleNames.includes(role.name))
      .map((role) => role.id)
    if (addedRoleIds.length === 0) return
    saveMutation.mutate({
      removedKeys: new Set(),
      addedSubjects,
      addedRoleIds,
    })
  }

  const handleRemove = () => {
    if (!removal) return
    saveMutation.mutate({
      removedKeys: new Set([removal.key]),
      addedSubjects: [],
      addedRoleIds: [],
    })
  }

  if (isLoading) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        {t('common.messages.loading', '加载中...')}
      </div>
    )
  }

  if (error) {
    return (
      <div className="py-8 text-center text-sm text-destructive">
        {t('consoleRoles.loadFailed', '加载角色成员失败，请稍后重试。')}
      </div>
    )
  }

  if (superGroups.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        {t(
          'consoleRoles.groupMissing',
          '系统里还没有系统维护的超级权限绑定，通常由服务端在启动时自动创建。'
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{pageTitle}</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              {t('bindingGroup.globalBadge', '全局')}
            </span>
            <Badge variant="secondary">
              {t('consoleRoles.protectedBadge', '系统维护')}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {t(`consoleRoles.${page}.description`, text.description)}
          </p>
          <p className="text-xs text-muted-foreground">
            {t(
              'consoleRoles.globalHint',
              '全局生效：与顶栏所选集群无关，这里的增删对所有集群都生效。'
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            {t(
              'consoleRoles.notBindableHint',
              '这些内置角色不在「权限绑定」里分配，只能在这里维护。'
            )}
          </p>
        </div>
        {!readOnly && (
          <Button onClick={openAdd} disabled={pageRoles.length === 0}>
            <IconPlus className="h-4 w-4" />
            {t(`consoleRoles.${page}.add`, text.add)}
          </Button>
        )}
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('consoleRoles.subject', '主体')}</TableHead>
              <TableHead>{t('consoleRoles.role', '角色')}</TableHead>
              <TableHead className="w-16">
                {t('common.actions.actions', '操作')}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={3}
                  className="text-center text-muted-foreground"
                >
                  {t('consoleRoles.empty', '暂无成员')}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={row.key}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="font-medium" title={row.subject}>
                        {row.subject}
                      </span>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        {row.subjectType === 'group'
                          ? t('consoleRoles.subjectGroup', '用户组')
                          : t('consoleRoles.subjectUser', '用户')}
                      </span>
                      {row.protected && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge variant="secondary">
                              {t('consoleRoles.memberProtected', '受保护')}
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent
                            side="top"
                            className="max-w-80 whitespace-normal border bg-popover text-xs text-popover-foreground shadow-md"
                          >
                            {t(
                              'consoleRoles.memberProtectedHint',
                              '初始化创建的超级管理员不能被移出；如需收回权限可以停用该账号（在用户管理页）。'
                            )}
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <span
                      className="text-sm"
                      title={row.roleLabels.join(' / ')}
                    >
                      {row.roleLabels.join(' / ')}
                    </span>
                  </TableCell>
                  <TableCell>
                    {readOnly || row.protected ? (
                      <span className="text-muted-foreground">-</span>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('consoleRoles.remove', '移除')}
                        onClick={() => setRemoval(row)}
                      >
                        <IconTrash className="h-4 w-4 text-destructive" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={addOpen} onOpenChange={addGuard.handleOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t(`consoleRoles.${page}.add`, text.add)}</DialogTitle>
            <DialogDescription>
              {t(`consoleRoles.${page}.addDescription`, text.addDescription)}
            </DialogDescription>
          </DialogHeader>

          <MultiSelect
            label={t('consoleRoles.selectUsers', '选择用户')}
            options={candidateUsers}
            value={selectedUsers}
            onChange={setSelectedUsers}
            selectAllMode="all"
            allowAdd={false}
            placeholder={t('consoleRoles.selectUsers', '选择用户')}
            emptyText={t('consoleRoles.noUsers', '暂无用户')}
          />

          <MultiSelect
            label={t('consoleRoles.selectGroups', '选择用户组')}
            options={candidateGroups}
            value={selectedGroups}
            onChange={setSelectedGroups}
            selectAllMode="all"
            allowAdd={false}
            placeholder={t('consoleRoles.selectGroups', '选择用户组')}
            emptyText={t('consoleRoles.noGroups', '暂无用户组')}
          />

          {selectRole && (
            <MultiSelect
              label={t('consoleRoles.selectRoles', '角色')}
              options={pageRoles.map((role) => roleLabelOf(role.name))}
              value={selectedRoleNames.map(roleLabelOf)}
              onChange={(labels) =>
                setSelectedRoleNames(
                  labels
                    .map(roleNameOfLabel)
                    .filter((name): name is string => !!name)
                )
              }
              selectAllMode="all"
              allowAdd={false}
              placeholder={t('consoleRoles.selectRoles', '角色')}
            />
          )}

          <DialogFooter>
            <Button
              variant="outline"
              disabled={saveMutation.isPending}
              onClick={() => addGuard.handleOpenChange(false)}
            >
              {t('common.actions.cancel', '取消')}
            </Button>
            <Button
              onClick={handleAdd}
              disabled={
                (selectedUsers.length === 0 && selectedGroups.length === 0) ||
                pageRoles.length === 0 ||
                saveMutation.isPending
              }
            >
              {t(`consoleRoles.${page}.add`, text.add)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <UnsavedChangesConfirmDialog {...addGuard.confirmDialogProps} />

      <Dialog
        open={!!removal}
        onOpenChange={(open) => {
          if (!open) setRemoval(null)
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t('consoleRoles.removeTitle', '移除{{member}}', {
                member: pageMember,
              })}
            </DialogTitle>
            <DialogDescription>
              {t(
                'consoleRoles.removeDescription',
                '移除「{{subject}}」后，该主体将不再拥有{{member}}权限。',
                { subject: removal?.subject ?? '', member: pageMember }
              )}
            </DialogDescription>
          </DialogHeader>

          <DialogFooter>
            <Button
              variant="outline"
              disabled={saveMutation.isPending}
              onClick={() => setRemoval(null)}
            >
              {t('common.actions.cancel', '取消')}
            </Button>
            <Button
              variant="destructive"
              disabled={saveMutation.isPending}
              onClick={handleRemove}
            >
              {t('consoleRoles.remove', '移除')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** 系统管理员页：系统管理员（admin）+ 只读管理员（viewer）。 */
export function AdministratorManagement() {
  return (
    <ConsoleRoleMembers
      page="admin"
      roleNames={['admin', 'viewer']}
      selectRole
    />
  )
}

/** 审计管理员（auditor）。 */
export function AuditorManagement() {
  return <ConsoleRoleMembers page="auditor" roleNames={['auditor']} />
}

/** 安全管理员（security-admin）。 */
export function SecurityAdminManagement() {
  return (
    <ConsoleRoleMembers page="securityAdmin" roleNames={['security-admin']} />
  )
}
