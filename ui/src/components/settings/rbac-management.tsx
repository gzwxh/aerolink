import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { useSettingsSectionAccess } from '@/contexts/settings-section-context'
import {
  IconEye,
  IconFilter,
  IconKey,
  IconPencil,
  IconPlus,
  IconShieldCheck,
  IconTrash,
} from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ColumnDef,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  PaginationState,
  Row,
  SortingState,
  Table,
  useReactTable,
} from '@tanstack/react-table'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

import { Role } from '@/types/api'
import {
  deleteRole,
  fetchBindingGroups,
  useRoleList,
  type BindingGroup,
} from '@/lib/api'
import { ApiError } from '@/lib/api-client'
import {
  isProtectedRole,
  protectedRoleRank,
  systemRoleDescription,
  systemRoleLabel,
} from '@/lib/system-roles'
import { useTableColumnSizing } from '@/hooks/use-table-column-preferences'
import { useTableColumnVisibility } from '@/hooks/use-table-column-visibility'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { DeleteConfirmationDialog } from '@/components/delete-confirmation-dialog'
import { ResourceTableView } from '@/components/resource-table-view'
import { TableColumnToggle } from '@/components/table-column-toggle'

import { RBACRoleFormDialog } from './rbac-role-form-dialog'

// URL 上的角色名（?rbacTab=roles&role=<名称>）直接打开编辑弹窗，
// 设置页据此把角色名接到面包屑末尾（见 settingsSubTabs 的 detailParam）。
export const ROLE_PARAM = 'role'

