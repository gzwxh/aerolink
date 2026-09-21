import { useMemo, useState } from 'react'
import {
  IconCircleCheckFilled,
  IconLoader,
  IconReload,
} from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { createColumnHelper } from '@tanstack/react-table'
import { StatefulSet } from 'kubernetes-types/apps/v1'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { restartWorkload } from '@/lib/api'
import { getClusterScopedStorageKey } from '@/lib/current-cluster'
import { createSearchFilter, resolveCreateNamespace } from '@/lib/k8s'
import { formatDate } from '@/lib/utils'
import { useCanAnyNamespace } from '@/hooks/use-can'
import { Badge } from '@/components/ui/badge'
import { ResourceBatchActionDialog } from '@/components/resource-batch-action-dialog'
import { ResourceRowActions } from '@/components/resource-row-actions'
import {
  ResourceTable,
  type ResourceTableBatchAction,
} from '@/components/resource-table'

const statefulSetSearchFilter = createSearchFilter<StatefulSet>(
  (s) => s.metadata?.name,
  (s) => s.metadata?.namespace,
  (s) => s.spec?.serviceName
)

const columnHelper = createColumnHelper<StatefulSet>()

export function StatefulSetListPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { namespace: namespaceParam } = useParams()
  const [isRestartDialogOpen, setIsRestartDialogOpen] = useState(false)
  const [batchStatefulSets, setBatchStatefulSets] = useState<StatefulSet[]>([])

  // 重启会 patch pod 模板，因此需要 update 权限。
  const canUpdate = useCanAnyNamespace()('statefulsets', 'update')
  const batchActions = useMemo<ResourceTableBatchAction<StatefulSet>[]>(
    () => [
      {
        id: 'restart',
        label: t('common.actions.restart'),
        icon: <IconReload className="size-4" />,
        hidden: !canUpdate,
        onSelect: (statefulSets) => {
          setBatchStatefulSets(statefulSets)
          setIsRestartDialogOpen(true)
        },
      },
    ],
    [t, canUpdate]
  )

  // 定义 StatefulSet 表格的列
  const columns = useMemo(
    () => [
      columnHelper.accessor('metadata.name', {
        header: t('common.fields.name'),
        cell: ({ row }) => (
          <div className="font-medium app-link">
            <Link
              to={`/statefulsets/${row.original.metadata!.namespace}/${
                row.original.metadata!.name
              }`}
            >
              {row.original.metadata!.name}
            </Link>
          </div>
        ),
      }),
      columnHelper.accessor((row) => row.status?.readyReplicas ?? 0, {
        id: 'ready',
        header: t('common.fields.ready'),
        cell: ({ row }) => {
          const status = row.original.status
          const ready = status?.readyReplicas || 0
          const desired = status?.replicas || 0

          return (
            <div>
              {ready} / {desired}
            </div>
          )
        },
      }),
      columnHelper.accessor(
        (row) => {
          const readyReplicas = row.status?.readyReplicas || 0
          const replicas = row.status?.replicas || 0
          if (replicas === 0) return '-'
          return readyReplicas === replicas
            ? t('common.fields.available')
            : t('common.messages.loading')
        },
        {
          id: 'status_conditions',
          header: t('common.fields.status'),
          cell: ({ row, getValue }) => {
            const readyReplicas = row.original.status?.readyReplicas || 0
            const replicas = row.original.status?.replicas || 0
            const isAvailable = readyReplicas === replicas
            const status = getValue()
            if (replicas === 0) {
              return (
                <Badge
                  variant="secondary"
                  className="text-muted-foreground px-1.5"
                >
                  -
                </Badge>
              )
            }

            return (
              <Badge variant="outline" className="text-muted-foreground px-1.5">
                {isAvailable ? (
                  <IconCircleCheckFilled className="fill-success" />
                ) : (
                  <IconLoader className="animate-spin" />
                )}
                {status}
              </Badge>
            )
          },
        }
      ),
      columnHelper.accessor('spec.serviceName', {
        header: t('common.fields.serviceName'),
        cell: ({ getValue }) => getValue() || '-',
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
            <ResourceRowActions
              resourceType="statefulsets"
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
    navigate(`/statefulsets/${encodeURIComponent(ns)}/create?tab=container-0`)
  }

  return (
    <>
      <ResourceTable
        resourceName={'StatefulSets'}
        resourceType="statefulsets"
        columns={columns}
        searchQueryFilter={statefulSetSearchFilter}
        initialNamespace={namespaceParam}
        onNamespaceChange={(ns) => {
          navigate(
            ns && ns !== '_all'
              ? `/statefulsets/${encodeURIComponent(ns)}`
              : '/statefulsets',
            { replace: true }
          )
        }}
        showCreateButton={true}
        onCreateClick={handleCreateClick}
        batchActions={batchActions}
      />

      <ResourceBatchActionDialog
        open={isRestartDialogOpen}
        onOpenChange={setIsRestartDialogOpen}
        resources={batchStatefulSets}
        title={t('resourceTable.batchActions.restartResourcesTitle', {
          count: batchStatefulSets.length,
          resource: t('nav.statefulsets'),
        })}
        description={t(
          'resourceTable.batchActions.restartResourcesDescription',
          { resource: t('nav.statefulsets') }
        )}
        actionLabel={t('common.actions.restart')}
        onExecute={(statefulSet) =>
          restartWorkload(
            'statefulsets',
            statefulSet.metadata!.name!,
            statefulSet.metadata!.namespace!
          )
        }
        onComplete={() =>
          queryClient.invalidateQueries({ queryKey: ['statefulsets'] })
        }
        destructive={true}
      />
    </>
  )
}
