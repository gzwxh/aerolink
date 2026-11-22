import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { useSettingsSectionAccess } from '@/contexts/settings-section-context'
import {
  IconArrowLeft,
  IconArrowsSort,
  IconDotsVertical,
  IconPencil,
  IconPlugConnected,
  IconPlus,
  IconSearch,
  IconSortAscending,
  IconSortDescending,
  IconTrash,
} from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

import {
  bindBindingGroup,
  createBindingGroup,
  createBindingGroupNamespace,
  deleteBindingGroup,
  ensureBindingGroupDefaults,
  fetchAllGroupMembers,
  fetchBindingGroups,
  fetchClusterNamespaces,
  fetchKnownGroups,
  fetchUserList,
  setBindingGroupMembers,
  setBindingGroupNamespaces,
  updateBindingGroup,
  useClusterList,
  useRoleList,
  type BindingGroup,
} from '@/lib/api'
import { ApiError } from '@/lib/api-client'
import {
  isClusterRole,
  isProtectedRole,
  systemRoleDescription,
} from '@/lib/system-roles'
import { translateError } from '@/lib/utils'
import { useCluster } from '@/hooks/use-cluster'
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { DeleteConfirmationDialog } from '@/components/delete-confirmation-dialog'
import { TransferBox, type TransferItem } from '@/components/transfer-box'
import { UnsavedChangesConfirmDialog } from '@/components/unsaved-changes-confirm-dialog'

/** 详情页与新增页共用 URL：`?rbacTab=binding-groups&bindingGroup=<组名>` 进详情，
 * `&newBindingGroup=1` 进新增；两者都没有时停留在列表。 */
export const BINDING_GROUP_PARAM = 'bindingGroup'
export const BINDING_GROUP_NEW_PARAM = 'newBindingGroup'

// 列表里的角色 / 命名空间在内联展示时只露前几项，超出部分显示 +N，
// 鼠标悬停时弹出完整内容（角色还带上它的权限信息）。
const INLINE_LIMIT = 2

function bindingGroupRoles(group: BindingGroup): string[] {
  const names = new Set<string>()
  for (const member of group.members ?? []) {
    names.add(member.role?.name ?? `#${member.roleId}`)
  }
  return Array.from(names)
}