/** 内置 / 自定义徽章：受保护与内置的区别以及原因放在悬停提示里。 */
function RoleBadge({ role }: { role: Role }) {
  const { t } = useTranslation()
  if (!role.isSystem) {
    return (
      <Badge variant="outline" className="shrink-0 text-xs">
        {t('rbac.roleTypeCustom', '自定义')}
      </Badge>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant={isProtectedRole(role) ? 'default' : 'secondary'}
          className="shrink-0"
        >
          {isProtectedRole(role)
            ? t('rbac.protectedRoleBadge', '受保护')
            : t('rbac.builtinRoleBadge', '内置')}
        </Badge>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        className="max-w-80 whitespace-normal border bg-popover text-xs text-popover-foreground shadow-md"
      >
        {t(
          'rbac.protectedRoleHint',
          '等保三级三权分立要求的角色，由代码维护，不可修改或删除，只能查看。'
        )}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * 行模型：把受保护的内置角色整体提到最前面，其余角色保持表格自己的排序结果。
 *
 * 顺序是这样的：先按当前列（升序或降序）排好全部角色，再稳定地把受保护角色摘出来
 * 放到前面——因此点击列头排序时它们也不会被冲散，组内则跟随当前排序，其余角色的
 * 相对顺序不变。这一步在分页之前，所以它们永远落在第一页。
 */
const pinnedRolesFirstRowModel = (table: Table<Role>) => {
  // 复用表格自己的排序行模型（它按排序状态记忆化），只在它的结果上重排。
  const base = getSortedRowModel<Role>()(table)
  return () => {
    const rowModel = base()
    const pinnedFirst = (rows: Row<Role>[]) => [
      ...rows.filter((row) => isProtectedRole(row.original)),
      ...rows.filter((row) => !isProtectedRole(row.original)),
    ]
    return {
      ...rowModel,
      rows: pinnedFirst(rowModel.rows),
      flatRows: pinnedFirst(rowModel.flatRows),
    }
  }
}

/**
 * 角色列表（参考 Nexus 风格）：角色是**全局**的，只定义「资源 + 操作」；
 * 生效范围（哪个集群、哪些命名空间）由权限绑定决定。
 *
 * 列表提供 角色 ID / 名称 / 描述 / 操作 四列；行内按钮打开弹窗（弹窗同时由 URL 参数
 * role=<名称> 控制，便于直达与面包屑展示），受保护的内置角色只提供查看，其余角色
 * 可以编辑，「删除」需要二次确认。
 *
 * 受保护的内置角色固定排在列表最前面：未排序时按内置顺序，排序时由
 * pinnedRolesFirstRowModel 保持在最前；它们的描述按当前语言展示（后端存的是英文默认）。
 */
export function RBACManagement() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const { data: roles = [], isLoading, error } = useRoleList()
  // 只读章节（只有 settings.rbac 的读权限）时不渲染任何写入口。
  const { readOnly } = useSettingsSectionAccess()

  const [searchParams, setSearchParams] = useSearchParams()
  const detailRoleName = searchParams.get(ROLE_PARAM)?.trim() || null
  const setDetailRoleName = useCallback(
    (name: string | null) => {
      const next = new URLSearchParams(searchParams)
      if (name) {
        next.set(ROLE_PARAM, name)
      } else {
        next.delete(ROLE_PARAM)
      }
      // replace：开关弹窗不堆历史记录，浏览器的后退语义仍是「离开设置页」。
      setSearchParams(next, { replace: true })
    },
    [searchParams, setSearchParams]
  )

  // 新建弹窗与 URL 无关；编辑弹窗由 role=<名称> 控制。
  const [showCreate, setShowCreate] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Role | null>(null)

  const [search, setSearch] = useState('')
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 20,
  })
  const [sorting, setSorting] = useState<SortingState>([])
  // 列显示偏好：与资源列表 / 用户组列表一致，用齿轮菜单勾选，并持久化。
  const [columnVisibility, setColumnVisibility] = useTableColumnVisibility(
    'aerolink-rbac-roles-columnVisibility'
  )
  // 列宽偏好：与资源列表同一套交互（拖表头右缘调宽，双击复位）。
  const [columnSizing, setColumnSizing] = useTableColumnSizing(
    'aerolink-rbac-roles-columnSizing'
  )

  const editRole = useMemo(
    () =>
      detailRoleName
        ? (roles.find((r) => r.name === detailRoleName) ?? null)
        : null,
    [detailRoleName, roles]
  )

  const closeDialog = useCallback(() => {
    setShowCreate(false)
    setDetailRoleName(null)
  }, [setDetailRoleName])

  // 角色是否已被权限绑定引用：删角色会连带删掉绑定组里的成员行（等价于静默解绑
  // 别人的授权），所以删除前先查出来，要求管理员到「权限绑定」里先解绑。
  // 后端在 DELETE 上也做同样判定（并发兜底），这里只负责把话说在前面。
  // 列表接口默认不返回「保留的」组（所属集群已删除），但它们一样持有成员行，
  // 所以两份都要取：判定口径与后端的 BindingGroupsUsingRole 保持一致。
  const { data: bindingGroups = [] } = useQuery({
    queryKey: ['binding-groups', { roleUsage: true }],
    queryFn: async () => [
      ...(await fetchBindingGroups()),
      ...(await fetchBindingGroups(undefined, { detached: true })),
    ],
  })

  // 角色 ID → 使用它的权限绑定组（同一个组只记一次）。
  const groupsByRole = useMemo(() => {
    const map = new Map<number, BindingGroup[]>()
    for (const group of bindingGroups) {
      for (const member of group.members ?? []) {
        const used = map.get(member.roleId)
        if (!used) {
          map.set(member.roleId, [group])
        } else if (!used.some((item) => item.id === group.id)) {
          used.push(group)
        }
      }
    }
    return map
  }, [bindingGroups])

  const groupsUsingDeleteTarget = deleteTarget
    ? (groupsByRole.get(deleteTarget.id) ?? [])
    : []

  const deleteMutation = useMutation({
    mutationFn: (role: Role) => deleteRole(role.id),
    onSuccess: (_data, role) => {
      queryClient.invalidateQueries({ queryKey: ['role-list'] })
      setDeleteTarget(null)
      // 正在编辑的角色被删掉：关闭弹窗退回列表。
      if (detailRoleName === role.name) {
        setDetailRoleName(null)
      }
      toast.success(
        t('common.messages.deleted', {
          resource: t('common.fields.role', 'Role'),
          defaultValue: 'Role deleted',
        })
      )
    },
    onError: (err: unknown) => {
      // 竞态：本地看到的是旧数据，服务端仍然拒删。把最新的绑定关系拉回来，
      // 让下一次打开删除弹窗能看到「用它的那几个组」。
      if (
        err instanceof ApiError &&
        err.code === 'role_in_use_by_binding_group'
      ) {
        const params = (err.params ?? {}) as { count?: number }
        queryClient.invalidateQueries({ queryKey: ['binding-groups'] })
        toast.error(
          t('rbac.deleteRoleInUse', {
            count: params.count ?? 0,
            defaultValue:
              '该角色仍被 {{count}} 个权限绑定使用，请先到「权限绑定」里解除该角色的绑定，再删除角色。',
          })
        )
        return
      }
      toast.error(err instanceof Error ? err.message : String(err))
    },
  })

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const matched = !q
      ? roles
      : roles.filter((role) =>
          [role.name, systemRoleLabel(t, role), systemRoleDescription(t, role)]
            .join('\n')
            .toLowerCase()
            .includes(q)
        )
    // 未排序时的默认顺序：受保护的内置角色（系统管理员 / 安全管理员 / 审计管理员 /
    // 只读管理员）按内置顺序排在最前面——它们由代码维护，混在自定义角色里不好找。
    return [...matched].sort(
      (a, b) => protectedRoleRank(a) - protectedRoleRank(b)
    )
  }, [roles, search, t])

  useEffect(() => {
    setPagination((prev) => ({ ...prev, pageIndex: 0 }))
  }, [search, sorting])

  const columns = useMemo<ColumnDef<Role>[]>(
    () => [
      {
        accessorKey: 'name',
        header: t('rbac.roleId', '角色 ID'),
        cell: ({ row }) => {
          const role = row.original
          return (
            <button
              type="button"
              className="flex items-center gap-2 text-left hover:text-primary"
              title={role.name}
              onClick={() => setDetailRoleName(role.name)}
            >
              <IconKey className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate font-mono text-sm">
                {role.name}
              </span>
            </button>
          )
        },
      },
      {
        id: 'displayName',
        header: t('common.fields.name', '名称'),
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <span className="min-w-0 truncate text-sm">
              {systemRoleLabel(t, row.original)}
            </span>
            <RoleBadge role={row.original} />
          </div>
        ),
      },
      {
        accessorKey: 'description',
        header: t('common.fields.description', '描述'),
        cell: ({ row }) => {
          const description = systemRoleDescription(t, row.original)
          if (!description) {
            return (
              <div className="flex justify-center">
                <span className="text-sm text-muted-foreground">-</span>
              </div>
            )
          }
          return (
            <div className="flex justify-center">
              <div
                className="line-clamp-2 max-w-[24rem] text-center text-sm break-words text-muted-foreground"
                title={description}
              >
                {description}
              </div>
            </div>
          )
        },
      },
      {
        id: 'subjects',
        header: t('rbac.subjects', '使用者'),
        accessorFn: (role) => (role.assignments ?? []).length,
        enableSorting: false,
        cell: ({ row }) => {
          const direct = (row.original.assignments ?? []).length
          // 角色的使用者有两个来源：直接分配，以及权限绑定里以该角色授权的成员。
          // 只看前者会把「只被权限绑定使用」的角色显示成 '-'，误判成没人用。
          const groups = groupsByRole.get(row.original.id) ?? []
          if (direct === 0 && groups.length === 0) {
            return <span className="text-sm text-muted-foreground">-</span>
          }
          return (
            <div className="flex flex-col items-center gap-1">
              {direct > 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="secondary" className="text-xs">
                      {t('rbac.subjectsDirect', {
                        count: direct,
                        defaultValue: '{{count}} 用户/组',
                      })}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent
                    side="top"
                    className="max-w-80 whitespace-normal border bg-popover text-xs text-popover-foreground shadow-md"
                  >
                    {t(
                      'rbac.subjectsDirectHint',
                      '直接分配给该角色的用户 / 用户组（在角色详情里维护）。'
                    )}
                  </TooltipContent>
                </Tooltip>
              )}
              {groups.length > 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="outline" className="text-xs">
                      {t('rbac.subjectsBindingGroups', {
                        count: groups.length,
                        defaultValue: '{{count}} 权限绑定',
                      })}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent
                    side="top"
                    className="max-w-80 whitespace-normal border bg-popover text-xs text-popover-foreground shadow-md"
                  >
                    <div className="space-y-1">
                      <p>
                        {t(
                          'rbac.subjectsBindingGroupsHint',
                          '以下权限绑定以该角色授权，删除角色前需要先在「权限绑定」里解绑：'
                        )}
                      </p>
                      <ul className="list-disc pl-4">
                        {groups.map((group) => (
                          <li key={group.id}>
                            {group.name}
                            <span className="text-muted-foreground">
                              （{group.cluster}）
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          )
        },
      },
      {
        id: 'actions',
        header: t('common.fields.actions', '操作'),
        enableSorting: false,
        cell: ({ row }) => {
          const role = row.original
          const protectedRole = isProtectedRole(role)
          return (
            <div className="flex items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 px-2.5 text-xs"
                onClick={() => setDetailRoleName(role.name)}
              >
                {protectedRole ? (
                  <IconEye className="h-3.5 w-3.5" />
                ) : (
                  <IconPencil className="h-3.5 w-3.5" />
                )}
                {protectedRole
                  ? t('common.actions.view', '查看')
                  : t('common.actions.edit', '编辑')}
              </Button>
              {!protectedRole && !readOnly && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 px-2.5 text-xs text-destructive hover:text-destructive"
                  onClick={() => setDeleteTarget(role)}
                >
                  <IconTrash className="h-3.5 w-3.5" />
                  {t('common.actions.delete', '删除')}
                </Button>
              )}
            </div>
          )
        },
      },
    ],
    [groupsByRole, readOnly, setDetailRoleName, t]
  )

  const table = useReactTable<Role>({
    data: filtered,
    columns,
    state: { pagination, sorting, columnVisibility, columnSizing },
    onPaginationChange: setPagination,
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnSizingChange: setColumnSizing,
    // 列宽拖拽：拖动表头右缘实时调宽（min/max 来自 defaultColumn）。
    enableColumnResizing: true,
    columnResizeMode: 'onChange',
    defaultColumn: { size: 160, minSize: 80, maxSize: 600 },
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: pinnedRolesFirstRowModel,
    getFilteredRowModel: getFilteredRowModel(),
  })

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
    if (error) {
      return (
        <div className="py-8 text-center text-sm text-destructive">
          {t('common.messages.failedToLoad', {
            resource: t('common.fields.roles', 'roles'),
            defaultValue: 'Failed to load roles',
          })}
        </div>
      )
    }
    if (roles.length === 0) {
      return (
        <div className="py-8 text-center text-muted-foreground">
          <IconShieldCheck className="mx-auto mb-4 h-12 w-12 opacity-50" />
          <p>{t('rbac.empty', '暂无角色')}</p>
        </div>
      )
    }
    return null
  })()

  return (
    <div>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2">
                <IconShieldCheck className="h-5 w-5" />
                {t('rbac.rolesTitle', '角色')}
              </CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('rbac.rolesSubtitle', '管理角色权限和继承角色')}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {!readOnly && (
                <Button className="gap-2" onClick={() => setShowCreate(true)}>
                  <IconPlus className="h-4 w-4" />
                  {t('rbac.createRole', '创建角色')}
                </Button>
              )}
              <div className="relative">
                <IconFilter className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder={t('rbac.filterPlaceholder', '过滤')}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-56 pl-9"
                />
              </div>
              {/* 与资源列表 / 用户组列表一致：齿轮菜单用来勾选要显示的列。 */}
              <TableColumnToggle table={table} />
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <ResourceTableView
            table={table}
            columnCount={columns.length}
            isLoading={isLoading}
            data={filtered}
            allPageSize={filtered.length}
            emptyState={emptyState}
            hasActiveFilters={Boolean(search)}
            filteredRowCount={table.getFilteredRowModel().rows.length}
            totalRowCount={roles.length}
            searchQuery={search}
            pagination={pagination}
            setPagination={setPagination}
            maxBodyHeightClassName="max-h-[600px]"
          />

          {/* 三员互斥（职责分离）说明：等保三级要求「系统管理员（配置）」「安全管理员
              （授权）」「审计管理员（审计）」由不同人员担任。 */}
          <div className="flex items-start gap-2 rounded-md border border-dashed p-3 text-xs text-muted-foreground">
            <IconShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {t(
                'rbac.separationOfDutiesHint',
                '职责分离（等保三级）：系统管理员（配置）、安全管理员（授权）、审计管理员（审计）三个内置角色的权限互不相交，且不得由同一账号兼任——否则该账号的管理面会被整体拒绝，需要先解绑其中一个角色。角色控制台设置章节（settings.<章节>）时，通配 * 不覆盖它们，必须逐个显式勾选。'
              )}
            </span>
          </div>
        </CardContent>
      </Card>

      {(showCreate || editRole) && (
        <RBACRoleFormDialog
          key={editRole ? editRole.id : 'new'}
          role={editRole}
          onClose={closeDialog}
          onSaved={closeDialog}
        />
      )}

      {deleteTarget && (
        <DeleteConfirmationDialog
          open
          onOpenChange={(open) => !open && setDeleteTarget(null)}
          resourceName={deleteTarget.name}
          resourceType={t('common.fields.role', '角色')}
          isDeleting={deleteMutation.isPending}
          // 还被权限绑定引用时不允许确认：先解绑，避免删除时把组里的授权静默带走。
          confirmDisabled={groupsUsingDeleteTarget.length > 0}
          onConfirm={() => void deleteMutation.mutate(deleteTarget)}
          additionalNote={t('rbac.deleteRoleImpact', {
            count: (deleteTarget.assignments ?? []).length,
            defaultValue:
              '{{count}} 个用户或用户组正在使用该角色，删除会同时移除这些授权。',
          })}
          extraContent={
            <>
              {groupsUsingDeleteTarget.length > 0 && (
                <div className="space-y-1 text-xs text-destructive">
                  <p>
                    {t('rbac.deleteRoleInUse', {
                      count: groupsUsingDeleteTarget.length,
                      defaultValue:
                        '该角色仍被 {{count}} 个权限绑定使用，请先到「权限绑定」里解除该角色的绑定，再删除角色。',
                    })}
                  </p>
                  {/* 列出来才能直接去解绑：只给数量，管理员还要自己一个个翻。 */}
                  <ul className="list-disc pl-4">
                    {groupsUsingDeleteTarget.map((group) => (
                      <li key={group.id}>
                        {group.name}
                        <span className="text-muted-foreground">
                          （{group.cluster}）
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {(deleteTarget.assignments ?? []).some(
                (assignment) =>
                  assignment.subjectType === 'user' &&
                  assignment.subject === user?.username
              ) && (
                <p className="text-xs text-destructive">
                  {t(
                    'rbac.deleteOwnRoleWarning',
                    '该角色正分配给你当前使用的账号：删除可能影响你自己的权限。'
                  )}
                </p>
              )}
            </>
          }
        />
      )}
    </div>
  )
}

export default RBACManagement
