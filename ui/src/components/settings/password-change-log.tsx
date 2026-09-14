import { useCallback, useMemo, useState } from 'react'
import {
  ColumnDef,
  getCoreRowModel,
  PaginationState,
  useReactTable,
} from '@tanstack/react-table'
import { useTranslation } from 'react-i18next'

import { PasswordChangeLog as PasswordChangeLogItem } from '@/types/api'
import { usePasswordChangeLogs, useUserList } from '@/lib/api'
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

export function PasswordChangeLog() {
  const { t } = useTranslation()
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 20,
  })
  const [userId, setUserId] = useState<number | undefined>(undefined)
  const [searchQuery, setSearchQuery] = useState('')

  const { data: usersData } = useUserList(1, 200)
  const {
    data: logData,
    isLoading,
    error,
  } = usePasswordChangeLogs(
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
    state: { pagination },
    onPaginationChange: setPagination,
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
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>
              {t('common.fields.passwordChangeLogs', 'Password Change Logs')}
            </CardTitle>
            <p className="text-muted-foreground text-sm">
              {t(
                'common.messages.passwordChangeLogsDescription',
                'Review who changed a password and when'
              )}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Input
              placeholder={t(
                'common.placeholders.searchUsers',
                'Search users...'
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
          data={logData?.data}
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
