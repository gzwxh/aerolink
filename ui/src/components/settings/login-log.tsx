import { useCallback, useMemo, useState } from 'react'
import {
  ColumnDef,
  getCoreRowModel,
  PaginationState,
  useReactTable,
} from '@tanstack/react-table'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { LoginRecord } from '@/types/api'
import {
  AuditTimeRange,
  exportLoginLogs,
  useLoginLogs,
  useUserList,
} from '@/lib/api'
import { copyToClipboard } from '@/lib/clipboard'
import { formatDate } from '@/lib/utils'
import { useTableColumnVisibility } from '@/hooks/use-table-column-visibility'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { ResourceTableView } from '@/components/resource-table-view'
import { TableColumnToggle } from '@/components/table-column-toggle'

import { AuditExportButton, AuditTimeRangePicker } from './audit-filters'

export function LoginLog() {
  const { t } = useTranslation()
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 20,
  })
  // 列显示偏好：与资源列表（/deployments 等）一致，齿轮菜单勾选 + 持久化。
  // 日志是全局数据，键不带集群前缀。
  const [columnVisibility, setColumnVisibility] = useTableColumnVisibility(
    'kite-login-logs-columnVisibility'
  )
  const [userId, setUserId] = useState<number | undefined>(undefined)
  const [searchQuery, setSearchQuery] = useState('')
  const [outcome, setOutcome] = useState<'success' | 'failure' | undefined>(
    undefined
  )
  const [timeRange, setTimeRange] = useState<AuditTimeRange>({})

  const { data: usersData } = useUserList(1, 200)
  const {
    data: loginData,
    isLoading,
    error,
  } = useLoginLogs(
    pagination.pageIndex + 1,
    pagination.pageSize,
    userId,
    searchQuery,
    outcome,
    timeRange
  )

  const handleOutcomeFilterChange = useCallback((value: string) => {
    setPagination((prev) => ({ ...prev, pageIndex: 0 }))
    if (value === 'all') {
      setOutcome(undefined)
      return
    }
    setOutcome(value === 'failure' ? 'failure' : 'success')
  }, [])

  const handleUserFilterChange = useCallback((value: string) => {
    setPagination((prev) => ({ ...prev, pageIndex: 0 }))
    if (value === 'all') {
      setUserId(undefined)
      return
    }
    const parsed = Number(value)
    setUserId(Number.isNaN(parsed) ? undefined : parsed)
  }, [])

  const handleSearchChange = useCallback((value: string) => {
    setPagination((prev) => ({ ...prev, pageIndex: 0 }))
    setSearchQuery(value)
  }, [])

  const handleTimeRangeChange = useCallback((value: AuditTimeRange) => {
    setPagination((prev) => ({ ...prev, pageIndex: 0 }))
    setTimeRange(value)
  }, [])

  const handleExport = useCallback(
    () => exportLoginLogs(userId, searchQuery, outcome, timeRange),
    [outcome, searchQuery, timeRange, userId]
  )

  // 客户端信息通常很长，列表里截断展示；点一下复制完整内容。
  const copyClient = useCallback(
    async (value: string) => {
      if (await copyToClipboard(value)) {
        toast.success(t('common.messages.copied', '已复制到剪贴板'))
      } else {
        toast.error(
          t('common.messages.copyFailed', '复制失败，请手动选择文本后复制')
        )
      }
    },
    [t]
  )

  const columns = useMemo<ColumnDef<LoginRecord>[]>(() => {
    // 失败原因码 → 文案。空/缺失 = 成功登录（result 列是后加的，历史行为空）。
    const failureReason = (result: string | null | undefined) => {
      if (!result) {
        return null
      }
      return t(`audit.loginResult.${result}`, result)
    }

    return [
      {
        id: 'time',
        header: t('common.fields.time', 'Time'),
        cell: ({ row }) => (
          <span className="text-muted-foreground text-sm">
            {formatDate(row.original.createdAt)}
          </span>
        ),
      },
      {
        id: 'result',
        header: t('common.fields.result', 'Result'),
        cell: ({ row }) => {
          const reason = failureReason(row.original.result)
          if (!reason) {
            return (
              <Badge variant="default">{t('status.success', 'Success')}</Badge>
            )
          }
          return (
            <Badge variant="destructive" title={row.original.result ?? ''}>
              {reason}
            </Badge>
          )
        },
      },
      {
        id: 'username',
        header: t('common.fields.username', 'Username'),
        cell: ({ row }) => (
          <div className="font-medium">{row.original.username || '-'}</div>
        ),
      },
      {
        id: 'provider',
        header: t('common.fields.provider', 'Provider'),
        cell: ({ row }) => (
          <Badge variant="secondary">{row.original.provider || '-'}</Badge>
        ),
      },
      {
        id: 'ip',
        header: t('common.fields.ip', 'IP'),
        cell: ({ row }) => (
          <span className="font-mono text-sm">{row.original.ip || '-'}</span>
        ),
      },
      {
        id: 'userAgent',
        header: t('common.fields.userAgent', 'Client'),
        cell: ({ row }) => {
          const userAgent = row.original.userAgent
          if (!userAgent) {
            return <span className="text-muted-foreground">-</span>
          }
          return (
            // inline-block 才能跟随列的居中（block 会占满单元格而偏左）。
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => void copyClient(userAgent)}
                  aria-label={t('loginLog.copyClient', '复制客户端信息')}
                  className="inline-block max-w-[420px] cursor-pointer truncate rounded bg-transparent px-1 text-left align-middle text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {userAgent}
                </button>
              </TooltipTrigger>
              <TooltipContent
                side="top"
                className="max-h-72 max-w-96 overflow-y-auto whitespace-normal break-all border bg-popover text-xs text-popover-foreground shadow-md"
              >
                <div>{userAgent}</div>
                <div className="mt-1 text-muted-foreground">
                  {t('loginLog.clickToCopy', '点击复制')}
                </div>
              </TooltipContent>
            </Tooltip>
          )
        },
      },
    ]
  }, [copyClient, t])

  const table = useReactTable({
    data: loginData?.data ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
    state: { pagination, columnVisibility },
    onPaginationChange: setPagination,
    onColumnVisibilityChange: setColumnVisibility,
    manualPagination: true,
    pageCount: Math.ceil((loginData?.total ?? 0) / pagination.pageSize) || 0,
  })

  const emptyState = (() => {
    if (isLoading) {
      return (
        <div className="py-10 text-center text-muted-foreground">
          {t('common.messages.loadingResource', {
            resource: t('common.fields.loginLogs', 'login logs'),
            defaultValue: 'Loading login logs...',
          })}
        </div>
      )
    }
    if (error) {
      return (
        <div className="py-10 text-center text-destructive">
          {t('common.messages.failedToLoad', {
            resource: t('common.fields.loginLogs', 'login logs'),
            defaultValue: 'Failed to load login logs',
          })}
        </div>
      )
    }
    if ((loginData?.data.length ?? 0) === 0) {
      return (
        <div className="py-10 text-center text-muted-foreground">
          {t('common.messages.noItemsFound', {
            resource: t('common.fields.loginLogs', 'login logs'),
            defaultValue: 'No login logs found',
          })}
        </div>
      )
    }
    return null
  })()

  const totalRowCount = loginData?.total ?? 0
  const filteredRowCount = loginData?.data.length ?? 0

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>{t('common.fields.loginLogs', 'Login Logs')}</CardTitle>
            <p className="text-muted-foreground text-sm">
              {t(
                'common.messages.loginLogsDescription',
                'Review every sign-in attempt, successful or rejected, and its source IP'
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3">
            <AuditTimeRangePicker
              value={timeRange}
              onChange={handleTimeRangeChange}
            />
            <Input
              placeholder={t(
                'common.placeholders.searchUsernameOrIP',
                'Search username or IP...'
              )}
              value={searchQuery}
              onChange={(event) => handleSearchChange(event.target.value)}
              className="w-64"
            />
            <Select
              value={outcome ?? 'all'}
              onValueChange={handleOutcomeFilterChange}
            >
              <SelectTrigger className="w-40">
                <SelectValue placeholder={t('common.values.all', '全部')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  {t('common.values.all', '全部')}
                </SelectItem>
                <SelectItem value="success">
                  {t('status.success', 'Success')}
                </SelectItem>
                <SelectItem value="failure">
                  {t('status.failed', 'Failed')}
                </SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={userId ? String(userId) : 'all'}
              onValueChange={handleUserFilterChange}
            >
              <SelectTrigger className="w-56">
                <SelectValue
                  placeholder={t('common.values.allUsers', 'All users')}
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  {t('common.values.allUsers', 'All users')}
                </SelectItem>
                {(usersData?.users ?? []).map((user) => (
                  <SelectItem key={user.id} value={String(user.id)}>
                    {user.username}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <AuditExportButton onExport={handleExport} />
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
          data={loginData?.data}
          allPageSize={totalRowCount}
          emptyState={emptyState}
          hasActiveFilters={
            Boolean(userId) ||
            Boolean(searchQuery) ||
            Boolean(outcome) ||
            Boolean(timeRange.from || timeRange.to)
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
  )
}
