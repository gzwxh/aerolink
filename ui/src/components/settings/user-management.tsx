import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSettingsSectionAccess } from '@/contexts/settings-section-context'
import * as Avatar from '@radix-ui/react-avatar'
import {
  IconPlus,
  IconSearch,
  IconShieldLock,
  IconUser,
} from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ColumnDef,
  getCoreRowModel,
  PaginationState,
  SortingState,
  useReactTable,
} from '@tanstack/react-table'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { UserItem } from '@/types/api'
import {
  deleteUser,
  fetchKnownGroupDetails,
  resetUserMFA,
  resetUserPassword,
  setUserEnabled,
  useOAuthProviderList,
  useRoleList,
  useUserList,
} from '@/lib/api'
import { ApiError } from '@/lib/api-client'
import { resolveAvatarSrc } from '@/lib/avatar-url'
import { buildPasswordRules, isPasswordRulesValid } from '@/lib/password-rules'
import { neutralBadge, statusBadge } from '@/lib/status-badge'
import { formatDate, translateError } from '@/lib/utils'
import { useTableColumnVisibility } from '@/hooks/use-table-column-visibility'
import {
  useTableColumnOrder,
  useTableColumnSizing,
} from '@/hooks/use-table-column-preferences'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { DeleteConfirmationDialog } from '@/components/delete-confirmation-dialog'
import { PasswordInput } from '@/components/password-input'
import { ResourceTableView } from '@/components/resource-table-view'
import { TableColumnToggle } from '@/components/table-column-toggle'

import { Badge } from '../ui/badge'
import { UserDetailDialog } from './user-detail-dialog'
import { UserFormDialog } from './user-form-dialog'

