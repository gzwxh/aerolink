import { useCallback, useMemo, useState } from 'react'
import { IconAlertCircle, IconEye, IconLoader } from '@tabler/icons-react'
import * as yaml from 'js-yaml'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ResourceHistory, ResourceType, ResourceTypeMap } from '@/types/api'
import { applyResource, useResourceHistory } from '@/lib/api'
import { operationTypeBadge, outcomeText } from '@/lib/status-badge'
import { formatDate, translateError } from '@/lib/utils'
import { useCan } from '@/hooks/use-can'

import { Column, SimpleTable } from './simple-table'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog'
import { YamlDiffViewer } from './yaml-diff-viewer'

interface ResourceHistoryTableProps<T extends ResourceType> {
  resourceType: T
  name: string
  namespace?: string
  currentResource?: ResourceTypeMap[T]
}

export function ResourceHistoryTable<T extends ResourceType>({
  resourceType,
  name,
  namespace,
  currentResource,
}: ResourceHistoryTableProps<T>) {
  const { t } = useTranslation()
  const can = useCan()
  // 回滚本质是一次 apply，属于写操作：只读角色只能查看差异。
  const canRollback = can(resourceType, 'update', { namespace })
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize] = useState(10)
  const [selectedHistory, setSelectedHistory] =
    useState<ResourceHistory | null>(null)
  const [isDiffOpen, setIsDiffOpen] = useState(false)
  const [isErrorDialogOpen, setIsErrorDialogOpen] = useState(false)
  const [isRollingBack, setIsRollingBack] = useState(false)

  const {
    data: historyResponse,
    refetch: refetchHistory,
    isLoading,
    isError,
    error,
  } = useResourceHistory(
    resourceType,
    namespace ?? '_all',
    name,
    currentPage,
    pageSize
  )

  const history = historyResponse?.data || []
  // const pagination = historyResponse?.pagination

  // 把当前资源转换为 YAML
  const currentYaml = useMemo(() => {
    if (!currentResource) return ''
    try {
      return yaml.dump(currentResource, { indent: 2, sortKeys: true })
    } catch (error) {
      console.error('Failed to convert current resource to YAML:', error)
      return ''
    }
  }, [currentResource])

  const handleViewDiff = (item: ResourceHistory) => {
    setSelectedHistory(item)
    setIsDiffOpen(true)
  }

  const handleViewError = (item: ResourceHistory) => {
    setSelectedHistory(item)
    setIsErrorDialogOpen(true)
  }

  // 处理回滚操作
  const handleRollback = async (yamlContent: string) => {
    try {
      setIsRollingBack(true)
      await applyResource(yamlContent)

      // 展示成功 toast
      toast.success(t('resourceHistory.rollback.success'))

      // 回滚成功后关闭对话框
      setIsDiffOpen(false)
      refetchHistory()
      // 刷新历史数据
      // 如果存在 refetch 函数，可以在这里调用
    } catch (error) {
      console.error('Failed to rollback resource:', error)
      toast.error(translateError(error, t))
    } finally {
      setIsRollingBack(false)
    }
  }

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
        default:
          return operationType
      }
    },
    [t]
  )

  // 历史表格列
  const historyColumns = useMemo(
    (): Column<ResourceHistory>[] => [
      {
        header: 'ID',
        accessor: (item: ResourceHistory) => item.id,
        cell: (value: unknown) => (
          <div className="font-mono text-sm">{value as number}</div>
        ),
      },
      {
        header: t('common.fields.operator'),
        accessor: (item: ResourceHistory) => item,
        cell: (value: unknown) => {
          const item = value as ResourceHistory
          return (
            <div className="font-medium">
              {item.operator.username}
              {item.operator.provider === 'api_key' && (
                <span className="ml-2 text-xs text-muted-foreground italic">
                  apikey
                </span>
              )}
              {item.operationSource === 'ai' && (
                <span className="ml-2 text-xs text-muted-foreground italic">
                  AI
                </span>
              )}
            </div>
          )
        },
      },
      {
        header: t('common.fields.time'),
        accessor: (item: ResourceHistory) => item.createdAt,
        cell: (value: unknown) => (
          <span className="text-muted-foreground text-sm">
            {formatDate(value as string)}
          </span>
        ),
      },
      {
        header: t('common.fields.type'),
        accessor: (item: ResourceHistory) => item.operationType,
        cell: (value: unknown) => {
          const operationType = value as string
          const badge = operationTypeBadge(operationType)
          return (
            <Badge variant={badge.variant} className={badge.className}>
              {getOperationTypeLabel(operationType)}
            </Badge>
          )
        },
      },
      {
        header: t('common.fields.status'),
        accessor: (item: ResourceHistory) => item.success,
        cell: (value: unknown) => {
          const success = value as boolean
          return (
            <span className={`text-sm font-medium ${outcomeText(success)}`}>
              {success ? t('status.success') : t('status.failed')}
            </span>
          )
        },
      },
      {
        header: t('common.fields.actions'),
        accessor: (item: ResourceHistory) => item,
        cell: (value: unknown) => {
          const item = value as ResourceHistory
          const isSuccess = item.success

          if (!isSuccess) {
            return (
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleViewError(item)}
                disabled={!item.errorMessage}
              >
                <IconAlertCircle className="w-4 h-4 mr-1" />
                {t('common.actions.viewError', 'view error')}
              </Button>
            )
          }

          return (
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleViewDiff(item)}
              disabled={!item.resourceYaml && !item.previousYaml}
            >
              <IconEye className="w-4 h-4 mr-1" />
              {t('resourceHistory.viewDiff')}
            </Button>
          )
        },
      },
    ],
    [getOperationTypeLabel, t]
  )

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <IconLoader className="animate-spin mr-2" />
        {t('resourceHistory.loadingHistory')}
      </div>
    )
  }

  if (isError) {
    // sink≠database 时后端明确回 501 + code（审计记录没落库，YAML 对比做不了）：这里给一句
    // 说明，而不是拿「加载失败」的口气让管理员以为服务出了故障。
    const requiresDatabaseSink =
      (error as { code?: string } | null | undefined)?.code ===
      'resource_history_requires_database_sink'
    return (
      <Card>
        <CardContent className="pt-6">
          {requiresDatabaseSink ? (
            <div className="text-center text-sm text-muted-foreground">
              {t(
                'resourceHistory.requiresDatabaseSink',
                '资源级变更历史需要审计记录落在数据库（auditSink=database，默认）。当前存储方式下本页不可用：parquet 默认不写资源 YAML，Elasticsearch 的文档也不含 YAML——两者都撑不起变更前后对比。'
              )}
            </div>
          ) : (
            <div className="text-center text-destructive">
              {t('resourceHistory.failedToLoadHistory')}: {error?.message}
            </div>
          )}
        </CardContent>
      </Card>
    )
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t('resourceHistory.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <SimpleTable
            data={history || []}
            columns={historyColumns}
            emptyMessage={t('resourceHistory.noHistoryFound')}
            pagination={{
              enabled: true,
              pageSize,
              showPageInfo: true,
              currentPage,
              onPageChange: setCurrentPage,
            }}
          />
        </CardContent>
      </Card>

      {selectedHistory && (
        <YamlDiffViewer
          original={selectedHistory.previousYaml || ''}
          modified={selectedHistory.resourceYaml || ''}
          current={currentYaml}
          open={isDiffOpen}
          onOpenChange={setIsDiffOpen}
          onRollback={canRollback ? handleRollback : undefined}
          isRollingBack={isRollingBack}
          title={`${t('resourceHistory.yamlDiff')}`}
        />
      )}

      {selectedHistory && (
        <Dialog open={isErrorDialogOpen} onOpenChange={setIsErrorDialogOpen}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>
                {t('common.fields.errorDetails', 'error details')}
              </DialogTitle>
            </DialogHeader>
            <div className="mt-4">
              <pre className="bg-destructive/10 text-destructive p-4 rounded-md overflow-auto max-h-96 text-sm">
                {selectedHistory.errorMessage ||
                  t(
                    'common.messages.noErrorMessage',
                    'no error message available'
                  )}
              </pre>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
