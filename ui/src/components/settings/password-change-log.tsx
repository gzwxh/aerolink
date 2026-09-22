import { useCallback, useMemo, useState } from 'react'
import {
  ColumnDef,
  getCoreRowModel,
  PaginationState,
  useReactTable,
} from '@tanstack/react-table'
import { useTranslation } from 'react-i18next'

import { PasswordChangeLog as PasswordChangeLogItem } from '@/types/api'
import {
  AuditTimeRange,
  exportPasswordChangeLogs,
  usePasswordChangeLogs,
  useUserList,
} from '@/lib/api'
import { defaultAuditTimeRange } from '@/lib/audit-time-range'
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
import { ResourceTableView } from '@/components/resource-table-view'
import { TableColumnToggle } from '@/components/table-column-toggle'

import { AuditExportButton } from './audit-filters'
import { AuditTimeRangePicker } from './audit-time-range-picker'

export function PasswordChangeLog() {
  const { t } = useTranslation()
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 20,
  })
  // 列显示偏好：与资源列表（/deployments 等）一致，齿轮菜单勾选 + 持久化。
  // 日志是全局数据，键不带集群前缀。
  const [columnVisibility, setColumnVisibility] = useTableColumnVisibility(
    'aerolink-password-change-logs-columnVisibility'
  )
  const [userId, setUserId] = useState<number | undefined>(undefined)
  const [searchQuery, setSearchQuery] = useState('')
  // 默认按最近一周过滤：界面一进来就有具体区间可显示，查询与显示保持一致。
  const [timeRange, setTimeRange] = useState<AuditTimeRange>(() =>
    defaultAuditTimeRange()
  )

  const { data: usersData } = useUserList(1, 200)
  const {
    data: logData,
    isLoading,
    error,
  } = usePasswordChangeLogs(
    pagination.pageIndex + 1,
    pagination.pageSize,
    userId,
    searchQuery,
    timeRange
  )

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
    () => exportPasswordChangeLogs(userId, searchQuery, timeRange),
    [searchQuery, timeRange, userId]
  )

  const getSourceLabel = useCallback(
    (source: string) =>
      source === 'admin'
        ? t('common.values.passwordChangeAdmin', 'Admin reset')
        : t('common.values.passwordChangeSelf', 'Self'),
    [t]
  )

  const columns = useMemo<ColumnDef<PasswordChangeLogItem>[]>(
    () => [
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
        id: 'username',
        header: t('common.fields.username', 'Username'),
        cell: ({ row }) => (
          <div className="font-medium">{row.original.username || '-'}</div>
        ),
      },
      {
        id: 'source',
        header: t('common.fields.source', 'Source'),
        cell: ({ row }) => (
          <Badge
            variant={row.original.source === 'admin' ? 'secondary' : 'default'}
          >
            {getSourceLabel(row.original.source)}
          </Badge>
        ),
      },
      {
        id: 'operator',
        header: t('common.fields.operator', 'Operator'),
        cell: ({ row }) => (
          <span className="text-sm">{row.original.operator || '-'}</span>
        ),
      },
    ],
    [getSourceLabel, t]
  )

  const table = useReactTable({
    data: logData?.data ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
    state: { pagination, columnVisibility },
    onPaginationChange: setPagination,
    onColumnVisibilityChange: setColumnVisibility,
    manualPagination: true,
    pageCount: Math.ceil((logData?.total ?? 0) / pagination.pageSize) || 0,
  })

  const emptyState = (() => {
    if (isLoading) {
      return (
        <div className="py-10 text-center text-muted-foreground">
          {t('common.messages.loadingResource', {
            resource: t('common.fields.passwordChangeLogs', 'password logs'),
            defaultValue: 'Loading password change logs...',
          })}
        </div>
      )
    }
    if (error) {
      return (
        <div className="py-10 text-center text-destructive">
          {t('common.messages.failedToLoad', {
            resource: t('common.fields.passwordChangeLogs', 'password logs'),
            defaultValue: 'Failed to load password change logs',
          })}
        </div>
      )
    }
    if ((logData?.data.length ?? 0) === 0) {
      return (
        <div className="py-10 text-center text-muted-foreground">
          {t('common.messages.noItemsFound', {
            resource: t('common.fields.passwordChangeLogs', 'password logs'),
            defaultValue: 'No password change logs found',
          })}
        </div>
      )
    }
    return null
  })()

  const totalRowCount = logData?.total ?? 0
  const filteredRowCount = logData?.data.length ?? 0

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* 标题让位给右侧筛选栏：窗口不够宽时先压标题，不去挤筛选栏换行。 */}
          <div className="min-w-0">
            <CardTitle className="truncate">
              {t('common.fields.passwordChangeLogs', 'Password Change Logs')}
            </CardTitle>
            <p className="text-muted-foreground text-sm">
              {t(
                'common.messages.passwordChangeLogsDescription',
                'Review who changed a password and when'
              )}
            </p>
            {/* 同 audit-log：数据来自归档时必须明示延迟。 */}
            {logData?.backend && (
              <p className="text-muted-foreground mt-1 text-xs">
                {t(
                  'common.messages.archiveSourceNotice',
                  '数据来自归档（{{backend}}），不含最近约 {{seconds}} 秒内的操作',
                  {
                    backend: logData.backend,
                    seconds: logData.queryDelaySeconds ?? 120,
                  }
                )}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center justify-end gap-2">
            <AuditTimeRangePicker
              value={timeRange}
              onChange={handleTimeRangeChange}
            />
            <Input
              placeholder={t(
                'common.placeholders.searchUsers',
                'Search users...'
              )}
              value={searchQuery}
              onChange={(event) => handleSearchChange(event.target.value)}
              className="w-52"
            />
            <Select
              value={userId ? String(userId) : 'all'}
              onValueChange={handleUserFilterChange}
            >
              <SelectTrigger className="w-40">
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
          data={logData?.data}
          allPageSize={totalRowCount}
          emptyState={emptyState}
          hasActiveFilters={
            Boolean(userId) ||
            Boolean(searchQuery) ||
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
