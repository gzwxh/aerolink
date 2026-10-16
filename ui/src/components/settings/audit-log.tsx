import { useCallback, useEffect, useMemo, useState } from 'react'
import { IconAlertCircle, IconEye } from '@tabler/icons-react'
import {
  ColumnDef,
  getCoreRowModel,
  PaginationState,
  useReactTable,
} from '@tanstack/react-table'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'

import { ResourceHistory } from '@/types/api'
import {
  AuditTimeRange,
  exportAuditLogs,
  useAuditLogs,
  useClusterList,
  useUserList,
} from '@/lib/api'
import { defaultAuditTimeRange } from '@/lib/audit-time-range'
import { decodeClusterName } from '@/lib/current-cluster'
import { operationTypeBadge, outcomeText } from '@/lib/status-badge'
import { formatDate } from '@/lib/utils'
import { useTableColumnSizing } from '@/hooks/use-table-column-preferences'
import { useTableColumnVisibility } from '@/hooks/use-table-column-visibility'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent } from '@/components/ui/tabs'
import { ResourceTableView } from '@/components/resource-table-view'
import { TableColumnToggle } from '@/components/table-column-toggle'
import { YamlDiffViewer } from '@/components/yaml-diff-viewer'

import { ArchiveQuery } from './archive-query'
import { AuditExportButton } from './audit-filters'
import { AuditSetting } from './audit-setting'
import { AuditTimeRangePicker } from './audit-time-range-picker'
import { LoginLog } from './login-log'
import { PasswordChangeLog } from './password-change-log'

// 容器文件操作（Pod 文件页的上传/下载/预览）以这三种操作类型写入审计。
const FILE_OPERATIONS = ['view-file', 'download-file', 'upload-file']

function isFileOperation(operationType: string): boolean {
  return FILE_OPERATIONS.includes(operationType.toLowerCase())
}

// 文件操作的 resourceYAML 形如 "container: X\npath: Y"，这里取出来在列表里直接展示。
function fileOperationTarget(resourceYaml?: string): string {
  if (!resourceYaml) return ''
  const fields: Record<string, string> = {}
  for (const line of resourceYaml.split('\n')) {
    const index = line.indexOf(':')
    if (index <= 0) continue
    fields[line.slice(0, index).trim()] = line.slice(index + 1).trim()
  }
  return [fields.container, fields.path].filter(Boolean).join(':')
}

interface OperationLogProps {
  /** 限定展示的操作类型（如容器文件的查看/下载/上传）；不传则展示全部操作。 */
  operations?: string[]
}

