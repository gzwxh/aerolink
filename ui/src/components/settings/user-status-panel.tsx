import { useMemo, useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import {
  IconChevronLeft,
  IconChevronRight,
  IconRefresh,
  IconSearch,
} from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import {
  checkInactiveUsers,
  restoreDisabledUsers,
  setUserEnabled,
} from '@/lib/api'
import { fetchAPI } from '@/lib/api/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface AutoDisabledUser {
  id: number
  username: string
  disabledReason?: string
  disabledAt?: string
}

const PAGE_SIZE_OPTIONS = [10, 20, 50]

/**
 * 「用户状态」：列出被「不活跃用户自动禁用」策略关闭的账号（按停用时间新→旧），
 * 展示形式对齐「用户管理 → 用户」列表：用户名快速搜索 + 每页行数 + 分页，
 * 支持单个恢复与勾选后的批量恢复（本页全选便于恢复同一批误伤账号）。
 *
 * 数据量可能很大（阈值调小过一次就会留下批量停用记录），因此不能全部铺开：
 * 分页后面板高度固定，页面底部的「提交」按钮不会被挤出屏幕。
 *
 * 调大阈值不会自动解禁历史被禁账号（策略只禁用、不恢复），批量误伤用这里的恢复。
 *
 * 读写接口都在 `settings.users` 下（`GET /admin/users/disabled`、
 * `POST /admin/users/:id/enable`、`POST /admin/users/disabled/check` 与
 * `POST /admin/users/disabled/restore`）——虽然策略本身属于安全设置，但这里操作的
 * 是用户数据。因此只读态按 **users 章节**判定，而不是容纳本面板的安全设置章节：
 * 否则一个只有 `settings.security` 写权限的账号会看到可点的「恢复」按钮，点了才 403。
 * （同类教训见等保方案 §13.2：写入口的可见性要跟随该动作所需的权限。）
 */
