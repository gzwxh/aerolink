import { useCallback, useMemo, useState } from 'react'
import {
  ColumnDef,
  getCoreRowModel,
  PaginationState,
  useReactTable,
} from '@tanstack/react-table'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import type { ArchiveBackend, ArchiveKind } from '@/types/api'
import {
  AuditTimeRange,
  exportArchiveRecords,
  useArchiveBackends,
  useArchiveRecords,
  useClusterList,
} from '@/lib/api'
import { defaultAuditTimeRange } from '@/lib/audit-time-range'
import { decodeClusterName } from '@/lib/current-cluster'
import { isLoginSuccess, statusBadge, statusText } from '@/lib/status-badge'
import { migrateLegacyKiteStorageKey } from '@/lib/storage-migration'
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

/**
 * 归档检索的一条记录。
 *
 * ES 文档是原样透传的 `_source`，字段名与方案 §5 的 schema 一致（snake_case）。
 * 用 Record 而不是具体接口：不同 kind 的字段集不同，且未来加字段不该让界面编译失败。
 */
type ArchiveRow = Record<string, unknown>

const ARCHIVE_KINDS: ArchiveKind[] = ['audit', 'login', 'access']
const ACCESS_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

/** 本地记住的「检索后端」偏好键（旧键名随产品改名迁移）。 */
const ARCHIVE_BACKEND_STORAGE_KEY = 'aerolink-archive-query-backend'

/** 可选的检索后端（与后端 archiveBackendName 一一对应）：用于校验本地记住的选择。 */
const ARCHIVE_BACKENDS: ArchiveBackend[] = [
  'elasticsearch',
  'duckdb',
  'victorialogs',
  'openobserve',
]

function display(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '-'
  }
  return String(value)
}

function displayTime(value: unknown): string {
  if (typeof value !== 'string' || !value) {
    return '-'
  }
  return formatDate(value)
}

/** 纯文本列：字段名与 schema 一一对应，避免每列都写一遍 cell。 */
function textColumn(
  id: string,
  header: string,
  key: string,
  // 需要把原始值转成可读文本时用它（例如集群名要先解码）。
  format?: (value: unknown) => string
): ColumnDef<ArchiveRow> {
  return {
    id,
    header,
    cell: ({ row }) => {
      const text = format ? format(row.original[key]) : display(row.original[key])
      // truncate：归档里的路径、UA 可能很长，不截断会把相邻列挤变形。
      return (
        <span className="block truncate text-sm" title={text}>
          {text}
        </span>
      )
    },
  }
}

/**
 * 日志审计 → 归档检索。
 *
 * 检索的是**已被本地滚留清理、但已归档**的历史记录（parquet / S3 / ES / VictoriaLogs /
 * OpenObserve），所以它与本地列表页互补：本地列表看"还在库里的"，这一页看"归档出去的"。
 *
 * 检索后端跟随 sink（五选一互斥）；不可用时后端明确返回错误，这里给管理员可执行的引导，
 * 而不是显示一张空表让人误以为没有数据。
 */