export function OperationLog({ operations }: OperationLogProps = {}) {
  const { t } = useTranslation()
  // 传入 operations 时该视图只展示这一类操作（如容器文件的查看/下载/上传），
  // 操作类型筛选随之隐藏，标题与说明也换成该视图的说法。
  const scoped = Boolean(operations?.length)
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 20,
  })
  // 列显示偏好：与资源列表（/deployments 等）一致，齿轮菜单勾选 + 持久化。
  // 日志是全局数据，键不带集群前缀。
  const [columnVisibility, setColumnVisibility] = useTableColumnVisibility(
    'aerolink-audit-logs-columnVisibility'
  )
  // 列宽偏好：与资源列表同一套交互（拖表头右缘调宽，双击复位）。
  const [columnSizing, setColumnSizing] = useTableColumnSizing(
    'aerolink-audit-logs-columnSizing'
  )
  const [operatorId, setOperatorId] = useState<number | undefined>(undefined)
  const [searchQuery, setSearchQuery] = useState('')
  const [operationFilter, setOperationFilter] = useState('')
  const [clusterFilter, setClusterFilter] = useState('')
  // 默认按最近一周过滤：界面一进来就有具体区间可显示，查询与显示保持一致。
  const [timeRange, setTimeRange] = useState<AuditTimeRange>(() =>
    defaultAuditTimeRange()
  )
  const [selectedHistory, setSelectedHistory] =
    useState<ResourceHistory | null>(null)
  const [isDiffOpen, setIsDiffOpen] = useState(false)
  const [isErrorDialogOpen, setIsErrorDialogOpen] = useState(false)

  const { data: usersData } = useUserList(1, 200)
  const { data: clusters = [] } = useClusterList()
  const showCluster = clusters.length > 1
  const {
    data: auditData,
    isLoading,
    error,
  } = useAuditLogs(
    pagination.pageIndex + 1,
    pagination.pageSize,
    operatorId,
    searchQuery,
    operationFilter || undefined,
    showCluster ? clusterFilter || undefined : undefined,
    undefined,
    undefined,
    undefined,
    operations,
    timeRange
  )

  useEffect(() => {
    if (!showCluster && clusterFilter) {
      setClusterFilter('')
    }
  }, [clusterFilter, showCluster])

  const handleUserFilterChange = useCallback((value: string) => {
    setPagination((prev) => ({ ...prev, pageIndex: 0 }))
    if (value === 'all') {
      setOperatorId(undefined)
      return
    }
    const parsed = Number(value)
    setOperatorId(Number.isNaN(parsed) ? undefined : parsed)
  }, [])

  const handleSearchChange = useCallback((value: string) => {
    setPagination((prev) => ({ ...prev, pageIndex: 0 }))
    setSearchQuery(value)
  }, [])

  const handleOperationChange = useCallback((value: string) => {
    setPagination((prev) => ({ ...prev, pageIndex: 0 }))
    setOperationFilter(value === 'all' ? '' : value)
  }, [])

  const handleClusterChange = useCallback((value: string) => {
    setPagination((prev) => ({ ...prev, pageIndex: 0 }))
    setClusterFilter(value === 'all' ? '' : value)
  }, [])

  const handleTimeRangeChange = useCallback((value: AuditTimeRange) => {
    setPagination((prev) => ({ ...prev, pageIndex: 0 }))
    setTimeRange(value)
  }, [])

  const handleExport = useCallback(
    () =>
      exportAuditLogs(
        operatorId,
        searchQuery,
        operationFilter || undefined,
        showCluster ? clusterFilter || undefined : undefined,
        undefined,
        undefined,
        undefined,
        operations,
        timeRange
      ),
    [
      clusterFilter,
      operationFilter,
      operatorId,
      operations,
      searchQuery,
      showCluster,
      timeRange,
    ]
  )

  // 操作类型的配色统一走 @/lib/status-badge：只有新增（info）与删除（failure）带语义色。

  const getOperationTypeLabel = useCallback(
    (operationType: string) => {
      switch (operationType.toLowerCase()) {
        case 'create':
          return t('common.actions.create')
        case 'update':
          return t('common.actions.update')
        case 'delete':
          return t('common.actions.delete')
        case 'apply':
          return t('common.actions.apply')
        case 'read':
          return t('audit.operations.read', '查询')
        case 'view-file':
          return t('audit.operations.viewFile', '查看文件')
        case 'download-file':
          return t('audit.operations.downloadFile', '下载文件')
        case 'upload-file':
          return t('audit.operations.uploadFile', '上传文件')
        default:
          return operationType
      }
    },
    [t]
  )

  const columns = useMemo<ColumnDef<ResourceHistory>[]>(
    () => [
      {
        id: 'time',
        header: t('common.fields.time', 'Time'),
        size: 150,
        cell: ({ row }) => (
          <span className="text-muted-foreground text-sm">
            {formatDate(row.original.createdAt)}
          </span>
        ),
      },
      {
        id: 'operator',
        header: t('common.fields.operator', 'Operator'),
        size: 175,
        cell: ({ row }) => {
          // 来源 IP 跟操作者放在同一列的第二行：审计时最常一起看，又不增加列宽。
          const clientIp = row.original.clientIp
          const operatorName =
            row.original.operator?.username || row.original.operatorName || '-'
          return (
            <div className="text-sm">
              <div className="truncate font-medium" title={operatorName}>
                {operatorName}
                {row.original.operator?.provider === 'api_key' && (
                  <span className="ml-2 text-xs text-muted-foreground italic">
                    apikey
                  </span>
                )}
                {row.original.operationSource === 'ai' && (
                  <span className="ml-2 text-xs text-muted-foreground italic">
                    AI
                  </span>
                )}
              </div>
              {clientIp && (
                <div
                  className="truncate font-mono text-xs text-muted-foreground"
                  title={row.original.userAgent || clientIp}
                >
                  {clientIp}
                </div>
              )}
            </div>
          )
        },
      },
      {
        id: 'operationType',
        header: t('common.fields.operation', 'Operation'),
        size: 130,
        cell: ({ row }) => {
          const badge = operationTypeBadge(row.original.operationType)
          return (
            <Badge variant={badge.variant} className={badge.className}>
              {getOperationTypeLabel(row.original.operationType)}
            </Badge>
          )
        },
      },
      {
        id: 'resource',
        header: t('common.fields.resource', 'Resource'),
        size: 300,
        cell: ({ row }) => {
          const resource = row.original
          const name = resource.namespace
            ? `${resource.namespace}/${resource.resourceName}`
            : resource.resourceName
          const target = fileOperationTarget(resource.resourceYaml)
          const detail = target
            ? `${resource.resourceType || '-'} · ${target}`
            : resource.resourceType || '-'
          return (
            <div className="text-sm">
              <div className="truncate font-medium" title={name || undefined}>
                {name || '-'}
              </div>
              <div
                className="truncate text-muted-foreground text-xs"
                title={detail}
              >
                {detail}
              </div>
            </div>
          )
        },
      },
      ...(showCluster
        ? [
            {
              id: 'cluster',
              header: t('common.fields.cluster', 'Cluster'),
              size: 130,
              cell: ({ row }: { row: { original: ResourceHistory } }) => {
                // 历史记录里的集群名是 URL 编码串（写审计时漏解码，已修）：展示端解码。
                // truncate 兜住超长名称，避免把相邻列挤变形。
                const cluster = decodeClusterName(row.original.clusterName)
                return (
                  <span
                    className="block truncate text-sm text-muted-foreground"
                    title={cluster || undefined}
                  >
                    {cluster || '-'}
                  </span>
                )
              },
            },
          ]
        : []),
      {
        id: 'status',
        header: t('common.fields.status', 'Status'),
        size: 100,
        cell: ({ row }) => (
          <span
            className={`text-sm font-medium ${outcomeText(row.original.success)}`}
          >
            {row.original.success
              ? t('status.success', 'Success')
              : t('status.failed', 'Failed')}
          </span>
        ),
      },
      {
        id: 'actions',
        header: t('common.fields.actions', 'Actions'),
        size: 120,
        cell: ({ row }) => {
          const item = row.original
          if (!item.success) {
            return (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSelectedHistory(item)
                  setIsErrorDialogOpen(true)
                }}
                disabled={!item.errorMessage}
              >
                <IconAlertCircle className="w-4 h-4 mr-1" />
                {t('common.actions.viewError', 'View Error')}
              </Button>
            )
          }
          if (!item.resourceYaml && !item.previousYaml) {
            return <span className="text-muted-foreground text-sm">-</span>
          }
          // 文件操作没有 YAML 可比对，目标容器与路径已在「资源」列展示。
          if (isFileOperation(item.operationType)) {
            return <span className="text-muted-foreground text-sm">-</span>
          }
          return (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSelectedHistory(item)
                setIsDiffOpen(true)
              }}
            >
              <IconEye className="w-4 h-4 mr-1" />
              {t('common.actions.viewDiff', 'View Diff')}
            </Button>
          )
        },
      },
    ],
    [getOperationTypeLabel, showCluster, t]
  )

  const table = useReactTable({
    data: auditData?.data ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
    state: { pagination, columnVisibility, columnSizing },
    onPaginationChange: setPagination,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnSizingChange: setColumnSizing,
    // 列宽拖拽：拖动表头右缘实时调宽（min/max 来自 defaultColumn）。
    enableColumnResizing: true,
    columnResizeMode: 'onChange',
    defaultColumn: { size: 160, minSize: 80, maxSize: 600 },
    manualPagination: true,
    pageCount: Math.ceil((auditData?.total ?? 0) / pagination.pageSize) || 0,
  })

  const emptyState = (() => {
    if (isLoading) {
      return (
        <div className="py-10 text-center text-muted-foreground">
          {t('common.messages.loadingResource', {
            resource: t('common.fields.auditLogs', 'audit logs'),
            defaultValue: 'Loading audit logs...',
          })}
        </div>
      )
    }
    if (error) {
      return (
        <div className="py-10 text-center text-destructive">
          {t('common.messages.failedToLoad', {
            resource: t('common.fields.auditLogs', 'audit logs'),
            defaultValue: 'Failed to load audit logs',
          })}
        </div>
      )
    }
    if ((auditData?.data.length ?? 0) === 0) {
      return (
        <div className="py-10 text-center text-muted-foreground">
          {t('common.messages.noItemsFound', {
            resource: t('common.fields.auditLogs', 'audit logs'),
            defaultValue: 'No audit logs found',
          })}
        </div>
      )
    }
    return null
  })()

  const totalRowCount = auditData?.total ?? 0
  const filteredRowCount = auditData?.data.length ?? 0

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* 标题让位给右侧筛选栏：窗口不够宽时先压标题，不去挤筛选栏换行。 */}
          <div className="min-w-0">
            <CardTitle className="truncate">
              {scoped
                ? t('audit.fileOperations.title', '文件操作日志')
                : t('common.fields.auditLogs', 'Audit Logs')}
            </CardTitle>
            <p className="text-muted-foreground text-sm">
              {scoped
                ? t(
                    'audit.fileOperations.description',
                    '记录 Pod 文件页的查看、下载与上传操作，包含容器与文件路径。'
                  )
                : t(
                    'common.messages.auditLogsDescription',
                    'Track who changed resources and review YAML diffs'
                  )}
            </p>
            {/* sink 非 database 时，这份列表由归档检索回答：必须提示"数据不实时"，
                否则用户会以为刚做的操作丢了。 */}
            {auditData?.backend && (
              <p className="text-muted-foreground mt-1 text-xs">
                {t(
                  'common.messages.archiveSourceNotice',
                  '数据来自归档（{{backend}}），不含最近约 {{seconds}} 秒内的操作',
                  {
                    backend: auditData.backend,
                    seconds: auditData.queryDelaySeconds ?? 120,
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
                'common.placeholders.searchResourceName',
                'Search resource name...'
              )}
              value={searchQuery}
              onChange={(event) => handleSearchChange(event.target.value)}
              className="w-52"
            />
            {!scoped && (
              <Select
                value={operationFilter || 'all'}
                onValueChange={handleOperationChange}
              >
                <SelectTrigger className="w-36">
                  <SelectValue
                    placeholder={t(
                      'common.values.allOperations',
                      'All operations'
                    )}
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    {t('common.values.allOperations', 'All operations')}
                  </SelectItem>
                  <SelectItem value="create">
                    {t('common.actions.create')}
                  </SelectItem>
                  <SelectItem value="update">
                    {t('common.actions.update')}
                  </SelectItem>
                  <SelectItem value="delete">
                    {t('common.actions.delete')}
                  </SelectItem>
                  <SelectItem value="apply">
                    {t('common.actions.apply')}
                  </SelectItem>
                  <SelectItem value="patch">
                    {t('common.actions.patch')}
                  </SelectItem>
                  <SelectGroup>
                    <SelectLabel>
                      {t('audit.groups.fileOperations', '文件操作')}
                    </SelectLabel>
                    <SelectItem value="view-file">
                      {t('audit.operations.viewFile', '查看文件')}
                    </SelectItem>
                    <SelectItem value="download-file">
                      {t('audit.operations.downloadFile', '下载文件')}
                    </SelectItem>
                    <SelectItem value="upload-file">
                      {t('audit.operations.uploadFile', '上传文件')}
                    </SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            )}
            {showCluster && (
              <Select
                value={clusterFilter || 'all'}
                onValueChange={handleClusterChange}
              >
                <SelectTrigger className="w-40">
                  <SelectValue
                    placeholder={t('common.values.allClusters', 'All clusters')}
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    {t('common.values.allClusters', 'All clusters')}
                  </SelectItem>
                  {clusters.map((cluster) => (
                    <SelectItem key={cluster.name} value={cluster.name}>
                      {cluster.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Select
              value={operatorId ? String(operatorId) : 'all'}
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
          data={auditData?.data}
          allPageSize={totalRowCount}
          emptyState={emptyState}
          // 列宽按列定义固定，时间列不再被压成 0 宽，长内容靠截断显示，
          // 避免某一条超长的资源名 / 文件路径把整张表撑宽。
          columnSizing
          shrinkFirstColumn={false}
          hasActiveFilters={
            Boolean(operatorId) ||
            Boolean(searchQuery) ||
            Boolean(operationFilter) ||
            (showCluster && Boolean(clusterFilter)) ||
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

      {selectedHistory && (
        <YamlDiffViewer
          open={isDiffOpen}
          onOpenChange={(open) => {
            setIsDiffOpen(open)
            if (!open) {
              setSelectedHistory(null)
            }
          }}
          original={selectedHistory.previousYaml || ''}
          modified={selectedHistory.resourceYaml || ''}
          title={t('common.fields.yamlDiff', 'YAML Diff')}
          height={560}
        />
      )}

      <Dialog
        open={isErrorDialogOpen}
        onOpenChange={(open) => {
          setIsErrorDialogOpen(open)
          if (!open) {
            setSelectedHistory(null)
          }
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {t('common.fields.errorDetails', 'Error Details')}
            </DialogTitle>
          </DialogHeader>
          <div className="text-sm text-muted-foreground whitespace-pre-wrap">
            {selectedHistory?.errorMessage ||
              t('common.messages.noErrorMessage', 'No error message')}
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

/**
 * 日志审计容器：/settings/audit?tab=login | ?tab=operation | ?tab=file | ?tab=password | ?tab=setting
 * 子导航在左侧侧边栏的「日志审计」下，内容区只渲染当前页签。
 */
export function AuditLog() {
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab')
  const tab =
    tabParam === 'operation' ||
    tabParam === 'file' ||
    tabParam === 'password' ||
    tabParam === 'archive' ||
    tabParam === 'setting'
      ? tabParam
      : 'login'

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => setSearchParams({ tab: value })}
    >
      <TabsContent value="login">
        <LoginLog />
      </TabsContent>
      <TabsContent value="operation">
        <OperationLog />
      </TabsContent>
      <TabsContent value="file">
        <OperationLog operations={FILE_OPERATIONS} />
      </TabsContent>
      <TabsContent value="password">
        <PasswordChangeLog />
      </TabsContent>
      <TabsContent value="archive">
        <ArchiveQuery />
      </TabsContent>
      <TabsContent value="setting">
        <AuditSetting />
      </TabsContent>
    </Tabs>
  )
}
