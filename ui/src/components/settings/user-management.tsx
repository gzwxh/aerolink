import { useCallback, useEffect, useMemo, useState } from 'react'
import * as Avatar from '@radix-ui/react-avatar'
import {
  IconEdit,
  IconLock,
  IconLockOpen,
  IconPlus,
  IconSearch,
  IconShieldCheck,
  IconTrash,
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
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

import { UserItem } from '@/types/api'
import {
  createPasswordUser,
  deleteUser,
  fetchSecuritySetting,
  resetUserPassword,
  setUserEnabled,
  updateUser,
  useRoleList,
  useUserList,
} from '@/lib/api'
import { fetchAPI } from '@/lib/api/shared'
import { buildPasswordRules, isPasswordRulesValid } from '@/lib/password-rules'
import { formatDate, translateError } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { DeleteConfirmationDialog } from '@/components/delete-confirmation-dialog'
import { PasswordInput } from '@/components/password-input'
import { ResourceTableView } from '@/components/resource-table-view'

import { Action } from '../action-table'
import { Badge } from '../ui/badge'
import UserRoleAssignment from './user-role-assignment'

function userSubjectName(user: UserItem): string {
  return user.username || user.name || user.sub || String(user.id)
}

// Native password users keep their group memberships in Kite; external users
// (LDAP / OIDC) have theirs managed by the directory.
function isNativeUser(user?: UserItem | null): boolean {
  return !user?.provider || user.provider === 'password'
}

// Only native and LDAP-provisioned users can be deleted from Kite (LDAP
// deletion removes the local record without touching the directory).
function isDeletableUser(user?: UserItem | null): boolean {
  return isNativeUser(user) || user?.provider === 'ldap'
}

export function UserManagement() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 20,
  })
  const [sorting, setSorting] = useState<SortingState>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState('')
  const { data: roles = [] } = useRoleList()
  // 创建用户表单所需的可选用户组与全局 MFA 策略。
  const { data: knownGroups = [] } = useQuery({
    queryKey: ['known-groups'],
    queryFn: async () => {
      const result = await fetchAPI<unknown>('/admin/groups')
      const list = Array.isArray(result)
        ? result
        : ((result as { groups?: unknown[] }).groups ?? [])
      return list
        .map((item) =>
          typeof item === 'string'
            ? item
            : ((item as { name?: string }).name ?? '')
        )
        .filter(Boolean)
    },
    staleTime: 60000,
  })
  const { data: createSecuritySetting } = useQuery({
    queryKey: ['security-setting'],
    queryFn: fetchSecuritySetting,
    staleTime: 60000,
  })
  const securityMfaPolicy =
    (createSecuritySetting as { mfaPolicy?: string } | undefined)?.mfaPolicy ??
    'disabled'

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

  const { data, isLoading, error } = useUserList(
    pagination.pageIndex + 1,
    pagination.pageSize,
    searchQuery,
    sortParams.sortBy,
    sortParams.sortOrder,
    roleFilter
  )

  const [togglingUserId, setTogglingUserId] = useState<number | null>(null)

  // 列表「状态」列可直接启用/禁用。
  const handleToggleStatus = useCallback(
    async (user: UserItem) => {
      // 超级管理员不允许禁用，UI 上也不给出可点击入口。
      if (user.username === 'admin') return
      setTogglingUserId(user.id)
      try {
        await setUserEnabled(user.id, !user.enabled)
        await queryClient.invalidateQueries({ queryKey: ['user-list'] })
        toast.success(
          user.enabled
            ? t('common.messages.disabled', '已禁用')
            : t('common.messages.enabled', '已启用')
        )
      } catch (error) {
      } finally {
        setTogglingUserId(null)
      }
    },
    [queryClient, t]
  )

  const getStatusBadge = useCallback(
    (user: UserItem) => {
      return (
        <button
          type="button"
          disabled={togglingUserId === user.id || user.username === 'admin'}
          onClick={() => void handleToggleStatus(user)}
          title={
            user.username === 'admin'
              ? t(
                  'userManagement.messages.superAdminProtected',
                  '超级管理员不支持禁用'
                )
              : t('common.fields.status', 'Status')
          }
          className="cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
        >
          {user.enabled ? (
            <Badge variant="default">{t('status.enabled', 'Enabled')}</Badge>
          ) : (
            <Badge variant="secondary">
              {t('status.disabled', 'Disabled')}
            </Badge>
          )}
        </button>
      )
    },
    [handleToggleStatus, t, togglingUserId]
  )

  const handleToggleEnable = useCallback(
    async (u: UserItem) => {
      // 超级管理员不允许禁用（与列表状态徽章的不可点击保持一致）。
      if (u.username === 'admin') return
      await setUserEnabled(u.id, !u.enabled)
      queryClient.invalidateQueries({ queryKey: ['user-list'] })
      toast.success(
        t('common.messages.updated', {
          resource: t('common.fields.user', 'User'),
          defaultValue: 'User updated',
        })
      )
    },
    [queryClient, t]
  )

  const actions = useMemo<Action<UserItem>[]>(() => {
    return [
      {
        label: (
          <>
            <IconEdit className="h-4 w-4" />
            {t('common.actions.edit', 'Edit')}
          </>
        ),
        onClick: (item) => setEditingUser(item),
      },
      {
        label: '-',
        dynamicLabel: (item) =>
          item.enabled ? (
            <>
              <IconLock className="h-4 w-4" />
              {t('common.actions.disable', 'Disable')}
            </>
          ) : (
            <>
              <IconLockOpen className="h-4 w-4" />
              {t('common.actions.enable', 'Enable')}
            </>
          ),
        onClick: (item) => handleToggleEnable(item),
        // 超级管理员不支持禁用，菜单项置灰。
        shouldDisable: (item) => item.username === 'admin',
      },
      {
        label: (
          <div className="inline-flex items-center gap-2 text-destructive">
            <IconTrash className="h-4 w-4" />
            {t('common.actions.delete', 'Delete')}
          </div>
        ),
        shouldDisable: (item) => !isDeletableUser(item),
        onClick: (item) => setDeletingUser(item),
      },
      {
        label: (
          <>
            <IconLock className="h-4 w-4" />
            {t('common.actions.resetPassword', 'Reset Password')}
          </>
        ),
        shouldDisable: (item) => item.provider !== 'password',
        onClick: (item) => handleResetPassword(item),
      },
      {
        label: (
          <>
            <IconShieldCheck className="h-4 w-4" />
            {t('common.actions.assign', 'Assign')}
          </>
        ),
        onClick: (item) => {
          setAssigning(item)
        },
      },
    ]
  }, [handleToggleEnable, t])

  const [editingUser, setEditingUser] = useState<UserItem | null>(null)
  const [deletingUser, setDeletingUser] = useState<UserItem | null>(null)
  const [assigning, setAssigning] = useState<UserItem | null>(null)
  const [showAddDialog, setShowAddDialog] = useState(false)

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
        enableSorting: false,
        accessorFn: (row) => row.username,
        cell: ({ row }) => (
          <div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setEditingUser(row.original)}
                aria-label={`${t('common.actions.edit', 'Edit')} ${t('common.fields.user', 'user')}`}
                className="p-0 bg-transparent border-0 inline-flex items-center"
              >
                <Avatar.Root className="inline-block">
                  {row.original.avatar_url ? (
                    <Avatar.Image
                      src={row.original.avatar_url}
                      alt={row.original.username}
                      className="h-8 w-8 rounded-full object-cover"
                    />
                  ) : (
                    <Avatar.Fallback className="h-8 w-8 rounded-full bg-muted-foreground text-white flex items-center justify-center">
                      {row.original.username
                        .split(' ')
                        .map((part) => part[0])
                        .join('')
                        .toUpperCase()
                        .slice(0, 2)}
                    </Avatar.Fallback>
                  )}
                </Avatar.Root>
              </button>
              <div className="flex flex-col min-w-0">
                <span className="font-medium truncate">
                  {row.original.username}
                </span>
                {row.original.name && (
                  <span className="text-sm text-muted-foreground truncate">
                    {row.original.name}
                  </span>
                )}
              </div>
            </div>
          </div>
        ),
      },
      {
        id: 'status',
        header: t('common.fields.status', 'Status'),
        enableSorting: false,
        cell: ({ row: { original: user } }) => (
          <div className="flex items-center gap-3">{getStatusBadge(user)}</div>
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
            <div className="flex flex-wrap gap-1">
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

  const tableColumns = useMemo<ColumnDef<UserItem>[]>(() => {
    const actionColumn: ColumnDef<UserItem> = {
      id: 'actions',
      header: t('common.fields.actions', 'Actions'),
      cell: ({ row }) => (
        <div className="text-right">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('common.fields.actions', 'Actions')}
              >
                •••
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {actions.map((action, index) => (
                <DropdownMenuItem
                  key={index}
                  disabled={action.shouldDisable?.(row.original)}
                  onClick={() => action.onClick(row.original)}
                  className="gap-2"
                >
                  {action.dynamicLabel
                    ? action.dynamicLabel(row.original)
                    : action.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ),
    }
    return [...columns, actionColumn]
  }, [actions, columns, t])

  const table = useReactTable({
    data: data?.users ?? [],
    columns: tableColumns,
    getCoreRowModel: getCoreRowModel(),
    state: {
      pagination,
      sorting,
    },
    onPaginationChange: setPagination,
    onSortingChange: setSorting,
    manualPagination: true,
    manualSorting: true,
    pageCount: Math.ceil((data?.total ?? 0) / pagination.pageSize) || 0,
  })
  const [newUser, setNewUser] = useState({
    username: '',
    name: '',
    password: '',
    email: '',
    phone: '',
    wechat: '',
    remark: '',
    // 激活状态：默认按「安全设置 → 新建用户默认状态」由后端决定，这里显式传开关值。
    enabled: true,
    // 失效日期（ISO 字符串，空表示不过期）。
    expiresAt: '',
    // 本地用户组（创建时一并加入）。
    groups: [] as string[],
    // 系统角色（创建后立即分配）。
    roles: [] as string[],
  })

  // 生成一个满足复杂度要求（大小写+数字+符号）的随机密码。
  const randomPassword = () => {
    const charset =
      'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*'
    const values = new Uint32Array(16)
    crypto.getRandomValues(values)
    return Array.from(values, (value) => charset[value % charset.length]).join(
      ''
    )
  }
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
    },
    onError: () => {},
  })

  const createMutation = useMutation({
    mutationFn: (data: {
      username: string
      name?: string
      password: string
      email?: string
      phone?: string
      wechat?: string
      remark?: string
      enabled?: boolean
      expiresAt?: string
      groups?: string[]
      roles?: string[]
    }) => createPasswordUser(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-list'] })
      toast.success(
        t('common.messages.created', {
          resource: t('common.fields.user', 'User'),
          defaultValue: 'User created',
        })
      )
      setShowAddDialog(false)
    },
    onError: () => {},
  })

  const resetPasswordMutation = useMutation({
    mutationFn: ({ id, password }: { id: number; password: string }) =>
      resetUserPassword(id, password),
    onSuccess: () => {
      toast.success(t('common.messages.passwordReset', 'Password reset'))
      setShowResetDialog(null)
    },
    onError: (error) => {
      // 后端密码策略失败（长度/强度/历史密码重复等）必须展示给用户，
      // 否则弹窗停留在原地且没有任何反馈。
      toast.error(
        translateError(error, t) ||
          t('common.messages.failedToResetPassword', '重置密码失败')
      )
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<UserItem> }) =>
      updateUser(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-list'] })
      toast.success(
        t('common.messages.updated', {
          resource: t('common.fields.user', 'User'),
          defaultValue: 'User updated',
        })
      )
      setEditingUser(null)
    },
    onError: () => {},
  })

  const handleDelete = () => {
    if (!deletingUser) return
    deleteMutation.mutate(deletingUser.id)
  }

  const handleResetPassword = (u: UserItem) => {
    setShowResetDialog(u)
  }

  const handleCreateUser = (e: React.FormEvent) => {
    e.preventDefault()
    createMutation.mutate({
      username: newUser.username,
      name: newUser.name,
      password: newUser.password,
    })
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!editingUser) return
    const data: Partial<UserItem> = {
      avatar_url: editingUser.avatar_url,
    }
    if (isNativeUser(editingUser)) {
      data.name = editingUser.name
      data.oidc_groups = editingUser.oidc_groups ?? []
    }
    updateMutation.mutate({
      id: editingUser.id,
      data,
    })
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
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <IconUser className="h-5 w-5" />
                {t('common.fields.users', 'User Management')}
              </CardTitle>
            </div>
            <div className="flex items-center gap-3">
              <Select
                value={roleFilter || 'all'}
                onValueChange={(value) =>
                  setRoleFilter(value === 'all' ? '' : value)
                }
              >
                <SelectTrigger className="w-48">
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
              <div className="relative">
                <IconSearch className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder={t(
                    'common.placeholders.searchUsers',
                    'Search users...'
                  )}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9 w-64"
                />
              </div>
              <Button
                onClick={() => navigate('/settings/users/create')}
                className="gap-2"
              >
                <IconPlus className="h-4 w-4" />
                {t('common.actions.add', 'Add')}{' '}
                {t('common.fields.passwordUser', 'Password User')}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <ResourceTableView
            table={table}
            columnCount={tableColumns.length}
            isLoading={isLoading}
            data={data?.users}
            allPageSize={totalRowCount}
            emptyState={emptyState}
            hasActiveFilters={Boolean(searchQuery) || Boolean(roleFilter)}
            filteredRowCount={filteredRowCount}
            totalRowCount={totalRowCount}
            searchQuery={searchQuery}
            pagination={pagination}
            setPagination={setPagination}
            maxBodyHeightClassName="max-h-[600px]"
          />
        </CardContent>
      </Card>

      {/* Edit Dialog */}
      <Dialog open={!!editingUser} onOpenChange={() => setEditingUser(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('common.actions.edit', 'Edit')}{' '}
              {t('common.fields.user', 'User')}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm">
                {t('common.fields.username', 'Username')}
              </label>
              <Input value={editingUser?.username || ''} disabled />
            </div>
            <div>
              <label className="block text-sm">
                {t('common.fields.avatarUrl', 'Avatar URL')}
              </label>
              <Input
                value={editingUser?.avatar_url || ''}
                onChange={(e) =>
                  setEditingUser({
                    ...(editingUser as UserItem),
                    avatar_url: e.target.value,
                  })
                }
              />
            </div>
            {isNativeUser(editingUser) && (
              <div>
                <label className="block text-sm">
                  {t('common.fields.name', 'Name')}
                </label>
                <Input
                  value={editingUser?.name || ''}
                  onChange={(e) =>
                    setEditingUser({
                      ...(editingUser as UserItem),
                      name: e.target.value,
                    })
                  }
                />
              </div>
            )}
            {!isNativeUser(editingUser) && (
              <p className="text-xs text-muted-foreground">
                {t(
                  'userManagement.messages.externalEditHint',
                  'This user is managed by an external source. Only the avatar can be edited here.'
                )}
              </p>
            )}
            {isNativeUser(editingUser) && (
              <div>
                <label className="block text-sm">
                  {t('userManagement.fields.groups', 'Groups')}
                </label>
                <Input
                  value={(editingUser?.oidc_groups ?? []).join(', ')}
                  onChange={(e) =>
                    setEditingUser({
                      ...(editingUser as UserItem),
                      oidc_groups: e.target.value
                        .split(',')
                        .map((g) => g.trim())
                        .filter(Boolean),
                    })
                  }
                />
                <p className="text-xs text-muted-foreground mt-1">
                  {t(
                    'userManagement.fields.groupsHint',
                    'Comma-separated group names. Users inherit the roles assigned to these groups.'
                  )}
                </p>
              </div>
            )}
            <DialogFooter>
              <Button type="submit">{t('common.actions.save', 'Save')}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Role assignment dialog */}
      <UserRoleAssignment
        open={!!assigning}
        onOpenChange={(o) => {
          if (!o) setAssigning(null)
        }}
        subject={
          assigning
            ? { type: 'user', name: userSubjectName(assigning) }
            : undefined
        }
      />

      {/* Add Password User Dialog */}
      <Dialog open={showAddDialog} onOpenChange={() => setShowAddDialog(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('common.actions.add', 'Add')}{' '}
              {t('common.fields.passwordUser', 'Password User')}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreateUser} className="space-y-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('createUser.sections.account', '账户')}
            </div>
            <div>
              <label className="block text-sm">
                {t('common.fields.username', 'Username')}
              </label>
              <Input
                value={newUser.username}
                onChange={(e) =>
                  setNewUser({ ...newUser, username: e.target.value })
                }
              />
            </div>
            <div>
              <label className="block text-sm">
                {t('common.fields.name', 'Name')}
              </label>
              <Input
                value={newUser.name}
                onChange={(e) =>
                  setNewUser({ ...newUser, name: e.target.value })
                }
              />
            </div>
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('createUser.sections.authentication', '认证')}
            </div>
            <div>
              <div className="flex items-center justify-between">
                <label className="block text-sm">
                  {t('common.fields.password', 'Password')}
                </label>
                <button
                  type="button"
                  className="text-xs text-primary hover:underline"
                  onClick={() =>
                    setNewUser({ ...newUser, password: randomPassword() })
                  }
                >
                  {t('createUser.randomPassword', '随机生成')}
                </button>
              </div>
              <Input
                type="text"
                value={newUser.password}
                onChange={(e) =>
                  setNewUser({ ...newUser, password: e.target.value })
                }
              />
            </div>
            <div>
              <label className="block text-sm">
                {t('createUser.fields.mfaLevel', 'MFA 级别')}
              </label>
              <Input
                value={t(
                  `createUser.mfaLevels.${securityMfaPolicy}`,
                  securityMfaPolicy === 'required'
                    ? '强制'
                    : securityMfaPolicy === 'optional'
                      ? '启用（可选）'
                      : '禁用'
                )}
                disabled
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t(
                  'createUser.mfaLevelHint',
                  '由「安全设置 → 认证策略」统一控制，用户首次登录时按策略引导绑定'
                )}
              </p>
            </div>
            <div>
              <label className="block text-sm">
                {t('userManagement.fields.groups', '用户组')}
              </label>
              <div className="flex flex-wrap gap-2">
                {knownGroups.length === 0 && (
                  <span className="text-xs text-muted-foreground">
                    {t('createUser.noGroups', '暂无可选用户组')}
                  </span>
                )}
                {knownGroups.map((group) => {
                  const selected = newUser.groups.includes(group)
                  return (
                    <button
                      key={group}
                      type="button"
                      onClick={() =>
                        setNewUser({
                          ...newUser,
                          groups: selected
                            ? newUser.groups.filter((item) => item !== group)
                            : [...newUser.groups, group],
                        })
                      }
                      className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                        selected
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'text-muted-foreground hover:bg-muted'
                      }`}
                    >
                      {group}
                    </button>
                  )
                })}
              </div>
            </div>
            <div>
              <label className="block text-sm">
                {t('common.fields.email', 'Email')}
              </label>
              <Input
                type="email"
                value={newUser.email}
                placeholder="user@example.com"
                onChange={(e) =>
                  setNewUser({ ...newUser, email: e.target.value })
                }
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm">
                  {t('common.fields.phone', 'Phone')}
                </label>
                <Input
                  value={newUser.phone}
                  onChange={(e) =>
                    setNewUser({ ...newUser, phone: e.target.value })
                  }
                />
              </div>
              <div>
                <label className="block text-sm">
                  {t('common.fields.wechat', 'WeChat')}
                </label>
                <Input
                  value={newUser.wechat}
                  onChange={(e) =>
                    setNewUser({ ...newUser, wechat: e.target.value })
                  }
                />
              </div>
            </div>
            <div>
              <label className="block text-sm">
                {t('common.fields.remark', 'Remark')}
              </label>
              <Input
                value={newUser.remark}
                onChange={(e) =>
                  setNewUser({ ...newUser, remark: e.target.value })
                }
              />
            </div>
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('createUser.sections.security', '安全')}
            </div>
            <div className="flex items-center justify-between">
              <label className="text-sm">
                {t('common.fields.enabled', 'Active')}
              </label>
              <Switch
                checked={newUser.enabled}
                onCheckedChange={(checked) =>
                  setNewUser({ ...newUser, enabled: checked })
                }
              />
            </div>
            <div>
              <label className="block text-sm">
                {t('createUser.fields.expiresAt', '失效日期')}
              </label>
              <Input
                type="date"
                value={newUser.expiresAt ? newUser.expiresAt.slice(0, 10) : ''}
                onChange={(e) =>
                  setNewUser({
                    ...newUser,
                    expiresAt: e.target.value
                      ? new Date(`${e.target.value}T23:59:59`).toISOString()
                      : '',
                  })
                }
              />
            </div>
            <div>
              <label className="block text-sm">
                {t('common.fields.roles', '系统角色')}
              </label>
              <div className="flex flex-wrap gap-2">
                {roles.length === 0 && (
                  <span className="text-xs text-muted-foreground">
                    {t('createUser.noRoles', '暂无可选角色')}
                  </span>
                )}
                {roles.map((role) => {
                  const selected = newUser.roles.includes(role.name)
                  return (
                    <button
                      key={role.name}
                      type="button"
                      onClick={() =>
                        setNewUser({
                          ...newUser,
                          roles: selected
                            ? newUser.roles.filter((item) => item !== role.name)
                            : [...newUser.roles, role.name],
                        })
                      }
                      className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                        selected
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'text-muted-foreground hover:bg-muted'
                      }`}
                    >
                      {role.name}
                    </button>
                  )
                })}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {t(
                  'createUser.securityHint',
                  '用户组与系统角色可在这里直接设置，也可在创建后通过列表的「分配」操作调整。'
                )}
              </p>
            </div>
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('createUser.sections.other', '其它')}
            </div>
            <DialogFooter>
              <Button type="submit">
                {t('common.actions.create', 'Create')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

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
                            check.ok ? 'bg-green-500' : 'bg-muted'
                          }`}
                        />
                      ))}
                    </div>
                    <ul className="space-y-0.5 text-xs">
                      {checks.map((check) => (
                        <li
                          key={check.label}
                          className={
                            check.ok
                              ? 'text-green-600'
                              : 'text-muted-foreground'
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
                'This only removes the account from Kite. The user remains in the LDAP directory and can be imported again later.'
              )
            : undefined
        }
      />
    </div>
  )
}

export default UserManagement
