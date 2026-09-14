import { useCallback, useMemo, useState } from 'react'
import {
  ColumnDef,
  getCoreRowModel,
  PaginationState,
  useReactTable,
} from '@tanstack/react-table'
import { useTranslation } from 'react-i18next'

import { LoginRecord } from '@/types/api'
import { useLoginLogs, useUserList } from '@/lib/api'
import { formatDate } from '@/lib/utils'
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

export function LoginLog() {
  const { t } = useTranslation()
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 20,
  })
  const [userId, setUserId] = useState<number | undefined>(undefined)
  const [searchQuery, setSearchQuery] = useState('')

  const { data: usersData } = useUserList(1, 200)
  const {
    data: loginData,
    isLoading,
    error,
  } = useLoginLogs(
    pagination.pageIndex + 1,
    pagination.pageSize,
    userId,
    searchQuery
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

  const columns = useMemo<ColumnDef<LoginRecord>[]>(
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
        cell: ({ row }) => (
          <span
            className="text-muted-foreground block max-w-[420px] truncate text-xs"
            title={row.original.userAgent}
          >
            {row.original.userAgent || '-'}
          </span>
        ),
      },
    ],
    [t]
  )

  const table = useReactTable({
    data: loginData?.data ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
    state: { pagination },
    onPaginationChange: setPagination,
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
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>{t('common.fields.loginLogs', 'Login Logs')}</CardTitle>
            <p className="text-muted-foreground text-sm">
              {t(
                'common.messages.loginLogsDescription',
                'Review every successful sign-in and its source IP'
              )}
            </p>
          </div>
          <div className="flex items-center gap-3">
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
          hasActiveFilters={Boolean(userId) || Boolean(searchQuery)}
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