export function ArchiveQuery() {
  const { t } = useTranslation()
  const [kind, setKind] = useState<ArchiveKind>('audit')
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 20,
  })
  const [columnVisibility, setColumnVisibility] = useTableColumnVisibility(
    'aerolink-archive-query-columnVisibility'
  )
  const [timeRange, setTimeRange] = useState<AuditTimeRange>(() =>
    defaultAuditTimeRange()
  )
  const [searchQuery, setSearchQuery] = useState('')
  const [clusterFilter, setClusterFilter] = useState('all')
  const [outcome, setOutcome] = useState<'all' | 'success' | 'failure'>('all')
  const [method, setMethod] = useState('all')
  const [statusCode, setStatusCode] = useState('')
  // 留空表示「用服务端给的默认后端」（默认跟随 sink）。不同存储方式下可用的后端不同，
  // 有特定检索需求的部署主动选一次即可，所以把选择记在本地，不必每次进来重选。
  const [backend, setBackend] = useState<ArchiveBackend | ''>(() => {
    migrateLegacyKiteStorageKey(localStorage, ARCHIVE_BACKEND_STORAGE_KEY)
    const saved = window.localStorage.getItem(ARCHIVE_BACKEND_STORAGE_KEY)
    return ARCHIVE_BACKENDS.includes(saved as ArchiveBackend)
      ? (saved as ArchiveBackend)
      : ''
  })

  const { data: clusters = [] } = useClusterList()
  const { data: backends } = useArchiveBackends()

  // 本地记住的后端可能已经不可用（sink 改了、或该后端被停用）：这时回落到服务端给的默认
  // 后端，而不是带着一个必然失败的选项去查询（那只会拿到一句报错）。服务端列表还没到
  // （`backends` 为空）时先按记住的值查，避免多一次无谓的重查。
  const savedBackendUsable =
    backend &&
    (backends?.backends.some(
      (item) => item.name === backend && item.available
    ) ??
      true)
  const effectiveBackend = savedBackendUsable
    ? backend
    : backends?.default || undefined

  const query = useMemo(() => {
    const shared = {
      page: pagination.pageIndex + 1,
      size: pagination.pageSize,
      range: timeRange,
      search: searchQuery.trim() || undefined,
      backend: effectiveBackend,
      cluster: clusterFilter === 'all' ? undefined : clusterFilter,
    }
    if (kind === 'login') {
      return {
        ...shared,
        cluster: undefined,
        outcome: outcome === 'all' ? undefined : outcome,
      }
    }
    if (kind === 'access') {
      return {
        ...shared,
        method: method === 'all' ? undefined : method,
        statusCode: statusCode.trim() || undefined,
      }
    }
    return shared
  }, [
    clusterFilter,
    effectiveBackend,
    kind,
    method,
    outcome,
    pagination,
    searchQuery,
    statusCode,
    timeRange,
  ])

  const { data, isLoading, error } = useArchiveRecords<ArchiveRow>(kind, query)

  // 检索后端不可用时后端返回明确的 400（例如 ES 未启用、DuckDB CLI 又没装），
  // 而不是空列表；据此给出可执行的引导，避免显示一张让人误以为「没有数据」的空表。
  const backendUnavailable = Boolean(
    error && /unavailable|not enabled/i.test(error.message)
  )

  const resetPage = useCallback(() => {
    setPagination((prev) => ({ ...prev, pageIndex: 0 }))
  }, [])

  // 导出当前筛选条件下的归档记录。后端按 ES 翻页拉取全量，不受当前页码影响；
  // 命中数超过 ES 的 from+size 上限时会截断，导出的条目数会小于检索到的总数。
  const handleExport = useCallback(
    () => exportArchiveRecords(kind, query),
    [kind, query]
  )

  const columns = useMemo<ColumnDef<ArchiveRow>[]>(() => {
    if (kind === 'login') {
      return [
        {
          id: 'time',
          header: t('common.fields.time', 'Time'),
          cell: ({ row }) => (
            <span className="text-muted-foreground text-sm">
              {displayTime(row.original.created_at)}
            </span>
          ),
        },
        {
          id: 'result',
          header: t('common.fields.result', 'Result'),
          cell: ({ row }) => {
            // 成功（`success` 或历史空值）→ 绿；其余是失败码 → 红（判定见 isLoginSuccess）。
            const result = row.original.result
            if (isLoginSuccess(result)) {
              return (
                <span
                  className={`text-sm font-medium ${statusText('success')}`}
                >
                  {t('status.success', 'Success')}
                </span>
              )
            }
            return (
              <span
                className={`text-sm font-medium ${statusText('failure')}`}
                title={display(result)}
              >
                {t(`audit.loginResult.${String(result)}`, display(result))}
              </span>
            )
          },
        },
        textColumn(
          'username',
          t('common.fields.username', 'Username'),
          'username'
        ),
        textColumn(
          'provider',
          t('common.fields.provider', 'Provider'),
          'provider'
        ),
        textColumn('ip', t('common.fields.ip', 'IP'), 'ip'),
        textColumn(
          'userAgent',
          t('common.fields.userAgent', 'Client'),
          'user_agent'
        ),
      ]
    }

    if (kind === 'access') {
      return [
        {
          id: 'time',
          header: t('common.fields.time', 'Time'),
          cell: ({ row }) => (
            <span className="text-muted-foreground text-sm">
              {displayTime(row.original.ts)}
            </span>
          ),
        },
        textColumn('method', t('common.fields.method', 'Method'), 'method'),
        textColumn('path', t('common.fields.path', 'Path'), 'path'),
        {
          id: 'statusCode',
          header: t('common.fields.statusCode', 'Status'),
          cell: ({ row }) => {
            const code = Number(row.original.status_code ?? 0)
            if (!code) {
              return <span className="text-muted-foreground">-</span>
            }
            if (code >= 400) {
              const badge = statusBadge('failure')
              return (
                <Badge variant={badge.variant} className={badge.className}>
                  {code}
                </Badge>
              )
            }
            return <Badge variant="secondary">{code}</Badge>
          },
        },
        {
          id: 'latency',
          header: t('common.fields.latency', 'Latency'),
          cell: ({ row }) => (
            <span className="font-mono text-sm">
              {display(row.original.latency_ms)} ms
            </span>
          ),
        },
        textColumn(
          'cluster',
          t('common.fields.cluster', 'Cluster'),
          'cluster',
          // 归档里的集群名同样是 URL 编码串（历史写入所致）。
          (value) => decodeClusterName(value as string) || '-'
        ),
        textColumn('user', t('common.fields.user', 'User'), 'user'),
        textColumn(
          'clientIp',
          t('common.fields.clientIp', 'Client IP'),
          'client_ip'
        ),
      ]
    }

    return [
      {
        id: 'time',
        header: t('common.fields.time', 'Time'),
        cell: ({ row }) => (
          <span className="text-muted-foreground text-sm">
            {displayTime(row.original.created_at)}
          </span>
        ),
      },
      {
        id: 'result',
        header: t('common.fields.result', 'Result'),
        cell: ({ row }) => {
          const tone = statusText(
            row.original.success === true ? 'success' : 'failure'
          )
          return row.original.success === true ? (
            <span className={`text-sm font-medium ${tone}`}>
              {t('status.success', 'Success')}
            </span>
          ) : (
            <span
              className={`text-sm font-medium ${tone}`}
              title={display(row.original.error_message)}
            >
              {t('status.failed', 'Failed')}
            </span>
          )
        },
      },
      textColumn(
        'operator',
        t('common.fields.operator', 'Operator'),
        'operator_name'
      ),
      textColumn(
        'operation',
        t('common.fields.operation', 'Operation'),
        'operation_type'
      ),
      {
        id: 'resource',
        header: t('common.fields.resource', 'Resource'),
        cell: ({ row }) => {
          const type = display(row.original.resource_type)
          const name = display(row.original.resource_name)
          return (
            <span className="text-sm">
              {type}
              {name === '-' ? '' : `/${name}`}
            </span>
          )
        },
      },
      textColumn(
        'namespace',
        t('common.fields.namespace', 'Namespace'),
        'namespace'
      ),
      textColumn(
        'cluster',
        t('common.fields.cluster', 'Cluster'),
        'cluster_name'
      ),
      textColumn(
        'clientIp',
        t('common.fields.clientIp', 'Client IP'),
        'client_ip'
      ),
    ]
  }, [kind, t])

  const table = useReactTable({
    data: data?.data ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
    state: { pagination, columnVisibility },
    onPaginationChange: setPagination,
    onColumnVisibilityChange: setColumnVisibility,
    manualPagination: true,
    pageCount: Math.ceil((data?.total ?? 0) / pagination.pageSize) || 0,
  })

  const hasActiveFilters =
    Boolean(searchQuery) ||
    Boolean(timeRange.from || timeRange.to) ||
    clusterFilter !== 'all' ||
    outcome !== 'all' ||
    method !== 'all' ||
    Boolean(statusCode)

  const emptyState = (() => {
    if (isLoading) {
      return (
        <div className="py-10 text-center text-muted-foreground">
          {t('common.messages.loadingResource', {
            resource: t('audit.archive.resource', '归档记录'),
            defaultValue: 'Loading archived records...',
          })}
        </div>
      )
    }
    if (error) {
      return (
        <div className="py-10 text-center text-destructive">
          {t('audit.archive.failed', '归档检索失败：{{message}}', {
            message: error.message,
          })}
        </div>
      )
    }
    if ((data?.data.length ?? 0) === 0) {
      return (
        <div className="py-10 text-center text-muted-foreground">
          {t(
            'audit.archive.empty',
            '没有匹配的归档记录。归档写入是异步的，刚发生的操作可能还没落进检索索引。'
          )}
        </div>
      )
    }
    return null
  })()

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="truncate">
              {t('audit.archive.title', '归档检索')}
            </CardTitle>
            <p className="text-muted-foreground text-sm">
              {t(
                'audit.archive.description',
                '检索已经归档出去的历史日志。本地已清理的记录在这里仍可查到。'
              )}
              {data?.backend && (
                <span className="ml-2">
                  {t('audit.archive.backendLabel', '数据来源')}：
                  {t(`audit.archive.backend.${data.backend}`, data.backend)}
                </span>
              )}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <AuditTimeRangePicker
              value={timeRange}
              onChange={(value) => {
                resetPage()
                setTimeRange(value)
              }}
            />
            <Select
              value={kind}
              onValueChange={(value) => {
                resetPage()
                setKind(value as ArchiveKind)
              }}
            >
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ARCHIVE_KINDS.map((item) => (
                  <SelectItem key={item} value={item}>
                    {t(`audit.archive.kind.${item}`, item)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* 检索后端：配置了 ES 才能选 ES，否则默认 DuckDB（直接查 parquet）。 */}
            {backends && backends.backends.length > 0 && (
              <Select
                value={effectiveBackend ?? ''}
                onValueChange={(value) => {
                  resetPage()
                  setBackend(value as ArchiveBackend)
                  window.localStorage.setItem(
                    ARCHIVE_BACKEND_STORAGE_KEY,
                    value
                  )
                }}
              >
                <SelectTrigger className="w-44">
                  <SelectValue
                    placeholder={t('audit.archive.backendLabel', '数据来源')}
                  />
                </SelectTrigger>
                <SelectContent>
                  {backends.backends.map((item) => (
                    <SelectItem
                      key={item.name}
                      value={item.name}
                      disabled={!item.available}
                    >
                      {t(`audit.archive.backend.${item.name}`, item.name)}
                      {!item.available &&
                        ` · ${t('audit.archive.backendDisabled', '未配置')}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Input
              placeholder={t(
                'audit.archive.searchPlaceholder',
                '搜索关键字...'
              )}
              value={searchQuery}
              onChange={(event) => {
                resetPage()
                setSearchQuery(event.target.value)
              }}
              className="w-52"
            />

            {kind === 'login' && (
              <Select
                value={outcome}
                onValueChange={(value) => {
                  resetPage()
                  setOutcome(value as 'all' | 'success' | 'failure')
                }}
              >
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    {t('common.values.all', '全部')}
                  </SelectItem>
                  <SelectItem value="success">
                    {t('status.success', '成功')}
                  </SelectItem>
                  <SelectItem value="failure">
                    {t('status.failed', '失败')}
                  </SelectItem>
                </SelectContent>
              </Select>
            )}

            {kind === 'access' && (
              <>
                <Select
                  value={method}
                  onValueChange={(value) => {
                    resetPage()
                    setMethod(value)
                  }}
                >
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">
                      {t('common.values.all', '全部')}
                    </SelectItem>
                    {ACCESS_METHODS.map((item) => (
                      <SelectItem key={item} value={item}>
                        {item}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  inputMode="numeric"
                  placeholder={t('audit.archive.statusCode', '状态码')}
                  value={statusCode}
                  onChange={(event) => {
                    resetPage()
                    setStatusCode(event.target.value.replace(/\D/g, ''))
                  }}
                  className="w-28"
                />
              </>
            )}

            {(kind === 'audit' || kind === 'access') && clusters.length > 1 && (
              <Select
                value={clusterFilter}
                onValueChange={(value) => {
                  resetPage()
                  setClusterFilter(value)
                }}
              >
                <SelectTrigger className="w-40">
                  <SelectValue
                    placeholder={t('common.values.allClusters', '全部集群')}
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    {t('common.values.allClusters', '全部集群')}
                  </SelectItem>
                  {clusters.map((cluster) => (
                    <SelectItem key={cluster.id} value={cluster.name}>
                      {cluster.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            <AuditExportButton onExport={handleExport} />
            <TableColumnToggle table={table} />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {backendUnavailable ? (
          <div className="rounded-lg border border-dashed p-6 text-sm">
            <p className="font-medium">
              {t('audit.archive.disabledTitle', '归档检索暂不可用')}
            </p>
            <p className="mt-1 text-muted-foreground">
              {backends?.sink === 'database'
                ? t(
                    'audit.archive.disabledSinkHint',
                    '当前审计落地方式是「数据库」（auditSink=database，默认）：记录都在库里，没有归档可查，归档通道的开关也已按互斥关闭。要用归档检索，请在配置文件里把 auditSink 改成 parquet / elasticsearch / victorialogs / openobserve 后重启。'
                  )
                : t(
                    'audit.archive.disabledHint',
                    '检索后端跟随存储方式：Elasticsearch、DuckDB（直接查 parquet，无需额外部署组件）、VictoriaLogs 或 OpenObserve。当前存储方式对应的后端还不可用，请在「审计设置 → 归档」补齐配置后重试。'
                  )}
            </p>
            <Link
              to="?tab=setting"
              className="mt-3 inline-block text-primary underline-offset-4 hover:underline"
            >
              {t('audit.archive.goToSetting', '前往审计设置')}
            </Link>
          </div>
        ) : (
          <ResourceTableView
            table={table}
            columnCount={columns.length}
            isLoading={isLoading}
            data={data?.data}
            allPageSize={data?.total ?? 0}
            emptyState={emptyState}
            hasActiveFilters={hasActiveFilters}
            filteredRowCount={data?.data.length ?? 0}
            totalRowCount={data?.total ?? 0}
            searchQuery={searchQuery}
            pagination={pagination}
            setPagination={setPagination}
            maxBodyHeightClassName="max-h-[600px]"
          />
        )}
      </CardContent>
    </Card>
  )
}