export function UserManagement() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  // 只读章节（只有 settings.<章节> 的读权限）时不渲染任何写入口。
  const { readOnly } = useSettingsSectionAccess()
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 20,
  })
  const [sorting, setSorting] = useState<SortingState>([])
  const [searchQuery, setSearchQuery] = useState('')
  // 四个列过滤条件：和 sortBy 一样直接下推到后端——列表是服务端分页，
  // 只在当前页做过滤会得到前后矛盾的结果。
  const [roleFilter, setRoleFilter] = useState('')
  const [enabledFilter, setEnabledFilter] = useState('')
  const [providerFilter, setProviderFilter] = useState('')
  const [groupFilter, setGroupFilter] = useState('')
  // 列显示偏好：与资源列表（/deployments 等）一致，用齿轮菜单勾选，并持久化。
  // 用户列表是全局数据、与当前集群无关，所以这里用不带集群前缀的键。
  const [columnVisibility, setColumnVisibility] = useTableColumnVisibility(
    'aerolink-users-columnVisibility'
  )
  // 列宽 / 列顺序偏好：与资源列表同一套交互（拖表头右缘调宽、拖表头换位）。
  const [columnSizing, setColumnSizing] = useTableColumnSizing(
    'aerolink-users-columnSizing'
  )
  const [columnOrder, setColumnOrder] = useTableColumnOrder(
    'aerolink-users-columnOrder'
  )
  const { data: roles = [] } = useRoleList()
  // 认证方式除了内置的密码 / LDAP，还可能是任意已配置的 OAuth 提供方名称。
  const { data: oauthProviders = [] } = useOAuthProviderList()
  const providerOptions = useMemo(
    () => [
      'password',
      'ldap',
      ...oauthProviders.map((provider) => provider.name),
    ],
    [oauthProviders]
  )
  // LDAP / OIDC 用户组：用后端已知的组名作为下拉选项。
  const { data: knownGroupDetails } = useQuery({
    queryKey: ['known-group-details'],
    queryFn: fetchKnownGroupDetails,
    staleTime: 60000,
  })
  const groupOptions = useMemo(
    () =>
      Object.keys(knownGroupDetails ?? {}).sort((a, b) => a.localeCompare(b)),
    [knownGroupDetails]
  )

  const sortParams = useMemo(() => {
    if (sorting.length === 0) {
      return { sortBy: '', sortOrder: '' }
    }
    const [primary] = sorting
    return {
      sortBy: primary.id,
      sortOrder: primary.desc ? 'desc' : 'asc',
    }
  }, [sorting])

  // 过滤条件变化后回到第一页：否则会停在一个新结果集里并不存在的页码上。
  useEffect(() => {
    setPagination((prev) =>
      prev.pageIndex === 0 ? prev : { ...prev, pageIndex: 0 }
    )
  }, [searchQuery, roleFilter, enabledFilter, providerFilter, groupFilter])

  const { data, isLoading, error } = useUserList(
    pagination.pageIndex + 1,
    pagination.pageSize,
    searchQuery,
    sortParams.sortBy,
    sortParams.sortOrder,
    roleFilter,
    enabledFilter,
    providerFilter,
    groupFilter
  )

  const [togglingUserId, setTogglingUserId] = useState<number | null>(null)

  // 启用/停用统一走一个 mutation：失败原因（例如「没有别的启用账号持有系统管理员角色」）
  // 由 onError 当场提示，调用方只负责各自的成功反馈。
  const toggleEnabledMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      setUserEnabled(id, enabled),
    onError: (error) => {
      if (
        error instanceof ApiError &&
        error.code === 'user_last_administrator'
      ) {
        toast.error(
          t(
            'userManagement.messages.lastAdministratorNeedsManager',
            '当前没有其他启用账号持有「系统管理员」角色，操作后没人能接管管理面。请先把该角色分配给另一个启用账号，再继续。'
          )
        )
        return
      }
      toast.error(translateError(error, t))
    },
  })

  // 列表「状态」列可直接启用/禁用。
  const handleToggleStatus = useCallback(
    async (user: UserItem) => {
      setTogglingUserId(user.id)
      try {
        await toggleEnabledMutation.mutateAsync({
          id: user.id,
          enabled: !user.enabled,
        })
        await queryClient.invalidateQueries({ queryKey: ['user-list'] })
        toast.success(
          user.enabled
            ? t('common.messages.disabled', '已禁用')
            : t('common.messages.enabled', '已启用')
        )
      } catch {
        // 失败原因（含「没有别的账号能进控制台管理面」）已由 mutation 的 onError 提示
      } finally {
        setTogglingUserId(null)
      }
    },
    [queryClient, t, toggleEnabledMutation]
  )

  const getStatusBadge = useCallback(
    (user: UserItem) => {
      const badge = user.enabled ? (
        <Badge {...statusBadge('success')}>
          {t('status.enabled', 'Enabled')}
        </Badge>
      ) : (
        <Badge {...neutralBadge()}>{t('status.disabled', 'Disabled')}</Badge>
      )
      // 超级管理员可以停用，但后端要求系统里还有别的启用账号能进控制台管理面；
      // 它的保护手段是绑定 MFA，所以未绑定时额外给出引导。
      const display =
        user.isSuperAdmin && !user.mfa_enabled ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center gap-1.5">
                {badge}
                <Badge variant="outline" className="gap-1">
                  <IconShieldLock className="h-3 w-3" />
                  {t('userManagement.messages.mfaNotBound', '未绑定 MFA')}
                </Badge>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-72 whitespace-normal">
              {t(
                'userManagement.messages.superAdminDisableHint',
                '超级管理员可以停用，但系统里必须还有其他能进入控制台管理面、且未被停用的账号（例如安全管理员）。更推荐的做法是给它绑定 MFA。'
              )}
            </TooltipContent>
          </Tooltip>
        ) : (
          badge
        )
      if (readOnly) return display
      return (
        <button
          type="button"
          disabled={togglingUserId === user.id}
          onClick={() => void handleToggleStatus(user)}
          title={t('common.fields.status', 'Status')}
          className="cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
        >
          {display}
        </button>
      )
    },
    [handleToggleStatus, readOnly, t, togglingUserId]
  )

  const handleToggleEnable = useCallback(
    async (u: UserItem) => {
      try {
        await toggleEnabledMutation.mutateAsync({
          id: u.id,
          enabled: !u.enabled,
        })
        queryClient.invalidateQueries({ queryKey: ['user-list'] })
        toast.success(
          t('common.messages.updated', {
            resource: t('common.fields.user', 'User'),
            defaultValue: 'User updated',
          })
        )
      } catch {
        // 失败原因已由 mutation 的 onError 提示
      }
    },
    [queryClient, t, toggleEnabledMutation]
  )

  // 「重置 MFA」：强制 MFA 策略下身份验证器丢失时的唯一出路，否则账号永久锁死。
  const resetMFAMutation = useMutation({
    mutationFn: (id: number) => resetUserMFA(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-list'] })
      toast.success(
        t(
          'userManagement.messages.mfaResetDone',
          '已解除该账号的 MFA 绑定，请让本人重新绑定。'
        )
      )
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const handleResetMFA = useCallback(
    (u: UserItem) => {
      if (
        !window.confirm(
          t('userManagement.messages.mfaResetConfirm', {
            username: u.username,
            defaultValue:
              '解除「{{username}}」的 MFA 绑定？本人在下次登录时需要重新绑定身份验证器。',
          })
        )
      ) {
        return
      }
      resetMFAMutation.mutate(u.id)
    },
    [resetMFAMutation, t]
  )

  // 详情弹窗：点用户名 / 头像或行内「编辑」打开，里面同时承载资料编辑与管理操作。
  const [detailUser, setDetailUser] = useState<UserItem | null>(null)

  // 弹窗里的操作（启用 / 停用、重置密码等）会让列表重新拉取：把弹窗手里的对象也换成
  // 最新的一份，否则弹窗里的只读字段与按钮会停在旧值上。
  useEffect(() => {
    if (!detailUser) return
    const fresh = data?.users.find((item) => item.id === detailUser.id)
    if (fresh && fresh !== detailUser) setDetailUser(fresh)
  }, [data, detailUser])
  const [deletingUser, setDeletingUser] = useState<UserItem | null>(null)
  const [showCreateUser, setShowCreateUser] = useState(false)

  const columns = useMemo<ColumnDef<UserItem>[]>(
    () => [
      {
        id: 'id',
        header: 'ID',
        enableSorting: true,
        accessorFn: (row) => row.id,
        cell: ({ getValue }) => (
          <div className="text-sm text-muted-foreground">
            {String(getValue())}
          </div>
        ),
      },
      {
        id: 'username',
        header: t('common.fields.username', 'Username'),
        enableSorting: true,
        accessorFn: (row) => row.username,
        cell: ({ row }) => {
          const avatar = (
            <Avatar.Root className="inline-block">
              {row.original.avatar_url ? (
                <Avatar.Image
                  src={resolveAvatarSrc(row.original.avatar_url)}
                  alt={row.original.username}
                  className="h-8 w-8 rounded-full object-cover"
                />
              ) : (
                <Avatar.Fallback className="h-8 w-8 rounded-full bg-muted-foreground text-background flex items-center justify-center">
                  {row.original.username
                    .split(' ')
                    .map((part) => part[0])
                    .join('')
                    .toUpperCase()
                    .slice(0, 2)}
                </Avatar.Fallback>
              )}
            </Avatar.Root>
          )
          return (
            <div>
              <div className="flex items-center gap-3">
                {/* 头像与用户名都是详情入口：查看与编辑（含操作）在同一个弹窗里。 */}
                <button
                  type="button"
                  onClick={() => setDetailUser(row.original)}
                  aria-label={t('userManagement.detail.title', '用户详情')}
                  className="p-0 bg-transparent border-0 inline-flex items-center"
                >
                  {avatar}
                </button>
                <div className="flex flex-col min-w-0">
                  {/* 用户名即详情入口：看只读详情（含 LDAP 同步信息）。 */}
                  <button
                    type="button"
                    onClick={() => setDetailUser(row.original)}
                    title={t('userManagement.detail.title', '用户详情')}
                    className="text-left font-medium truncate hover:underline"
                  >
                    {row.original.username}
                  </button>
                  {row.original.name && (
                    <span className="text-sm text-muted-foreground truncate">
                      {row.original.name}
                    </span>
                  )}
                </div>
              </div>
            </div>
          )
        },
      },
      {
        id: 'status',
        header: t('common.fields.status', 'Status'),
        enableSorting: false,
        cell: ({ row: { original: user } }) => (
          <div className="flex items-center justify-center gap-3">
            {getStatusBadge(user)}
          </div>
        ),
      },
      {
        id: 'provider',
        header: t('common.fields.provider', 'Provider'),
        accessorFn: (row) => row.provider || '-',
        enableSorting: false,
        cell: ({ getValue }) => (
          <div className="code">{String(getValue() || '-')}</div>
        ),
      },
      {
        id: 'createdAt',
        header: t('common.fields.createdAt', 'Created At'),
        enableSorting: true,
        accessorFn: (row) => row.createdAt,
        cell: ({ getValue }) => (
          <div className="text-sm text-muted-foreground">
            {formatDate(getValue() as string) || '-'}
          </div>
        ),
      },
      {
        id: 'lastLoginAt',
        header: t('common.fields.lastLoginAt', 'Last Login'),
        enableSorting: true,
        accessorFn: (row) => row.lastLoginAt ?? '',
        cell: ({
          row: {
            original: { lastLoginAt },
          },
        }) => (
          <div className="text-sm text-muted-foreground">
            {lastLoginAt ? formatDate(lastLoginAt) : '-'}
          </div>
        ),
      },
      {
        id: 'roles',
        header: t('common.fields.roles', 'Roles'),
        accessorFn: (row) => row.roles?.map((r) => r.name).join(', '),
        enableSorting: false,
        cell: ({ getValue }) => (
          <div className="text-sm text-muted-foreground">
            {String(getValue() || '-')}
          </div>
        ),
      },
      {
        id: 'groups',
        header: t('common.fields.oidcGroups', 'LDAP / OIDC Groups'),
        accessorFn: (row) => (row.oidc_groups || []).join(', '),
        enableSorting: false,
        cell: ({ row }) => {
          const groups = row.original.oidc_groups || []
          if (groups.length === 0) {
            return <span className="text-sm text-muted-foreground">-</span>
          }
          return (
            <div className="flex flex-wrap items-center justify-center gap-1">
              {groups.map((group) => (
                <Badge key={group} variant="outline" className="text-xs">
                  {group}
                </Badge>
              ))}
            </div>
          )
        },
      },
    ],
    [getStatusBadge, t]
  )

  const table = useReactTable({
    data: data?.users ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
    state: {
      pagination,
      sorting,
      columnVisibility,
      columnSizing,
      columnOrder,
    },
    onPaginationChange: setPagination,
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnSizingChange: setColumnSizing,
    onColumnOrderChange: setColumnOrder,
    // 列宽拖拽：拖动表头右缘实时调宽（min/max 来自 defaultColumn）。
    enableColumnResizing: true,
    columnResizeMode: 'onChange',
    defaultColumn: { size: 160, minSize: 80, maxSize: 600 },
    manualPagination: true,
    manualSorting: true,
    pageCount: Math.ceil((data?.total ?? 0) / pagination.pageSize) || 0,
  })
  const [showResetDialog, setShowResetDialog] = useState<UserItem | null>(null)
  const [resetPasswordValue, setResetPasswordValue] = useState('')

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteUser(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-list'] })
      toast.success(
        t('common.messages.deleted', {
          resource: t('common.fields.user', 'User'),
          defaultValue: 'User deleted',
        })
      )
      setDeletingUser(null)
      // 账号已不存在，详情弹窗不能再留着展示它（删除入口就在详情里）。
      setDetailUser(null)
    },
    // 拒绝删除的原因（超级管理员不可删 / 系统里将不再有管理员）必须当场告知，
    // 否则弹窗停留在原地，用户不知道为什么删不掉。
    onError: (error) => {
      if (
        error instanceof ApiError &&
        error.code === 'user_super_admin_not_deletable'
      ) {
        toast.error(
          t(
            'userManagement.messages.superAdminNotDeletable',
            '超级管理员账号不支持删除，请改用停用（停用前需要另有启用账号持有系统管理员角色）。'
          )
        )
        return
      }
      if (
        error instanceof ApiError &&
        error.code === 'user_last_administrator'
      ) {
        toast.error(
          t(
            'userManagement.messages.lastAdministratorNeedsManager',
            '当前没有其他启用账号持有「系统管理员」角色，操作后没人能接管管理面。请先把该角色分配给另一个启用账号，再继续。'
          )
        )
        return
      }
      toast.error(
        translateError(error, t) ||
          t('common.messages.failedToDelete', {
            resource: t('common.fields.user', '用户'),
            defaultValue: '删除用户失败',
          })
      )
    },
  })

  const resetPasswordMutation = useMutation({
    mutationFn: ({ id, password }: { id: number; password: string }) =>
      resetUserPassword(id, password),
    onSuccess: () => {
      toast.success(t('common.messages.passwordReset', 'Password reset'))
      setShowResetDialog(null)
    },
    onError: (error) => {
      // 后端密码策略失败（长度/强度/历史密码重复 等）必须展示给用户，
      // 否则弹窗停留在原地且没有任何反馈。
      toast.error(
        translateError(error, t) ||
          t('common.messages.failedToResetPassword', '重置密码失败')
      )
    },
  })

  const handleDelete = () => {
    if (!deletingUser) return
    // 能否删除由后端判定（超级管理员只在还有别的账号能管设置时才允许）：
    // 拒绝原因会原样显示给用户，不在前端重复一套规则。
    deleteMutation.mutate(deletingUser.id)
  }

  const handleResetPassword = (u: UserItem) => {
    setShowResetDialog(u)
  }

  useEffect(() => {
    setPagination((prev) => ({ ...prev, pageIndex: 0 }))
  }, [searchQuery, roleFilter, sorting])

  const emptyState = (() => {
    if (isLoading && !data) {
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
              resource: t('common.fields.users', 'users'),
              defaultValue: 'Failed to load users',
            })}
          </div>
        </div>
      )
    }
    if (data && data.users.length === 0) {
      return (
        <div className="text-center py-8 text-muted-foreground">
          <IconUser className="h-12 w-12 mx-auto mb-4 opacity-50" />
          <p>
            {t('common.messages.noItemsFound', {
              resource: t('common.fields.users', 'users'),
              defaultValue: 'No users',
            })}
          </p>
          <p className="text-sm mt-1">
            {t('common.messages.noItemsFound', {
              resource: t('common.fields.users', 'users'),
              defaultValue: 'No users found',
            })}
          </p>
        </div>
      )
    }
    return null
  })()

  const totalRowCount = data?.total ?? 0
  const filteredRowCount = data?.users.length ?? 0

  return (
    <div>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <IconUser className="h-5 w-5" />
                {t('common.fields.users', 'User Management')}
              </CardTitle>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-3">
              <Select
                value={roleFilter || 'all'}
                onValueChange={(value) =>
                  setRoleFilter(value === 'all' ? '' : value)
                }
              >
                <SelectTrigger className="w-44">
                  <SelectValue
                    placeholder={t('common.values.allRoles', 'All roles')}
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    {t('common.values.allRoles', 'All roles')}
                  </SelectItem>
                  {roles.map((role) => (
                    <SelectItem key={role.id} value={role.name}>
                      {role.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={enabledFilter || 'all'}
                onValueChange={(value) =>
                  setEnabledFilter(value === 'all' ? '' : value)
                }
              >
                <SelectTrigger className="w-36">
                  <SelectValue
                    placeholder={t('common.values.allStatus', 'All statuses')}
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    {t('common.values.allStatus', 'All statuses')}
                  </SelectItem>
                  <SelectItem value="true">
                    {t('status.enabled', 'Enabled')}
                  </SelectItem>
                  <SelectItem value="false">
                    {t('status.disabled', 'Disabled')}
                  </SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={providerFilter || 'all'}
                onValueChange={(value) =>
                  setProviderFilter(value === 'all' ? '' : value)
                }
              >
                <SelectTrigger className="w-44">
                  <SelectValue
                    placeholder={t(
                      'common.values.allProviders',
                      'All providers'
                    )}
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    {t('common.values.allProviders', 'All providers')}
                  </SelectItem>
                  {providerOptions.map((provider) => (
                    <SelectItem key={provider} value={provider}>
                      {provider}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {(groupOptions.length > 0 || Boolean(groupFilter)) && (
                <Select
                  value={groupFilter || 'all'}
                  onValueChange={(value) =>
                    setGroupFilter(value === 'all' ? '' : value)
                  }
                >
                  <SelectTrigger className="w-48">
                    <SelectValue
                      placeholder={t('common.values.allGroups', 'All groups')}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">
                      {t('common.values.allGroups', 'All groups')}
                    </SelectItem>
                    {groupOptions.map((group) => (
                      <SelectItem key={group} value={group}>
                        {group}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <div className="relative">
                <IconSearch className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder={t(
                    'common.placeholders.searchUsers',
                    'Search users...'
                  )}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9 w-56"
                />
              </div>
              {!readOnly && (
                <Button
                  onClick={() => setShowCreateUser(true)}
                  className="gap-2"
                >
                  <IconPlus className="h-4 w-4" />
                  {t('common.actions.add', 'Add')}{' '}
                  {t('common.fields.passwordUser', 'Password User')}
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
            data={data?.users}
            enableReorder
            allPageSize={totalRowCount}
            emptyState={emptyState}
            hasActiveFilters={
              Boolean(searchQuery) ||
              Boolean(roleFilter) ||
              Boolean(enabledFilter) ||
              Boolean(providerFilter) ||
              Boolean(groupFilter)
            }
            filteredRowCount={filteredRowCount}
            totalRowCount={totalRowCount}
            searchQuery={searchQuery}
            pagination={pagination}
            setPagination={setPagination}
            maxBodyHeightClassName="max-h-[600px]"
          />
        </CardContent>
      </Card>

      {showCreateUser && (
        <UserFormDialog onClose={() => setShowCreateUser(false)} />
      )}

      {/* 用户详情：点用户名 / 头像或行内「编辑」打开，资料编辑与管理操作都在这里。
          渲染顺序放在重置密码 / 删除确认弹窗之前，后挂载的弹窗才会叠在它上面。 */}
      {detailUser && (
        <UserDetailDialog
          key={detailUser.id}
          user={detailUser}
          editable={!readOnly}
          onOpenChange={(open) => !open && setDetailUser(null)}
          // 用返回对象覆盖已知字段，而不是整份替换：更新接口不回传 roles（gorm:"-"），
          // 整份替换会让「角色」短暂变成「暂无授权角色」。
          onSaved={(updated) =>
            setDetailUser((prev) =>
              prev && prev.id === updated.id ? { ...prev, ...updated } : updated
            )
          }
          onToggleEnabled={handleToggleEnable}
          onResetPassword={handleResetPassword}
          onResetMFA={handleResetMFA}
          onDelete={setDeletingUser}
        />
      )}

      {/* Reset Password Dialog */}
      <Dialog
        open={!!showResetDialog}
        onOpenChange={() => setShowResetDialog(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('common.actions.resetPassword', 'Reset Password')}
            </DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (showResetDialog)
                resetPasswordMutation.mutate({
                  id: showResetDialog.id,
                  password: resetPasswordValue,
                })
            }}
            className="space-y-4"
          >
            <div>
              <label className="block text-sm">
                {t('common.fields.password', 'Password')}
              </label>
              <PasswordInput
                name="password"
                value={resetPasswordValue}
                onChange={(e) => setResetPasswordValue(e.target.value)}
              />
              {(() => {
                const value = resetPasswordValue
                const checks = buildPasswordRules(value, t)
                const passed = checks.filter((c) => c.ok).length
                return (
                  <div className="mt-2 space-y-1">
                    <div className="flex gap-1">
                      {checks.map((check) => (
                        <div
                          key={check.label}
                          className={`h-1 flex-1 rounded-full ${
                            check.ok ? 'bg-success' : 'bg-muted'
                          }`}
                        />
                      ))}
                    </div>
                    <ul className="space-y-0.5 text-xs">
                      {checks.map((check) => (
                        <li
                          key={check.label}
                          className={
                            check.ok ? 'text-success' : 'text-muted-foreground'
                          }
                        >
                          {check.ok ? '✓' : '○'} {check.label}
                        </li>
                      ))}
                    </ul>
                    <p className="text-xs text-muted-foreground">
                      {t('passwordPolicy.strength', '强度')}：{passed}/
                      {checks.length}
                    </p>
                  </div>
                )
              })()}
            </div>
            <DialogFooter>
              <Button
                type="submit"
                disabled={
                  readOnly ||
                  resetPasswordMutation.isPending ||
                  !isPasswordRulesValid(
                    buildPasswordRules(resetPasswordValue, t)
                  )
                }
              >
                {t('common.actions.save', 'Save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <DeleteConfirmationDialog
        open={!!deletingUser}
        onOpenChange={() => setDeletingUser(null)}
        onConfirm={handleDelete}
        resourceName={deletingUser?.username || ''}
        resourceType="user"
        additionalNote={
          deletingUser?.provider === 'ldap'
            ? t(
                'userManagement.messages.ldapDeleteNote',
                'This only removes the account from AeroLink. The user remains in the LDAP directory and can be imported again later.'
              )
            : undefined
        }
      />
    </div>
  )
}

export default UserManagement