export function UserStatusPanel() {
  const { t } = useTranslation()
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const readOnly = !(user?.canManageSettingsSection('users') ?? false)
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['auto-disabled-users'],
    queryFn: () =>
      fetchAPI<{ users: AutoDisabledUser[] }>('/admin/users/disabled'),
    staleTime: 15000,
  })

  const users = useMemo(() => data?.users ?? [], [data])
  const [search, setSearch] = useState('')
  const [pageIndex, setPageIndex] = useState(0)
  const [pageSize, setPageSize] = useState(PAGE_SIZE_OPTIONS[0])
  const [selected, setSelected] = useState<number[]>([])

  // 与用户列表一致：过滤和分页都在前端做（本面板的数据源是一次性返回的禁用列表）。
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) {
      return users
    }
    return users.filter((account) =>
      account.username.toLowerCase().includes(query)
    )
  }, [users, search])

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(pageIndex, pageCount - 1)
  const pageItems = filtered.slice(
    safePage * pageSize,
    safePage * pageSize + pageSize
  )

  const handleSearch = (value: string) => {
    setSearch(value)
    setPageIndex(0)
  }

  const handlePageSize = (value: string) => {
    setPageSize(Number(value))
    setPageIndex(0)
  }

  const toggleSelect = (id: number, checked: boolean) => {
    setSelected((prev) =>
      checked ? [...prev, id] : prev.filter((value) => value !== id)
    )
  }

  // 本页全选：恢复「刚才那一批」时比逐个勾快得多；跨页的勾选会保留。
  const pageSelectedCount = pageItems.filter((account) =>
    selected.includes(account.id)
  ).length
  const allPageSelected =
    pageItems.length > 0 && pageSelectedCount === pageItems.length
  const toggleSelectPage = (checked: boolean) => {
    const pageIds = new Set(pageItems.map((account) => account.id))
    setSelected((prev) =>
      checked
        ? [
            ...prev,
            ...pageItems.map((a) => a.id).filter((id) => !prev.includes(id)),
          ]
        : prev.filter((id) => !pageIds.has(id))
    )
  }

  const handleRestore = async (account: AutoDisabledUser) => {
    try {
      await setUserEnabled(account.id, true)
      toast.success(
        t('securitySettings.userStatus.restored', '已恢复 {{name}}', {
          name: account.username,
        })
      )
      setSelected((prev) => prev.filter((id) => id !== account.id))
      await refetch()
    } catch {
      // 失败已由 API 客户端统一写入站内信
    }
  }

  const restoreMutation = useMutation({
    mutationFn: (ids: number[]) => restoreDisabledUsers(ids),
    onSuccess: ({ restored, skipped }) => {
      if (restored > 0) {
        toast.success(
          t(
            'securitySettings.userStatus.restoredCount',
            '已恢复 {{count}} 个账号，他们需要重新登录',
            { count: restored }
          )
        )
      }
      if (skipped > 0) {
        toast.warning(
          t(
            'securitySettings.userStatus.restoreSkipped',
            '{{count}} 个账号已不在自动禁用列表中，未做处理',
            { count: skipped }
          )
        )
      }
      setSelected([])
      // 面板与用户列表读的是同一份 enabled 状态，恢复后都要刷新。
      queryClient.invalidateQueries({ queryKey: ['user-list'] })
      refetch()
    },
    onError: () => {
      // 失败已由 API 客户端统一写入站内信
    },
  })

  // 批量恢复前确认数量：一次误伤几十上百个账号时，这一步能挡住手滑。
  const confirmRestore = (ids: number[]) => {
    if (ids.length === 0 || restoreMutation.isPending) {
      return
    }
    if (
      !window.confirm(
        t(
          'securitySettings.userStatus.restoreConfirm',
          '确定恢复这 {{count}} 个被自动禁用的账号？恢复后他们需要重新登录。',
          { count: ids.length }
        )
      )
    ) {
      return
    }
    restoreMutation.mutate(ids)
  }

  // 每日检查每小时才调度一次：这里给一个同页的立即触发入口，
  // 改完阈值能当场验证禁用与恢复。
  const checkMutation = useMutation({
    mutationFn: checkInactiveUsers,
    onSuccess: ({ disabled }) => {
      toast.success(
        disabled > 0
          ? t(
              'securitySettings.userStatus.checkResult',
              '本次检查禁用了 {{count}} 个长期未登录的账号',
              {
                count: disabled,
              }
            )
          : t(
              'securitySettings.userStatus.checkNone',
              '检查完成：没有需要禁用的账号'
            )
      )
      refetch()
    },
    onError: () => {
      // 失败已由 API 客户端统一写入站内信
    },
  })

  return (
    <div className="rounded-lg border">
      <div className="flex items-start justify-between gap-3 bg-muted/40 px-3 py-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">
            {t('securitySettings.userStatus.title', '用户状态')}
          </div>
          <p className="text-xs text-muted-foreground">
            {t(
              'securitySettings.userStatus.description',
              '被「不活跃用户自动禁用」关闭的账号按停用时间排列，可搜索、分页浏览，单个或勾选批量恢复；恢复后用户需要重新登录。'
            )}
          </p>
        </div>
        {!readOnly && (
          <div className="flex shrink-0 items-center gap-2">
            {selected.length > 0 && (
              <Button
                size="sm"
                disabled={restoreMutation.isPending}
                onClick={() => confirmRestore(selected)}
              >
                {t(
                  'securitySettings.userStatus.restoreSelected',
                  '恢复所选 ({{count}})',
                  { count: selected.length }
                )}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={checkMutation.isPending}
              onClick={() => checkMutation.mutate()}
            >
              <IconRefresh
                className={
                  checkMutation.isPending ? 'h-4 w-4 animate-spin' : 'h-4 w-4'
                }
              />
              {t('securitySettings.userStatus.check', '立即检查')}
            </Button>
          </div>
        )}
      </div>

      {!readOnly && (
        <div className="flex flex-wrap items-center gap-3 border-b px-3 py-2">
          <div className="relative">
            <IconSearch className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => handleSearch(event.target.value)}
              placeholder={t(
                'securitySettings.userStatus.searchPlaceholder',
                '搜索用户名'
              )}
              className="w-56 pl-9"
            />
          </div>
          {pageItems.length > 0 && (
            <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
              <Checkbox
                checked={allPageSelected}
                onCheckedChange={(checked) =>
                  toggleSelectPage(checked === true)
                }
              />
              {t('securitySettings.userStatus.selectAllOnPage', '本页全选')}
            </label>
          )}
        </div>
      )}

      <div className="space-y-2 px-3 py-3">
        {isLoading && (
          <p className="text-sm text-muted-foreground">
            {t('common.messages.loading', '加载中...')}
          </p>
        )}
        {!isLoading && error && (
          <p className="text-sm text-destructive">
            {t('common.messages.failedToLoad', {
              resource: t('securitySettings.userStatus.title', '用户状态'),
              defaultValue: '加载失败',
            })}
          </p>
        )}
        {!isLoading && !error && pageItems.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {filtered.length === 0 && users.length > 0
              ? t('common.messages.noResults', '没有匹配的结果')
              : t('securitySettings.userStatus.empty', '暂无被自动禁用的账号')}
          </p>
        )}
        {pageItems.map((account) => (
          <div
            key={account.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
          >
            <div className="flex min-w-0 items-center gap-2">
              {!readOnly && (
                <Checkbox
                  checked={selected.includes(account.id)}
                  onCheckedChange={(checked) =>
                    toggleSelect(account.id, checked === true)
                  }
                  aria-label={account.username}
                />
              )}
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {account.username}
                  <Badge variant="destructive">
                    {t('common.fields.disabled', '已禁用')}
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground">
                  {t('securitySettings.userStatus.reason', '原因')}：
                  {t(
                    `securitySettings.userStatus.reasons.${account.disabledReason ?? 'unknown'}`,
                    '长期未登录（自动禁用）'
                  )}
                  {account.disabledAt &&
                    ` · ${new Date(account.disabledAt).toLocaleString()}`}
                </div>
              </div>
            </div>
            {!readOnly && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleRestore(account)}
              >
                {t('securitySettings.userStatus.restore', '恢复')}
              </Button>
            )}
          </div>
        ))}
      </div>

      {filtered.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-3 py-2">
          <span className="text-xs text-muted-foreground">
            {t(
              'securitySettings.userStatus.totalAccounts',
              '共 {{count}} 个账号',
              {
                count: filtered.length,
              }
            )}
          </span>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {t('securitySettings.userStatus.rowsPerPage', '每页行数')}
              </span>
              <Select value={`${pageSize}`} onValueChange={handlePageSize}>
                <SelectTrigger size="sm" className="w-20">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAGE_SIZE_OPTIONS.map((size) => (
                    <SelectItem key={size} value={`${size}`}>
                      {size}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <span className="text-xs font-medium">
              {t(
                'securitySettings.userStatus.pageOf',
                '第 {{page}} / {{total}} 页',
                {
                  page: safePage + 1,
                  total: pageCount,
                }
              )}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                disabled={safePage === 0}
                onClick={() => setPageIndex(safePage - 1)}
                title={t('securitySettings.userStatus.prevPage', '上一页')}
              >
                <IconChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                disabled={safePage >= pageCount - 1}
                onClick={() => setPageIndex(safePage + 1)}
                title={t('securitySettings.userStatus.nextPage', '下一页')}
              >
                <IconChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
