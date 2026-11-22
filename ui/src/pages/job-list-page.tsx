import { useMemo } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { Job } from 'kubernetes-types/batch/v1'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router-dom'

import { useClusterNavigate } from '@/lib/cluster-path'
import { getClusterScopedStorageKey } from '@/lib/current-cluster'
import { createSearchFilter, resolveCreateNamespace } from '@/lib/k8s'
import { neutralBadge, statusBadge } from '@/lib/status-badge'
import { formatDate } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { ClusterLink } from '@/components/cluster-link'
import { ResourceRowActions } from '@/components/resource-row-actions'
import { ResourceTable } from '@/components/resource-table'

const jobSearchFilter = createSearchFilter<Job>(
  (j) => j.metadata?.name,
  (j) => j.metadata?.namespace
)

const columnHelper = createColumnHelper<Job>()

export function JobListPage() {
  const { t } = useTranslation()
  const navigate = useClusterNavigate()
  const { namespace: namespaceParam } = useParams()

  // 定义 Job 表格的列
  const columns = useMemo(
    () => [
      columnHelper.accessor('metadata.name', {
        header: t('common.fields.name'),
        cell: ({ row }) => (
          <div className="font-medium app-link">
            <ClusterLink
              to={`/jobs/${row.original.metadata!.namespace}/${
                row.original.metadata!.name
              }`}
            >
              {row.original.metadata!.name}
            </ClusterLink>
          </div>
        ),
      }),
      columnHelper.accessor(
        (row) => {
          const conditions = row.status?.conditions || []
          if (
            conditions.some(
              (condition) =>
                condition.type === 'Complete' && condition.status === 'True'
            )
          ) {
            return 'Complete'
          }
          if (
            conditions.some(
              (condition) =>
                condition.type === 'Failed' && condition.status === 'True'
            )
          ) {
            return 'Failed'
          }
          return 'Running'
        },
        {
          id: 'status_conditions',
          header: t('common.fields.status'),
          cell: ({ getValue }) => {
            const status = getValue()
            const badge =
              status === 'Complete'
                ? statusBadge('success')
                : status === 'Failed'
                  ? statusBadge('failure')
                  : neutralBadge()

            return (
              <Badge variant={badge.variant} className={badge.className}>
                {/* 取值过 `status.*`（详情页概览已经是「完成/失败」），
                    列表再直接贴 `Complete`/`Failed` 就是同一对象两种说法（第 17 轮 D-137）。 */}
                {status === 'Complete'
                  ? t('status.complete')
                  : status === 'Failed'
                    ? t('status.failed')
                    : t('status.running')}
              </Badge>
            )
          },
        }
      ),
      columnHelper.accessor((row) => row.status?.succeeded || 0, {
        id: 'completions',
        header: t('jobList.completions', 'Completions'),
        cell: ({ row }) => {
          const status = row.original.status
          const succeeded = status?.succeeded || 0
          const completions = row.original.spec?.completions || 1
          return `${succeeded}/${completions}`
        },
      }),
      columnHelper.accessor('status.startTime', {
        header: t('jobList.started', 'Started'),
        cell: ({ getValue }) => {
          const startTime = getValue()
          if (!startTime) return '-'

          const dateStr = formatDate(startTime)

          return (
            <span className="text-muted-foreground text-sm">{dateStr}</span>
          )
        },
      }),
      columnHelper.accessor('status.completionTime', {
        header: t('jobList.completed', 'Completed'),
        cell: ({ getValue }) => {
          const completionTime = getValue()
          if (!completionTime) return '-'

          const dateStr = formatDate(completionTime)

          return (
            <span className="text-muted-foreground text-sm">{dateStr}</span>
          )
        },
      }),
      columnHelper.accessor('metadata.creationTimestamp', {
        header: t('common.fields.created'),
        cell: ({ getValue }) => {
          const dateStr = formatDate(getValue() || '')

          return (
            <span className="text-muted-foreground text-sm">{dateStr}</span>
          )
        },
      }),
      columnHelper.display({
        id: 'actions',
        header: () => (
          <div className="text-right">{t('common.fields.actions')}</div>
        ),
        cell: ({ row }) => (
          <div className="flex justify-end">
            <ResourceRowActions resourceType="jobs" resource={row.original} />
          </div>
        ),
      }),
    ],
    [t]
  )

  const handleCreateClick = () => {
    // URL 优先，其次是表格持久化的选择；多选或
    // "所有命名空间"的选择无法承载新对象。
    const ns = resolveCreateNamespace(
      namespaceParam,
      sessionStorage.getItem(getClusterScopedStorageKey('selectedNamespace')),
      localStorage.getItem(getClusterScopedStorageKey('selectedNamespace'))
    )
    navigate(`/jobs/${encodeURIComponent(ns)}/create?tab=container-0`)
  }

  return (
    <>
      <ResourceTable
        resourceName="Jobs"
        columns={columns}
        searchQueryFilter={jobSearchFilter}
        initialNamespace={namespaceParam}
        onNamespaceChange={(ns) => {
          navigate(
            ns && ns !== '_all' ? `/jobs/${encodeURIComponent(ns)}` : '/jobs',
            { replace: true }
          )
        }}
        showCreateButton={true}
        onCreateClick={handleCreateClick}
      />
    </>
  )
}
