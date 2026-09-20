import { useMemo } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { Job } from 'kubernetes-types/batch/v1'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { getClusterScopedStorageKey } from '@/lib/current-cluster'
import { createSearchFilter, resolveCreateNamespace } from '@/lib/k8s'
import { formatDate } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { ResourceTable } from '@/components/resource-table'

const jobSearchFilter = createSearchFilter<Job>(
  (j) => j.metadata?.name,
  (j) => j.metadata?.namespace
)

const columnHelper = createColumnHelper<Job>()

export function JobListPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { namespace: namespaceParam } = useParams()

  // 定义 Job 表格的列
  const columns = useMemo(
    () => [
      columnHelper.accessor('metadata.name', {
        header: t('common.fields.name'),
        cell: ({ row }) => (
          <div className="font-medium app-link">
            <Link
              to={`/jobs/${row.original.metadata!.namespace}/${
                row.original.metadata!.name
              }`}
            >
              {row.original.metadata!.name}
            </Link>
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
            const variant =
              status === 'Complete'
                ? 'default'
                : status === 'Failed'
                  ? 'destructive'
                  : 'secondary'

            return <Badge variant={variant}>{status}</Badge>
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
