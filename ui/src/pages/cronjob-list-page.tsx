import { useMemo } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { CronJob } from 'kubernetes-types/batch/v1'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { getClusterScopedStorageKey } from '@/lib/current-cluster'
import { createSearchFilter, resolveCreateNamespace } from '@/lib/k8s'
import { neutralBadge, statusBadge } from '@/lib/status-badge'
import { formatDate } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { ResourceRowActions } from '@/components/resource-row-actions'
import { ResourceTable } from '@/components/resource-table'

function getSuspendBadge(cronjob: CronJob) {
  const isSuspended = cronjob.spec?.suspend ?? false
  return {
    label: isSuspended ? 'Suspended' : 'Active',
    // Active = 正在按计划运行（进行中），Suspended 是中性状态。
    ...(isSuspended ? neutralBadge() : statusBadge('info')),
  }
}

const cronJobSearchFilter = createSearchFilter<CronJob>(
  (cj) => cj.metadata?.name,
  (cj) => cj.metadata?.namespace
)

const columnHelper = createColumnHelper<CronJob>()

export function CronJobListPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { namespace: namespaceParam } = useParams()

  const columns = useMemo(
    () => [
      columnHelper.accessor('metadata.name', {
        header: t('common.fields.name'),
        cell: ({ row }) => (
          <div className="font-medium app-link">
            <Link
              to={`/cronjobs/${row.original.metadata!.namespace}/${
                row.original.metadata!.name
              }`}
            >
              {row.original.metadata!.name}
            </Link>
          </div>
        ),
      }),
      columnHelper.display({
        id: 'schedule',
        header: t('cronJobList.schedule', 'Schedule'),
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {row.original.spec?.schedule || '-'}
          </span>
        ),
      }),
      columnHelper.display({
        id: 'suspend',
        header: t('cronJobList.state', 'State'),
        cell: ({ row }) => {
          const badge = getSuspendBadge(row.original)
          return (
            <Badge variant={badge.variant} className={badge.className}>
              {badge.label}
            </Badge>
          )
        },
      }),
      columnHelper.display({
        id: 'active',
        header: t('cronJobList.activeJobs', 'Active Jobs'),
        cell: ({ row }) => (
          <span className="text-sm">
            {row.original.status?.active?.length || 0}
          </span>
        ),
      }),
      columnHelper.display({
        id: 'lastSchedule',
        header: t('cronJobList.lastSchedule', 'Last Schedule'),
        cell: ({ row }) => {
          const lastSchedule = row.original.status?.lastScheduleTime
          if (!lastSchedule) {
            return <span className="text-sm text-muted-foreground">-</span>
          }

          return (
            <span className="text-sm text-muted-foreground">
              {formatDate(lastSchedule)}
            </span>
          )
        },
      }),
      columnHelper.display({
        id: 'lastSuccess',
        header: t('cronJobList.lastSuccess', 'Last Success'),
        cell: ({ row }) => {
          const lastSuccess = row.original.status?.lastSuccessfulTime
          if (!lastSuccess) {
            return <span className="text-sm text-muted-foreground">-</span>
          }
          return (
            <span className="text-sm text-muted-foreground">
              {formatDate(lastSuccess)}
            </span>
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
            <ResourceRowActions
              resourceType="cronjobs"
              resource={row.original}
            />
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
    navigate(`/cronjobs/${encodeURIComponent(ns)}/create?tab=container-0`)
  }

  return (
    <>
      <ResourceTable
        resourceName="CronJobs"
        resourceType="cronjobs"
        columns={columns}
        searchQueryFilter={cronJobSearchFilter}
        initialNamespace={namespaceParam}
        onNamespaceChange={(ns) => {
          navigate(
            ns && ns !== '_all'
              ? `/cronjobs/${encodeURIComponent(ns)}`
              : '/cronjobs',
            { replace: true }
          )
        }}
        showCreateButton={true}
        onCreateClick={handleCreateClick}
      />
    </>
  )
}