function RolesCell({ names }: { names: string[] }) {
  if (names.length === 0) {
    return <span className="text-muted-foreground">-</span>
  }
  const shown = names.slice(0, INLINE_LIMIT)
  const hidden = names.length - shown.length
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex max-w-56 cursor-default flex-wrap items-center gap-1">
          {shown.map((name) => (
            <span
              key={name}
              className="rounded bg-primary/10 px-1.5 py-0.5 text-xs"
            >
              {name}
            </span>
          ))}
          {hidden > 0 && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              +{hidden}
            </span>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        className="max-h-72 max-w-96 overflow-y-auto whitespace-normal border bg-popover text-xs text-popover-foreground shadow-md"
      >
        <div className="space-y-0.5">
          {names.map((name) => (
            <div key={name}>{name}</div>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

function NamespacesCell({ namespaces }: { namespaces: string[] }) {
  if (namespaces.length === 0) {
    return <span className="text-muted-foreground">-</span>
  }
  const shown = namespaces.slice(0, INLINE_LIMIT)
  const hidden = namespaces.length - shown.length
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex max-w-56 cursor-default flex-wrap items-center gap-1 text-sm text-muted-foreground">
          <span className="truncate">{shown.join(', ')}</span>
          {hidden > 0 && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
              +{hidden}
            </span>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        className="max-h-72 max-w-96 overflow-y-auto whitespace-normal border bg-popover text-xs text-popover-foreground shadow-md"
      >
        <div className="flex flex-wrap gap-1">
          {namespaces.map((namespace) => (
            <span
              key={namespace}
              className="rounded bg-muted px-1.5 py-0.5 text-foreground"
            >
              {namespace}
            </span>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

interface SubjectLine {
  key: string
  label: string
  members: string[]
  /** 该主体绑定的命名空间范围：空字符串代表「组内全部命名空间」。 */
  scopes: string[]
}

// 授权行里的范围写法：全部命名空间排序在前，其余按名称排序。
function sortScopes(scopes: string[]): string[] {
  return Array.from(new Set(scopes)).sort((a, b) => {
    if (a === b) return 0
    if (a === '') return -1
    if (b === '') return 1
    return a.localeCompare(b)
  })
}

// 主体展示：把「用户组」连同它覆盖的成员一起显示（用户组A：用户A 用户B），
// 并在后面附上该主体的命名空间范围（devops（全部/kube-public））；
// 已被某个已选用户组覆盖的用户不再单列，避免重复。
function bindingGroupSubjects(
  group: BindingGroup,
  groupMembers: Record<string, string[]>
): SubjectLine[] {
  const users = new Set<string>()
  const groups = new Set<string>()
  const scopes = new Map<string, string[]>()
  for (const member of group.members ?? []) {
    if (member.subjectType === 'group') {
      groups.add(member.subject)
    } else {
      users.add(member.subject)
    }
    // 同一主体可能有多行（每个命名空间范围一行），这里汇总去重。
    const key = `${member.subjectType}:${member.subject}`
    const current = scopes.get(key) ?? []
    current.push(member.namespace ?? '')
    scopes.set(key, current)
  }

  const lines: SubjectLine[] = []
  const covered = new Set<string>()
  for (const name of Array.from(groups).sort()) {
    const members = groupMembers[name] ?? []
    members.forEach((username) => covered.add(username))
    lines.push({
      key: `group:${name}`,
      label: name,
      members,
      scopes: sortScopes(scopes.get(`group:${name}`) ?? []),
    })
  }
  for (const name of Array.from(users)
    .filter((username) => !covered.has(username))
    .sort()) {
    lines.push({
      key: `user:${name}`,
      label: name,
      members: [],
      scopes: sortScopes(scopes.get(`user:${name}`) ?? []),
    })
  }
  return lines
}

// 列表里把范围压成一行：全部命名空间显示为「全部」，其余写命名空间名。
function SubjectScopes({ line }: { line: SubjectLine }) {
  const { t } = useTranslation()
  if (line.scopes.length === 0) return null
  return (
    <span className="text-muted-foreground">
      （
      {line.scopes
        .map((scope) =>
          scope === '' ? t('bindingGroup.scopeAllShort', '全部') : scope
        )
        .join('/')}
      ）
    </span>
  )
}

function SubjectsCell({ lines }: { lines: SubjectLine[] }) {
  if (lines.length === 0) {
    return <span className="text-muted-foreground">-</span>
  }
  const shown = lines.slice(0, INLINE_LIMIT)
  const hidden = lines.length - shown.length
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex max-w-56 cursor-default flex-col gap-0.5">
          {shown.map((line) => (
            <div key={line.key} className="text-sm">
              <span className={line.members.length > 0 ? 'font-medium' : ''}>
                {line.label}
              </span>
              <SubjectScopes line={line} />
              {line.members.length > 0 && (
                <span className="text-muted-foreground">
                  ：{line.members.join(' ')}
                </span>
              )}
            </div>
          ))}
          {hidden > 0 && (
            <span className="text-xs text-muted-foreground">+{hidden}</span>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        className="max-h-72 max-w-96 space-y-0.5 overflow-y-auto whitespace-normal border bg-popover text-xs text-popover-foreground shadow-md"
      >
        {lines.map((line) => (
          <div key={line.key}>
            <span className={line.members.length > 0 ? 'font-medium' : ''}>
              {line.label}
            </span>
            <SubjectScopes line={line} />
            {line.members.length > 0 && <span>：{line.members.join(' ')}</span>}
          </div>
        ))}
      </TooltipContent>
    </Tooltip>
  )
}

// 列表排序：点击表头在升序 / 降序之间切换，未排序的列给一个提示图标。
type SortColumn = 'name' | 'roles' | 'namespaces' | 'subjects'

function SortableHead({
  column,
  activeColumn,
  descending,
  onSort,
  className,
  children,
}: {
  column: SortColumn
  activeColumn: SortColumn | null
  descending: boolean
  onSort: (column: SortColumn) => void
  className?: string
  children: ReactNode
}) {
  const { t } = useTranslation()
  const active = activeColumn === column
  return (
    <TableHead
      className={className}
      aria-sort={active ? (descending ? 'descending' : 'ascending') : 'none'}
    >
      <button
        type="button"
        className={
          active
            ? 'text-primary inline-flex items-center gap-1'
            : 'hover:text-primary inline-flex items-center gap-1'
        }
        title={t('bindingGroup.sortHint', '点击排序')}
        onClick={() => onSort(column)}
      >
        {children}
        {active ? (
          descending ? (
            <IconSortDescending className="h-3.5 w-3.5" />
          ) : (
            <IconSortAscending className="h-3.5 w-3.5" />
          )
        ) : (
          <IconArrowsSort className="text-muted-foreground/60 h-3.5 w-3.5" />
        )}
      </button>
    </TableHead>
  )
}

// 列表一行：原始绑定 + 后面几列要用的派生值，搜索与排序都基于同一份。
interface BindingGroupRow {
  group: BindingGroup
  roleNames: string[]
  namespaceNames: string[]
  subjectLines: SubjectLine[]
}

// 排序值：按列取一个可比较的字符串，等值时保持原顺序（sort 稳定）。
function sortValueOf(row: BindingGroupRow, column: SortColumn): string {
  switch (column) {
    case 'roles':
      return row.roleNames.join(', ')
    case 'namespaces':
      return row.namespaceNames.join(', ')
    case 'subjects':
      return row.subjectLines.map((line) => line.label).join(', ')
    default:
      return row.group.name
  }
}

// 成员候选来自系统用户列表，分页拉取一次取全。
const MEMBER_PAGE_SIZE = 500

// 服务端会带上具体原因（同集群重名、命名空间已被占用等），直接展示比笼统的“失败”更有用。
function describeError(t: TFunction, err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    // 命名空间归属冲突不是重名：带上占用组，提示先去那边解绑。
    if (err.code === 'binding_group_namespace_taken') {
      const params = (err.params ?? {}) as {
        namespace?: string
        group?: string
      }
      return t('bindingGroup.nsConflictOnSave', {
        namespace: params.namespace ?? '',
        group: params.group ?? '',
        defaultValue:
          'Namespace {{namespace}} belongs to the permission binding "{{group}}". Unbind it there before saving.',
      })
    }
    if (err.status === 409) {
      return t(
        'bindingGroup.nameConflict',
        'The cluster already has a permission binding group with this name.'
      )
    }
    if (err.message) return err.message
  }
  return fallback
}

export function BindingGroupManagement() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data: clusters = [] } = useClusterList()
  const { currentCluster } = useCluster()
  const [showRetained, setShowRetained] = useState(false)
  // 列表的搜索词与排序列（列表是前端一次取全，都在本地算）。
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<{
    column: SortColumn
    descending: boolean
  } | null>(null)
  const [authorizationPromptClosed, setAuthorizationPromptClosed] =
    useState(false)
  const [promptSaving, setPromptSaving] = useState(false)
  const [bindingGroup, setBindingGroup] = useState<BindingGroup | null>(null)
  // 待删除的权限绑定：以前用原生 window.confirm，一次回车就能抹掉一个命名空间的
  // 全部授权（第 18 轮 D-149），现改成像其它删除那样输名字确认。
  const [deleteTarget, setDeleteTarget] = useState<BindingGroup | null>(null)
  const [searchParams, setSearchParams] = useSearchParams()
  // 列表 / 新增页 / 详情页由 URL 决定：刷新页面、浏览器后退都能回到同一处。
  const detailName = searchParams.get(BINDING_GROUP_PARAM)
  const creating = searchParams.get(BINDING_GROUP_NEW_PARAM) !== null
  // 只读章节（只有该章节的读权限）时不渲染任何写入口。
  const { readOnly } = useSettingsSectionAccess()

  // 权限绑定跟随顶栏集群上下文，不在页面内提供集群筛选。
  const effectiveCluster = currentCluster ?? undefined

  const { data: groups = [], isLoading } = useQuery({
    queryKey: ['binding-groups', effectiveCluster ?? 'all'],
    queryFn: () => fetchBindingGroups(effectiveCluster),
  })

  // 保留中的权限绑定：所属集群已删除、配置被保留，可重新绑定到集群。
  const { data: retainedGroups = [] } = useQuery({
    queryKey: ['binding-groups', 'detached'],
    queryFn: () => fetchBindingGroups(undefined, { detached: true }),
  })

  // 用户组 → 成员：主体列把「用户组」连同它覆盖的用户一起展示。
  const { data: groupMembers = {} } = useQuery({
    queryKey: ['group-members'],
    queryFn: fetchAllGroupMembers,
    staleTime: 60_000,
  })

  // 选中的集群下存在被保留的权限绑定（集群删除后又被重新导入）。
  const pendingForCluster = useMemo(() => {
    if (!effectiveCluster) return []
    return retainedGroups.filter((g) => g.cluster === effectiveCluster)
  }, [retainedGroups, effectiveCluster])

  const visibleRetained = useMemo(() => {
    if (!showRetained) return []
    return effectiveCluster ? pendingForCluster : retainedGroups
  }, [showRetained, effectiveCluster, pendingForCluster, retainedGroups])

  // 受保护的超级权限绑定由系统维护（没有删除入口），成员改由「管理员」页签管理，
  // 这里不再当成普通组列出。
  const rows = useMemo(
    () => [...groups, ...visibleRetained].filter((g) => !g.protected),
    [groups, visibleRetained]
  )

  // 表格各行用到的派生值算一次，搜索、排序与渲染共用。
  const decoratedRows = useMemo<BindingGroupRow[]>(
    () =>
      rows.map((group) => ({
        group,
        roleNames: bindingGroupRoles(group),
        namespaceNames: (group.namespaces ?? []).map((n) => n.namespace),
        subjectLines: bindingGroupSubjects(group, groupMembers),
      })),
    [rows, groupMembers]
  )

  const visibleRows = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    const matched = keyword
      ? decoratedRows.filter((row) =>
          [
            row.group.name,
            row.group.cluster,
            row.group.description ?? '',
            ...row.roleNames,
            ...row.namespaceNames,
            ...row.subjectLines.flatMap((line) => [
              line.label,
              ...line.members,
            ]),
          ].some((value) => value.toLowerCase().includes(keyword))
        )
      : decoratedRows
    if (!sort) return matched
    const direction = sort.descending ? -1 : 1
    return [...matched].sort(
      (a, b) =>
        sortValueOf(a, sort.column).localeCompare(sortValueOf(b, sort.column)) *
        direction
    )
  }, [decoratedRows, query, sort])

  // 点同一列切换升降序，点另一列从升序开始。
  const toggleSort = (column: SortColumn) =>
    setSort((prev) =>
      prev?.column === column
        ? { column, descending: !prev.descending }
        : { column, descending: false }
    )

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['binding-groups'] })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteBindingGroup(id),
    onSuccess: () => {
      toast.success(t('bindingGroup.deleted', '权限绑定已删除'))
      setDeleteTarget(null)
      invalidate()
    },
    onError: (err: unknown) => {
      toast.error(
        describeError(t, err, t('bindingGroup.deleteFailed', '删除失败'))
      )
      // 失败时也要收弹窗：错误原因已经在 toast 里，留着只会让人反复确认。
      setDeleteTarget(null)
    },
  })

  const bindMutation = useMutation({
    mutationFn: ({ id, cluster }: { id: number; cluster: string }) =>
      bindBindingGroup(id, cluster),
    onSuccess: (_res, vars) => {
      toast.success(
        t('bindingGroup.bound', '已绑定到集群 {{cluster}}', {
          cluster: vars.cluster,
        })
      )
      invalidate()
    },
    onError: (err: unknown) =>
      toast.error(
        describeError(t, err, t('bindingGroup.bindFailed', '绑定失败'))
      ),
  })

  const handleBindAll = async () => {
    if (!effectiveCluster) return
    for (const group of pendingForCluster) {
      try {
        await bindMutation.mutateAsync({
          id: group.id,
          cluster: effectiveCluster,
        })
      } catch {
        return
      }
    }
  }

  // 重新导入集群后，首次进入本页时提示如何处理上次删除集群时保留的授权配置。
  // 受保护的超级管理员组由服务端自动恢复，因此不计入需要决策的范围。
  const pendingAuthorization = useMemo(
    () => pendingForCluster.filter((group) => !group.protected),
    [pendingForCluster]
  )
  const showAuthorizationPrompt =
    !!effectiveCluster &&
    !authorizationPromptClosed &&
    pendingAuthorization.length > 0

  const handleAdoptAuthorization = async () => {
    if (!effectiveCluster) return
    setPromptSaving(true)
    try {
      for (const group of pendingForCluster) {
        await bindBindingGroup(group.id, effectiveCluster)
      }
      invalidate()
      toast.success(t('bindingGroup.authAdopted', '已沿用之前的授权配置'))
      setAuthorizationPromptClosed(true)
    } catch (err) {
      toast.error(
        describeError(t, err, t('bindingGroup.bindFailed', '绑定失败'))
      )
    } finally {
      setPromptSaving(false)
    }
  }

  const handleCreateDefaultAuthorization = async () => {
    if (!effectiveCluster) return
    setPromptSaving(true)
    try {
      // 先建内置默认授权（含超级管理员的超级权限绑定），再丢弃保留的自定义配置。
      await ensureBindingGroupDefaults(effectiveCluster)
      for (const group of pendingAuthorization) {
        await deleteBindingGroup(group.id)
      }
      invalidate()
      toast.success(t('bindingGroup.authDefaultsCreated', '已创建默认授权配置'))
      setAuthorizationPromptClosed(true)
    } catch (err) {
      toast.error(
        describeError(t, err, t('bindingGroup.saveFailed', '保存失败'))
      )
    } finally {
      setPromptSaving(false)
    }
  }

  // 新增页 / 详情页共用一个页面组件，只有 URL 参数不同。
  const openCreate = () => {
    const next = new URLSearchParams(searchParams)
    next.delete(BINDING_GROUP_PARAM)
    next.set(BINDING_GROUP_NEW_PARAM, '1')
    setSearchParams(next)
  }

  const openDetail = (name: string) => {
    const next = new URLSearchParams(searchParams)
    next.delete(BINDING_GROUP_NEW_PARAM)
    next.set(BINDING_GROUP_PARAM, name)
    setSearchParams(next)
  }

  const closeForm = () => {
    const next = new URLSearchParams(searchParams)
    next.delete(BINDING_GROUP_PARAM)
    next.delete(BINDING_GROUP_NEW_PARAM)
    setSearchParams(next)
  }

  // 详情页的数据源：列表里已有的该组（含保留中的绑定），找不到时页面自己提示。
  const activeGroup = detailName
    ? (rows.find((g) => g.name === detailName) ?? null)
    : null

  if (creating || detailName) {
    if (detailName && isLoading) {
      return (
        <div className="py-8 text-center text-sm text-muted-foreground">
          {t('common.messages.loading', '加载中...')}
        </div>
      )
    }
    return (
      <BindingGroupFormPage
        // 切换组时重建表单状态。
        key={detailName ?? 'new'}
        mode={detailName ? 'edit' : 'create'}
        cluster={effectiveCluster ?? clusters[0]?.name ?? ''}
        group={activeGroup}
        onClose={closeForm}
        onSaved={invalidate}
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {retainedGroups.length > 0 && (
            <Button
              variant={showRetained ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setShowRetained((prev) => !prev)}
            >
              {t('bindingGroup.showRetained', '保留的权限绑定（{{count}}）', {
                count: retainedGroups.length,
              })}
            </Button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <div className="relative">
            <IconSearch className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t(
                'bindingGroup.searchPlaceholder',
                '搜索名称、描述、角色、命名空间或主体'
              )}
              className="w-64 pl-9"
            />
          </div>
          {!readOnly && (
            <Button onClick={openCreate} disabled={clusters.length === 0}>
              <IconPlus className="h-4 w-4" />
              {t('bindingGroup.add', '添加')}
            </Button>
          )}
        </div>
      </div>

      {pendingForCluster.length > 0 && (
        <div className="flex items-start justify-between gap-3 rounded-md border border-warning/40 bg-warning/5 p-3">
          <div className="space-y-0.5 text-sm">
            <p className="font-medium">
              {t(
                'bindingGroup.retainedTitle',
                '集群 {{cluster}} 有 {{count}} 个保留的权限绑定',
                { cluster: effectiveCluster, count: pendingForCluster.length }
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {t(
                'bindingGroup.retainedHint',
                '绑定后沿用保留的授权；如需重新规划，不绑定并新建权限绑定即可。'
              )}
            </p>
          </div>
          {!readOnly && (
            <Button
              size="sm"
              onClick={() => void handleBindAll()}
              disabled={bindMutation.isPending}
            >
              <IconPlugConnected className="h-4 w-4" />
              {t('bindingGroup.bindAll', '全部绑定')}
            </Button>
          )}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {t(
          'bindingGroup.superManagedHint',
          '超级管理员的权限绑定由系统维护，不可删除；请到「管理员」页签查看和添加管理员。'
        )}
      </p>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableHead
                column="name"
                activeColumn={sort?.column ?? null}
                descending={sort?.descending ?? false}
                onSort={toggleSort}
              >
                {t('common.fields.name', '名称')}
              </SortableHead>
              <SortableHead
                column="roles"
                activeColumn={sort?.column ?? null}
                descending={sort?.descending ?? false}
                onSort={toggleSort}
              >
                {t('rbac.roles', '角色')}
              </SortableHead>
              <SortableHead
                column="namespaces"
                activeColumn={sort?.column ?? null}
                descending={sort?.descending ?? false}
                onSort={toggleSort}
              >
                Namespaces
              </SortableHead>
              <SortableHead
                column="subjects"
                activeColumn={sort?.column ?? null}
                descending={sort?.descending ?? false}
                onSort={toggleSort}
              >
                {t('bindingGroup.subjects', '主体')}
              </SortableHead>
              <TableHead className="w-16">
                {t('common.actions.actions', '操作')}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-center text-muted-foreground"
                >
                  {t('common.messages.loading', '加载中...')}
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-center text-muted-foreground"
                >
                  {t('bindingGroup.empty', '暂无权限绑定')}
                </TableCell>
              </TableRow>
            ) : visibleRows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-center text-muted-foreground"
                >
                  {t('bindingGroup.emptySearch', '没有匹配的权限绑定')}
                </TableCell>
              </TableRow>
            ) : (
              visibleRows.map((row) => {
                const g = row.group
                const { roleNames, namespaceNames, subjectLines } = row
                return (
                  <TableRow key={g.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          className="font-medium hover:text-primary hover:underline"
                          title={g.name}
                          onClick={() => openDetail(g.name)}
                        >
                          {g.name}
                        </button>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          {g.cluster}
                        </span>
                        {g.detached && (
                          <Badge
                            variant="outline"
                            className="border-warning/40 text-warning"
                          >
                            {t('bindingGroup.retainedBadge', '保留')}
                          </Badge>
                        )}
                        {/* 系统维护的「超级权限绑定」不在此列表（见上方说明与「管理员」
                            页签），因此这里只会出现普通的全局组。 */}
                        {g.global && (
                          <Badge variant="outline">
                            {t('bindingGroup.globalBadge', '全局')}
                          </Badge>
                        )}
                      </div>
                      {g.description && (
                        <div
                          className="text-xs text-muted-foreground"
                          title={g.description}
                        >
                          {g.description}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <RolesCell names={roleNames} />
                    </TableCell>
                    <TableCell>
                      <NamespacesCell namespaces={namespaceNames} />
                    </TableCell>
                    <TableCell>
                      <SubjectsCell lines={subjectLines} />
                    </TableCell>
                    <TableCell>
                      {!readOnly && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
                              <IconDotsVertical className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {g.detached && clusters.length > 0 && (
                              <DropdownMenuItem
                                onClick={() => setBindingGroup(g)}
                              >
                                <IconPlugConnected className="h-4 w-4" />
                                {t('bindingGroup.bindToCluster', '绑定到集群')}
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                              onClick={() => openDetail(g.name)}
                            >
                              <IconPencil className="h-4 w-4" />
                              {t('common.actions.edit', '编辑')}
                            </DropdownMenuItem>
                            {!g.protected && (
                              <DropdownMenuItem
                                className="text-destructive"
                                onClick={() => setDeleteTarget(g)}
                              >
                                <IconTrash className="h-4 w-4" />
                                {t('common.actions.delete', '删除')}
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      {deleteTarget && (
        <DeleteConfirmationDialog
          open
          onOpenChange={(open) => !open && setDeleteTarget(null)}
          resourceName={deleteTarget.name}
          resourceType={t('bindingGroup.title', '权限绑定')}
          isDeleting={deleteMutation.isPending}
          // 只解绑不删数据：命名空间与用户/角色都在，说清影响面再让人输入名字。
          additionalNote={t(
            'bindingGroup.deleteConfirm',
            '确定删除该权限绑定？命名空间不会被删除。'
          )}
          onConfirm={() => deleteMutation.mutate(deleteTarget.id)}
        />
      )}

      {!readOnly && (
        <Dialog
          open={showAuthorizationPrompt}
          onOpenChange={(open) => !open && setAuthorizationPromptClosed(true)}
        >
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>
                {t(
                  'bindingGroup.authPromptTitle',
                  '检测到该集群保留的授权配置'
                )}
              </DialogTitle>
              <DialogDescription>
                {t(
                  'bindingGroup.authPromptDescription',
                  '集群 {{cluster}} 上次删除时保留了 {{count}} 个权限绑定，请选择如何处理。',
                  {
                    cluster: effectiveCluster,
                    count: pendingAuthorization.length,
                  }
                )}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3">
              <div className="space-y-1 rounded-md border p-3">
                <Button
                  variant="outline"
                  className="w-full"
                  disabled={promptSaving}
                  onClick={() => void handleAdoptAuthorization()}
                >
                  {t('bindingGroup.authAdopt', '沿用之前的授权')}
                </Button>
                <p className="text-xs text-muted-foreground">
                  {t(
                    'bindingGroup.authAdoptHint',
                    '沿用保留的权限绑定，成员与角色授权立即恢复。'
                  )}
                </p>
              </div>
              <div className="space-y-1 rounded-md border p-3">
                <Button
                  variant="outline"
                  className="w-full"
                  disabled={promptSaving}
                  onClick={() => void handleCreateDefaultAuthorization()}
                >
                  {t('bindingGroup.authCreateDefaults', '新建默认授权')}
                </Button>
                <p className="text-xs text-muted-foreground">
                  {t(
                    'bindingGroup.authCreateDefaultsHint',
                    '丢弃保留的配置，并创建内置的默认授权（超级权限绑定）。'
                  )}
                </p>
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="ghost"
                disabled={promptSaving}
                onClick={() => setAuthorizationPromptClosed(true)}
              >
                {t('bindingGroup.authLater', '稍后处理')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {bindingGroup && (
        <BindBindingGroupDialog
          group={bindingGroup}
          onClose={() => setBindingGroup(null)}
          onBound={invalidate}
        />
      )}
    </div>
  )
}

function BindBindingGroupDialog({
  group,
  onClose,
  onBound,
}: {
  group: BindingGroup
  onClose: () => void
  onBound: () => void
}) {
  const { t } = useTranslation()
  const { readOnly } = useSettingsSectionAccess()
  const { data: clusters = [] } = useClusterList()
  const [cluster, setCluster] = useState(
    clusters.some((c) => c.name === group.cluster)
      ? group.cluster
      : (clusters[0]?.name ?? '')
  )
  const [saving, setSaving] = useState(false)

  // 集群选择是弹窗里唯一的草稿：组件随弹窗挂载，关闭即丢弃，改过就先确认再关。
  const isDirty = useDraftDirty(cluster)
  const close = useCallback(() => onClose(), [onClose])
  const guard = useUnsavedChangesGuard({ dirty: isDirty, onClose: close })

  const handleBind = async () => {
    if (!cluster) return
    setSaving(true)
    try {
      await bindBindingGroup(group.id, cluster)
      toast.success(
        t('bindingGroup.bound', '已绑定到集群 {{cluster}}', { cluster })
      )
      onBound()
      close()
    } catch {
      toast.error(t('bindingGroup.bindFailed', '绑定失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Dialog open onOpenChange={guard.handleOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t('bindingGroup.bindTitle', '绑定到集群')} · {group.name}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label>{t('bindingGroup.cluster', '集群')}</Label>
            <Select value={cluster} onValueChange={setCluster}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {clusters.map((c) => (
                  <SelectItem key={c.name} value={c.name}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t(
                'bindingGroup.bindHint',
                '绑定后该权限绑定下的命名空间、成员与角色授权立即恢复生效。'
              )}
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => guard.handleOpenChange(false)}
              disabled={saving}
            >
              {t('common.actions.cancel', '取消')}
            </Button>
            <Button
              onClick={() => void handleBind()}
              disabled={readOnly || saving || !cluster}
            >
              {t('bindingGroup.bindToCluster', '绑定到集群')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <UnsavedChangesConfirmDialog {...guard.confirmDialogProps} />
    </>
  )
}

// ---------------------------------------------------------------------------
// 新增 / 详情页（原来的弹窗改成独立页面）
//
// 页面里按「用户 / 用户组」→「角色」→「命名空间」三段穿梭列表维护授权，纵向排列。
// 授权模型是统一的：选中的用户/用户组都会拿到选中的角色，作用范围就是本组名下的
// 命名空间——写回后端时用空 namespace 表示「组内全部命名空间」（含以后加入的）。
// ---------------------------------------------------------------------------

interface SubjectRef {
  type: 'user' | 'group'
  name: string
}

function subjectRefKey(subject: SubjectRef): string {
  return `${subject.type}:${subject.name}`
}

// 穿梭框条目的 id 就是「类型:名称」，搬运时按它解析回主体。
function parseSubjectRef(id: string): SubjectRef {
  const separator = id.indexOf(':')
  return {
    type: id.slice(0, separator) === 'group' ? 'group' : 'user',
    name: id.slice(separator + 1),
  }
}

// 已保存的成员行（主体 × 范围 × 角色）反显成本页的「主体」集合；
// 受保护成员（超级管理员）不在页面上维护，单独提示。
function subjectRefsOf(group: BindingGroup | null): SubjectRef[] {
  const seen = new Set<string>()
  const refs: SubjectRef[] = []
  for (const member of group?.members ?? []) {
    if (member.protected) continue
    const ref: SubjectRef = { type: member.subjectType, name: member.subject }
    const key = subjectRefKey(ref)
    if (seen.has(key)) continue
    seen.add(key)
    refs.push(ref)
  }
  return refs
}

function roleIdsOf(group: BindingGroup | null): number[] {
  const ids = new Set<number>()
  for (const member of group?.members ?? []) ids.add(member.roleId)
  return Array.from(ids).sort((a, b) => a - b)
}

function protectedMemberNames(group: BindingGroup | null): string[] {
  const seen = new Set<string>()
  const names: string[] = []
  for (const member of group?.members ?? []) {
    if (!member.protected) continue
    const key = `${member.subjectType}:${member.subject}`
    if (seen.has(key)) continue
    seen.add(key)
    names.push(member.subject)
  }
  return names
}

interface TransferPick {
  side: 'available' | 'included'
  id: string
}

// 三段穿梭列表的公共连线：过滤词与行选中只是页面内的临时状态，
// 搬运后清掉选中，避免按钮停在一个已经搬走的条目上。
function TransferSection({
  title,
  hint,
  availableLabel,
  includedLabel,
  filterPlaceholder,
  availableEmptyText,
  includedEmptyText,
  available,
  included,
  onGrant,
  onRevoke,
  onGrantAll,
  onRevokeAll,
  availableFilterAddon,
}: {
  title: string
  hint: string
  availableLabel: string
  includedLabel: string
  filterPlaceholder: string
  availableEmptyText: string
  includedEmptyText: string
  available: TransferItem[]
  included: TransferItem[]
  onGrant: (id: string) => void
  onRevoke: (id: string) => void
  /** 透传给 TransferBox：带上过滤词时只搬当前可见条目。 */
  onGrantAll: (ids: string[]) => void
  onRevokeAll: () => void
  /** 过滤框左侧的附加控件，例如「用户 / 用户组」切换。 */
  availableFilterAddon?: ReactNode
}) {
  const { t } = useTranslation()
  const [filter, setFilter] = useState('')
  const [pick, setPick] = useState<TransferPick | undefined>(undefined)
  const move = (run: (id: string) => void) => (id: string) => {
    run(id)
    setPick(undefined)
  }

  return (
    <TransferBox
      title={title}
      hint={hint}
      availableLabel={availableLabel}
      includedLabel={includedLabel}
      available={available}
      included={included}
      filterValue={filter}
      onFilterChange={setFilter}
      filterPlaceholder={filterPlaceholder}
      availableEmptyText={availableEmptyText}
      includedEmptyText={includedEmptyText}
      selectedAvailableId={pick?.side === 'available' ? pick.id : undefined}
      selectedIncludedId={pick?.side === 'included' ? pick.id : undefined}
      onSelect={(side, id) => setPick({ side, id })}
      onGrant={move(onGrant)}
      onRevoke={move(onRevoke)}
      onGrantAll={onGrantAll}
      onRevokeAll={onRevokeAll}
      availableFilterAddon={availableFilterAddon}
      moveLabels={{
        grantAll: t('rbac.grantAll', 'Grant all'),
        grantSelected: t('rbac.grantSelected', 'Grant selected'),
        revokeSelected: t('rbac.revokeSelected', 'Revoke selected'),
        revokeAll: t('rbac.revokeAll', 'Revoke all'),
      }}
      // 三段等高：页面纵向排列，太高会让整页需要来回滚动。
      listClassName="h-48"
    />
  )
}

/** 详情页（可编辑）与新增页共用的表单页。 */
export function BindingGroupFormPage({
  mode,
  cluster,
  group,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit'
  /** 新建时归属的集群（跟随顶栏集群上下文）。 */
  cluster: string
  /** 详情页对应的权限绑定；URL 指向的组不存在时为 null。 */
  group: BindingGroup | null
  /** 返回列表页。 */
  onClose: () => void
  /** 保存成功后刷新列表（随后仍由 onClose 回列表）。 */
  onSaved: () => void
}) {
  const { t } = useTranslation()
  // 只读章节时不渲染写入口，保存按钮也不出现。
  const { readOnly } = useSettingsSectionAccess()
  const isEdit = mode === 'edit'
  const groupId = group?.id
  const clusterName = group?.cluster ?? cluster

  const [name, setName] = useState(group?.name ?? '')
  const [description, setDescription] = useState(group?.description ?? '')
  const [subjects, setSubjects] = useState<SubjectRef[]>(() =>
    subjectRefsOf(group)
  )
  // 「可用」列表按主体类型分开看；默认落在已经授出去的那一类，新建时先看用户。
  const [subjectKind, setSubjectKind] = useState<SubjectRef['type']>(
    () => subjectRefsOf(group)[0]?.type ?? 'user'
  )
  const [roleIds, setRoleIds] = useState<number[]>(() => roleIdsOf(group))
  const [namespaces, setNamespaces] = useState<string[]>(() =>
    (group?.namespaces ?? []).map((n) => n.namespace)
  )
  const [newNamespace, setNewNamespace] = useState('')
  const [saving, setSaving] = useState(false)
  // 被占用的命名空间可能有上百条，给个筛选框（见下面的占用提示区）。
  const [conflictFilter, setConflictFilter] = useState('')

  const { data: roles = [] } = useRoleList()
  const { data: clusterNamespaces = [] } = useQuery({
    queryKey: ['cluster-namespaces', clusterName],
    queryFn: () => fetchClusterNamespaces(clusterName),
    enabled: !!clusterName,
  })
  // 同集群的全部权限绑定：用于判断某个命名空间是否已被别的绑定占用。
  const { data: clusterGroups = [] } = useQuery({
    queryKey: ['binding-groups', clusterName || 'all'],
    queryFn: () => fetchBindingGroups(clusterName),
    enabled: !!clusterName,
  })

  // 命名空间在同一集群内只能属于一个权限绑定：被别人占用的要从可选项里拿掉，
  // 并把占用方（绑定名 + 已授权的用户/用户组 + 角色）列出来，让管理员先去解绑。
  const namespaceOwners = useMemo(() => {
    const owners = new Map<
      string,
      {
        groupId: number
        groupName: string
        subjects: string[]
        roles: string[]
      }
    >()
    for (const candidate of clusterGroups) {
      if (candidate.id === groupId) continue
      for (const bound of candidate.namespaces ?? []) {
        const entry = owners.get(bound.namespace) ?? {
          groupId: candidate.id,
          groupName: candidate.name,
          subjects: [],
          roles: [],
        }
        // 只列在这个命名空间上真正生效的成员（空范围 = 组内全部命名空间）。
        for (const member of candidate.members ?? []) {
          if (member.namespace && member.namespace !== bound.namespace) continue
          const label =
            member.subjectType === 'group'
              ? `${t('consoleRoles.subjectGroup', '用户组')} ${member.subject}`
              : member.subject
          if (!entry.subjects.includes(label)) entry.subjects.push(label)
          const roleName = member.role?.name ?? `#${member.roleId}`
          if (!entry.roles.includes(roleName)) entry.roles.push(roleName)
        }
        owners.set(bound.namespace, entry)
      }
    }
    return owners
  }, [clusterGroups, groupId, t])

  // 集群 ns 列表与已绑定 ns 合并展示（可能在其它集群创建过）；
  // 已被其它权限绑定占用的命名空间不可选（本组当前的归属除外）。
  const allNamespaces = useMemo(() => {
    const set = new Set([...clusterNamespaces, ...namespaces])
    return Array.from(set)
      .filter((ns) => !namespaceOwners.has(ns) || namespaces.includes(ns))
      .sort()
  }, [clusterNamespaces, namespaceOwners, namespaces])

  // 表格里展示的占用情况：已在本组里的不再提示。
  const conflictingNamespaces = useMemo(
    () =>
      Array.from(namespaceOwners.entries())
        .filter(([ns]) => !namespaces.includes(ns))
        .sort(([a], [b]) => a.localeCompare(b)),
    [namespaceOwners, namespaces]
  )

  // 占用列表的展示：先按筛选词收窄，避免上百条平铺（见下面的限高滚动）。
  const visibleConflicts = useMemo(() => {
    const keyword = conflictFilter.trim().toLowerCase()
    if (!keyword) {
      return conflictingNamespaces
    }
    return conflictingNamespaces.filter(
      ([namespace, owner]) =>
        namespace.toLowerCase().includes(keyword) ||
        owner.groupName.toLowerCase().includes(keyword)
    )
  }, [conflictingNamespaces, conflictFilter])

  // 已归属本组的命名空间始终保留，避免编辑时被默默解绑。
  const boundNamespaces = useMemo(
    () => (group?.namespaces ?? []).map((n) => n.namespace),
    [group]
  )
  useEffect(() => {
    setNamespaces((prev) =>
      prev.filter(
        (ns) =>
          clusterNamespaces.length === 0 ||
          clusterNamespaces.includes(ns) ||
          boundNamespaces.includes(ns)
      )
    )
  }, [clusterNamespaces, boundNamespaces])

  // 主体候选来自系统用户列表，分页拉取一次取全。
  const { data: userOptions = [] } = useQuery({
    queryKey: ['binding-group-user-options'],
    queryFn: async () => {
      const collected: string[] = []
      for (let page = 1; ; page++) {
        const res = await fetchUserList(page, MEMBER_PAGE_SIZE, '')
        const users = res.users || []
        collected.push(...users.map((user) => user.username))
        if (collected.length >= res.total || users.length === 0) break
      }
      return collected.sort((a, b) => a.localeCompare(b))
    },
  })
  const { data: groupOptions = [] } = useQuery({
    queryKey: ['binding-group-group-options'],
    queryFn: async () =>
      (await fetchKnownGroups()).sort((a, b) => a.localeCompare(b)),
  })

  // 「可用」里的主体：用户组排在用户前面，与列表里的主体列一致。
  const knownSubjects = useMemo<SubjectRef[]>(
    () => [
      ...groupOptions.map((name) => ({ type: 'group' as const, name })),
      ...userOptions.map((name) => ({ type: 'user' as const, name })),
    ],
    [groupOptions, userOptions]
  )

  const subjectTransfer = useMemo(() => {
    const selected = new Set(subjects.map(subjectRefKey))
    const known = new Set(knownSubjects.map(subjectRefKey))
    // 历史数据里的主体可能已经不在用户列表（账号被删）：仍列在「已赋予」里便于移除。
    const items = [
      ...knownSubjects,
      ...subjects.filter((subject) => !known.has(subjectRefKey(subject))),
    ].map<TransferItem & { type: SubjectRef['type'] }>((subject) => ({
      id: subjectRefKey(subject),
      label: subject.name,
      badge:
        subject.type === 'group'
          ? t('consoleRoles.subjectGroup', '用户组')
          : t('consoleRoles.subjectUser', '用户'),
      type: subject.type,
    }))
    return {
      // 「可用」按当前类型分开看（用户 / 用户组各一张表）；「已赋予」始终完整显示，
      // 免得切到另一类时看不到已经授出去的条目。
      available: items.filter(
        (item) => item.type === subjectKind && !selected.has(item.id)
      ),
      included: items.filter((item) => selected.has(item.id)),
    }
  }, [knownSubjects, subjects, subjectKind, t])

  // 受保护的内置角色（系统管理员 / 只读管理员 / 审计管理员 / 安全管理员）改由
  // 「系统管理员」等页签维护，不在这里分配；集群角色（集群管理员 / 集群只读管理员）
  // 同样受保护，但它们的生效范围就是「单个集群全域」，成员只在这里按集群授出。
  // 旧数据里已经绑定的条目仍然显示并保留，避免一次无关的编辑把已有授权静默丢掉。
  const roleTransfer = useMemo(() => {
    const selected = new Set(roleIds)
    const known = new Set<number>()
    const available: TransferItem[] = []
    const included: TransferItem[] = []
    for (const role of roles) {
      known.add(role.id)
      const item: TransferItem = {
        id: String(role.id),
        label: role.name,
        // 备注单独占一列：只靠角色名有时不好区分。内置角色的描述按当前语言展示
        // （后端存的是英文默认描述）。
        description: systemRoleDescription(t, role),
      }
      if (selected.has(role.id)) {
        included.push(item)
      } else if (!isProtectedRole(role) || isClusterRole(role)) {
        available.push(item)
      }
    }
    for (const id of roleIds) {
      // 角色已被删除：留着条目便于解绑，备注列占位为空。
      if (!known.has(id)) {
        included.push({ id: String(id), label: `#${id}`, description: '' })
      }
    }
    return { available, included }
  }, [roles, roleIds, t])

  const namespaceTransfer = useMemo(() => {
    const selected = new Set(namespaces)
    const items: TransferItem[] = allNamespaces.map((ns) => ({
      id: ns,
      label: ns,
    }))
    return {
      available: items.filter((item) => !selected.has(item.id)),
      included: items.filter((item) => selected.has(item.id)),
    }
  }, [allNamespaces, namespaces])

  const grantSubjects = (ids: string[]) => {
    setSubjects((prev) => {
      const seen = new Set(prev.map(subjectRefKey))
      const next = [...prev]
      for (const id of ids) {
        if (seen.has(id)) continue
        seen.add(id)
        next.push(parseSubjectRef(id))
      }
      return next
    })
  }
  const revokeSubjects = (ids: string[]) => {
    const dropped = new Set(ids)
    setSubjects((prev) =>
      prev.filter((subject) => !dropped.has(subjectRefKey(subject)))
    )
  }
  const grantRoles = (ids: string[]) =>
    setRoleIds((prev) =>
      Array.from(new Set([...prev, ...ids.map(Number)])).sort((a, b) => a - b)
    )
  const revokeRoles = (ids: string[]) => {
    const dropped = new Set(ids)
    setRoleIds((prev) => prev.filter((id) => !dropped.has(String(id))))
  }
  const grantNamespaces = (ids: string[]) =>
    setNamespaces((prev) => Array.from(new Set([...prev, ...ids])).sort())
  const revokeNamespaces = (ids: string[]) => {
    const dropped = new Set(ids)
    setNamespaces((prev) => prev.filter((ns) => !dropped.has(ns)))
  }

  const protectedMembers = useMemo(() => protectedMemberNames(group), [group])

  const handleSave = async () => {
    const trimmedName = name.trim()
    if (!trimmedName || !clusterName) return
    // 并发编辑兜底：选中的命名空间如果已被其它权限绑定占用，先提示去解绑。
    const taken = namespaces.filter((ns) => namespaceOwners.has(ns))
    if (taken.length > 0) {
      const owner = namespaceOwners.get(taken[0])!
      toast.error(
        t('bindingGroup.nsConflictOnSave', {
          namespace: taken[0],
          group: owner.groupName,
          defaultValue:
            '命名空间 {{namespace}} 已被权限绑定「{{group}}」占用，请先到那个绑定里解绑后再保存。',
        })
      )
      return
    }
    // 后端按「主体 × 命名空间范围 × 角色」落库：主体和角色要成对出现。
    if (subjects.length > 0 && roleIds.length === 0) {
      toast.error(
        t(
          'bindingGroup.memberRolesRequired',
          '请至少为选中的用户/用户组选择一个角色'
        )
      )
      return
    }
    if (subjects.length === 0 && roleIds.length > 0) {
      toast.error(
        t('bindingGroup.grantSubjectsRequired', '请选择要授权的用户或用户组')
      )
      return
    }
    setSaving(true)
    try {
      let id = groupId
      if (isEdit && id) {
        await updateBindingGroup(id, {
          name: trimmedName,
          description: description.trim(),
        })
      } else {
        const res = await createBindingGroup({
          cluster: clusterName,
          name: trimmedName,
          description: description.trim(),
        })
        id = res.bindingGroup.id
      }
      // 先写命名空间归属：成员的范围绑定会按组内命名空间校验。
      await setBindingGroupNamespaces(id!, [...namespaces].sort())
      await setBindingGroupMembers(
        id!,
        subjects.map((subject) => ({
          subjectType: subject.type,
          subject: subject.name,
          // 统一授权：作用范围就是本组名下的命名空间（空 = 全部，含以后加入的）。
          namespace: '',
          roleIds,
        }))
      )
      toast.success(t('bindingGroup.saved', '已保存'))
      onSaved()
      onClose()
    } catch (err) {
      toast.error(
        describeError(t, err, t('bindingGroup.saveFailed', '保存失败'))
      )
    } finally {
      setSaving(false)
    }
  }

  const createNamespace = async () => {
    const namespace = newNamespace.trim()
    if (!namespace || !groupId) {
      toast.error(
        t('bindingGroup.saveBeforeCreateNs', '请先保存权限绑定后再创建命名空间')
      )
      return
    }
    try {
      await createBindingGroupNamespace(groupId, namespace)
      toast.success(
        t('bindingGroup.namespaceCreated', '命名空间 {{name}} 已创建', {
          name: namespace,
        })
      )
      setNamespaces((prev) =>
        prev.includes(namespace) ? prev : [...prev, namespace]
      )
      setNewNamespace('')
    } catch (error) {
      toast.error(translateError(error, t))
    }
  }

  const backToList = (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-2 gap-1.5 text-muted-foreground"
      onClick={onClose}
    >
      <IconArrowLeft className="h-4 w-4" />
      {t('common.actions.backToList', '返回列表')}
    </Button>
  )

  if (isEdit && !group) {
    return (
      <div className="space-y-3">
        {backToList}
        <p className="text-sm text-muted-foreground">
          {t(
            'bindingGroup.notFound',
            '找不到该权限绑定，可能已被删除或不属于当前集群。'
          )}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          {backToList}
          <h2 className="font-medium">
            {isEdit
              ? t('bindingGroup.editTitle', '编辑权限绑定')
              : t('bindingGroup.createTitle', '新建权限绑定')}
          </h2>
        </div>
        {!readOnly && (
          <Button
            onClick={() => void handleSave()}
            disabled={saving || !name.trim() || !clusterName}
          >
            {t('common.actions.save', '保存')}
          </Button>
        )}
      </div>

      {group?.protected ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'bindingGroup.superGroupHint',
            '超级管理员的权限绑定由系统维护：不可删除，始终保持全局作用域，受保护成员不会被移除；可以新增成员或调整成员角色。'
          )}
        </p>
      ) : null}

      {/* 基本信息 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label>{t('bindingGroup.cluster', '集群')}</Label>
          <Input value={clusterName} disabled />
        </div>
        <div className="space-y-1">
          <Label>{t('bindingGroup.namePlaceholder', '组名称')} *</Label>
          <Input
            value={name}
            disabled={readOnly}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label>{t('bindingGroup.descPlaceholder', '描述（可选）')}</Label>
          <Input
            value={description}
            disabled={readOnly}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {t(
          'bindingGroup.unifiedHint',
          '选中的用户/用户组都会获得所选中角色的权限，生效范围就是本组名下的命名空间。'
        )}
      </p>

      {/* 用户 / 用户组 */}
      <div className="rounded-md border p-3">
        <TransferSection
          title={t('bindingGroup.moduleSubjects', '用户 / 用户组')}
          hint={t(
            'bindingGroup.subjectsHint',
            '可用列表可按「用户 / 用户组」切换查看；用户组被授权时，其成员会一并获得这些角色。'
          )}
          availableLabel={t('rbac.available', '可用')}
          includedLabel={t('rbac.assigned', '已赋予')}
          availableFilterAddon={
            // 主体类型切换放在过滤框旁边，用户和用户组各看各的候选列表。
            <ToggleGroup
              type="single"
              variant="outline"
              value={subjectKind}
              onValueChange={(value) => {
                if (value === 'user' || value === 'group') setSubjectKind(value)
              }}
              aria-label={t('bindingGroup.moduleSubjects', '用户 / 用户组')}
            >
              {(['user', 'group'] as const).map((kind) => (
                <ToggleGroupItem
                  key={kind}
                  value={kind}
                  className="h-8 px-3 text-xs"
                >
                  {kind === 'group'
                    ? t('consoleRoles.subjectGroup', '用户组')
                    : t('consoleRoles.subjectUser', '用户')}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          }
          filterPlaceholder={t('bindingGroup.subjectFilterPlaceholder', {
            kind:
              subjectKind === 'group'
                ? t('consoleRoles.subjectGroup', '用户组')
                : t('consoleRoles.subjectUser', '用户'),
            defaultValue: '过滤（{{kind}}名称）',
          })}
          availableEmptyText={
            subjectKind === 'group'
              ? t('bindingGroup.noAvailableGroups', '没有可选的用户组。')
              : t('bindingGroup.noAvailableUsers', '没有可选的用户。')
          }
          includedEmptyText={t(
            'bindingGroup.noSelectedSubjects',
            '尚未选择任何用户或用户组。'
          )}
          available={subjectTransfer.available}
          included={subjectTransfer.included}
          onGrant={(id) => grantSubjects([id])}
          onRevoke={(id) => revokeSubjects([id])}
          onGrantAll={grantSubjects}
          onRevokeAll={() => setSubjects([])}
        />

        {protectedMembers.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm">
            <Badge variant="secondary">
              {t('bindingGroup.memberProtected', '受保护')}
            </Badge>
            {protectedMembers.map((member) => (
              <span key={member} className="font-medium">
                {member}
              </span>
            ))}
            <span className="text-xs text-muted-foreground">
              {t(
                'bindingGroup.memberProtectedHint',
                '受保护成员（超级管理员）不能从组里移除，其账号也不能删除；如需收回权限可以调整角色或禁用账号。'
              )}
            </span>
          </div>
        )}
      </div>

      {/* 角色 */}
      <div className="rounded-md border p-3">
        <TransferSection
          title={t('bindingGroup.roles', '绑定角色')}
          hint={t(
            'bindingGroup.consoleRolesHint',
            '系统管理员 / 只读管理员 / 审计管理员 / 安全管理员这四个内置角色不支持在这里分配，它们改由「系统管理员 / 审计管理员 / 安全管理员」页签维护（三员是职责分离的支点，只读管理员的规则也由代码维护）。'
          )}
          availableLabel={t('rbac.available', '可用')}
          includedLabel={t('rbac.assigned', '已赋予')}
          filterPlaceholder={t(
            'bindingGroup.roleFilterPlaceholder',
            '过滤（角色名称）'
          )}
          availableEmptyText={t(
            'bindingGroup.noAvailableRoles',
            '没有可分配的角色。'
          )}
          includedEmptyText={t(
            'bindingGroup.noSelectedRoles',
            '尚未选择任何角色。'
          )}
          available={roleTransfer.available}
          included={roleTransfer.included}
          onGrant={(id) => grantRoles([id])}
          onRevoke={(id) => revokeRoles([id])}
          onGrantAll={grantRoles}
          onRevokeAll={() => setRoleIds([])}
        />
      </div>

      {/* 命名空间 */}
      <div className="rounded-md border p-3">
        <TransferSection
          title={t('bindingGroup.moduleNamespaces', '命名空间')}
          hint={t(
            'bindingGroup.nsExclusiveHint',
            '每个命名空间同一时间只能归属一个权限绑定；已被其它权限绑定占用的命名空间需要先到那个绑定里解绑，才会重新出现在这里。'
          )}
          availableLabel={t('rbac.available', '可用')}
          includedLabel={t('rbac.assigned', '已赋予')}
          filterPlaceholder={t(
            'bindingGroup.nsFilterPlaceholder',
            '过滤（命名空间名称）'
          )}
          availableEmptyText={t(
            'bindingGroup.noNamespaces',
            '当前集群没有可用的命名空间'
          )}
          includedEmptyText={t(
            'bindingGroup.noSelectedNamespaces',
            '尚未选择任何命名空间。'
          )}
          available={namespaceTransfer.available}
          included={namespaceTransfer.included}
          onGrant={(id) => grantNamespaces([id])}
          onRevoke={(id) => revokeNamespaces([id])}
          onGrantAll={grantNamespaces}
          onRevokeAll={() => setNamespaces([])}
        />

        {!readOnly && isEdit && (
          <div className="mt-3 flex gap-2">
            <Input
              placeholder={t(
                'bindingGroup.newNamespacePlaceholder',
                '新命名空间名称（在集群中创建并归属本组）'
              )}
              value={newNamespace}
              onChange={(e) => setNewNamespace(e.target.value)}
            />
            <Button
              type="button"
              variant="outline"
              disabled={!newNamespace.trim()}
              onClick={() => void createNamespace()}
            >
              <IconPlus className="h-4 w-4" />
              {t('bindingGroup.createNamespace', '创建')}
            </Button>
          </div>
        )}

        {conflictingNamespaces.length > 0 && (
          <div className="border-warning/40 bg-warning/5 mt-3 rounded-md border p-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-medium">
                {t(
                  'bindingGroup.nsTakenTitle',
                  '以下命名空间已被其它权限绑定占用，已从可选列表中移除'
                )}
                {/* 带上总数：列表可能被筛过，只看条目数会误判。 */}
                <span className="text-muted-foreground ml-1 font-normal tabular-nums">
                  ({conflictingNamespaces.length})
                </span>
              </p>
              {/* 数量多时才给筛选框：几个的话反而添乱。 */}
              {conflictingNamespaces.length > 10 && (
                <Input
                  value={conflictFilter}
                  onChange={(event) => setConflictFilter(event.target.value)}
                  placeholder={t(
                    'bindingGroup.nsTakenFilter',
                    '筛选命名空间或绑定名'
                  )}
                  className="h-7 w-44 text-xs"
                />
              )}
            </div>
            {/* 限高滚动：命名空间可能上百个，平铺会把这一页撑得极长（真机反馈）。
                按「命名空间 / 权限绑定 / 已授权 / 角色」分列，长名单才不会糊成一片。 */}
            <div className="border-warning/25 bg-background mt-1.5 max-h-48 overflow-y-auto rounded-md border">
              <Table className="text-xs">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="h-8 w-[1%] px-2 text-xs">
                      {t('bindingGroup.nsTakenColumnNamespace', '命名空间')}
                    </TableHead>
                    <TableHead className="h-8 w-[1%] px-2 text-xs">
                      {t('bindingGroup.nsTakenColumnBinding', '权限绑定')}
                    </TableHead>
                    <TableHead className="h-8 px-2 text-xs whitespace-normal">
                      {t(
                        'bindingGroup.nsTakenColumnSubjects',
                        '已授权的用户 / 用户组'
                      )}
                    </TableHead>
                    <TableHead className="h-8 px-2 text-xs whitespace-normal">
                      {t('bindingGroup.nsTakenColumnRoles', '角色')}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleConflicts.map(([namespace, owner]) => (
                    <TableRow key={namespace}>
                      <TableCell className="w-[1%] px-2 py-1.5 align-top font-mono font-medium">
                        {namespace}
                      </TableCell>
                      <TableCell className="w-[1%] px-2 py-1.5 align-top">
                        <span className="bg-primary/10 rounded px-1.5 py-0.5">
                          {owner.groupName}
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground px-2 py-1.5 align-top whitespace-normal">
                        {owner.subjects.length > 0
                          ? owner.subjects.join('、')
                          : '-'}
                      </TableCell>
                      <TableCell className="px-2 py-1.5 align-top whitespace-normal">
                        {owner.roles.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {owner.roles.map((role) => (
                              <span
                                key={role}
                                className="bg-muted text-muted-foreground rounded px-1.5 py-0.5"
                              >
                                {role}
                              </span>
                            ))}
                          </div>
                        ) : (
                          '-'
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {visibleConflicts.length === 0 && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell
                        colSpan={4}
                        className="text-muted-foreground px-2 py-3 text-center whitespace-normal"
                      >
                        {t(
                          'bindingGroup.nsTakenNoMatch',
                          '没有匹配的命名空间或绑定名'
                        )}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
            <p className="text-muted-foreground mt-1.5 text-xs">
              {t(
                'bindingGroup.nsTakenHint',
                '需要改用这些命名空间时，请先在上面对应的权限绑定里保存（去掉该命名空间）解绑，再回到这里选择。'
              )}
            </p>
          </div>
        )}
      </div>

      {/* 页面较长，底部再放一个保存入口 */}
      <div className="flex justify-end border-t pt-3">
        {!readOnly && (
          <Button
            onClick={() => void handleSave()}
            disabled={saving || !name.trim() || !clusterName}
          >
            {t('common.actions.save', '保存')}
          </Button>
        )}
      </div>
    </div>
  )
}
