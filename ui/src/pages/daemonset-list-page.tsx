import { useMemo, useState } from 'react'
import {
  IconCircleCheckFilled,
  IconLoader,
  IconReload,
} from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { createColumnHelper } from '@tanstack/react-table'
import { DaemonSet } from 'kubernetes-types/apps/v1'
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

const daemonSetSearchFilter = createSearchFilter<DaemonSet>(
  (d) => d.metadata?.name,
  (d) => d.metadata?.namespace
)

const columnHelper = createColumnHelper<DaemonSet>()

export function DaemonSetListPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { namespace: namespaceParam } = useParams()

  // 定义 DaemonSet 表格的列
  const columns = useMemo(
    () => [
      columnHelper.accessor('metadata.name', {
        header: t('common.fields.name'),
        cell: ({ row }) => (
          <div className="font-medium app-link">
            <Link
              to={`/daemonsets/${row.original.metadata!.namespace}/${
                row.original.metadata!.name
              }`}
            >
              {row.original.metadata!.name}
            </Link>
          </div>
        ),
      }),
      columnHelper.accessor('status.desiredNumberScheduled', {
        header: t('common.fields.desired'),
        cell: ({ getValue }) => getValue() || 0,
      }),
      columnHelper.accessor('status.currentNumberScheduled', {
        header: t('common.fields.current'),
        cell: ({ getValue }) => getValue() || 0,
      }),
      columnHelper.accessor('status.numberReady', {
        header: t('common.fields.ready'),
        cell: ({ getValue }) => getValue() || 0,
      }),
      columnHelper.accessor((row) => row.status?.numberAvailable || 0, {
        id: 'status_numberAvailable',
        header: t('common.fields.available'),
        cell: ({ getValue }) => getValue() || 0,
      }),
      columnHelper.accessor(
        (row) => {
          const readyReplicas = row.status?.numberReady || 0
          const replicas = row.status?.desiredNumberScheduled || 0
          if (replicas === 0) return 'Pending'
          return readyReplicas === replicas
            ? t('common.fields.available')
            : t('common.messages.loading')
        },
        {
          id: 'status_conditions',
          header: t('common.fields.status'),
          cell: ({ row, getValue }) => {
            const readyReplicas = row.original.status?.numberReady || 0
            const replicas = row.original.status?.desiredNumberScheduled || 0
            const isAvailable = readyReplicas === replicas
            const status = getValue()
            if (replicas === 0) {
              return (
                <Badge
                  variant="secondary"
                  className="text-muted-foreground px-1.5"
                >
                  Pending
                </Badge>
              )
            }

            return (
              <Badge variant="outline" className="text-muted-foreground px-1.5">
                {isAvailable ? (
                  <IconCircleCheckFilled className="fill-green-500 dark:fill-green-400" />
                ) : (
                  <IconLoader className="animate-spin" />
                )}
                {status}
              </Badge>
            )
          },
        }
      ),
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
              resourceType="daemonsets"
              resource={row.original}
            />
          </div>
        ),
      }),
    ],
    [t]
  )

  const [batchDaemonSets, setBatchDaemonSets] = useState<DaemonSet[]>([])
  const [isRestartDialogOpen, setIsRestartDialogOpen] = useState(false)

  // 重启会 patch pod 模板，因此需要 update 权限。
  const canUpdate = useCanAnyNamespace()('daemonsets', 'update')
  const batchActions = useMemo<ResourceTableBatchAction<DaemonSet>[]>(
    () => [
      {
        id: 'restart',
        label: t('common.actions.restart'),
        icon: <IconReload className="size-4" />,
        hidden: !canUpdate,
        onSelect: (daemonSets) => {
          setBatchDaemonSets(daemonSets)
          setIsRestartDialogOpen(true)
        },
      },
    ],
    [t, canUpdate]
  )

  const handleCreateClick = () => {
    // URL 优先，其次是表格持久化的选择；多选或
    // "所有命名空间"的选择无法承载新对象。
    const ns = resolveCreateNamespace(
      namespaceParam,
      sessionStorage.getItem(getClusterScopedStorageKey('selectedNamespace')),
      localStorage.getItem(getClusterScopedStorageKey('selectedNamespace'))
    )
    navigate(`/daemonsets/${encodeURIComponent(ns)}/create?tab=container-0`)
  }

  return (
    <>
      <ResourceTable
        resourceName={'DaemonSets'}
        resourceType="daemonsets"
        columns={columns}
        searchQueryFilter={daemonSetSearchFilter}
        initialNamespace={namespaceParam}
        onNamespaceChange={(ns) => {
          navigate(
            ns && ns !== '_all'
              ? `/daemonsets/${encodeURIComponent(ns)}`
              : '/daemonsets',
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
        resources={batchDaemonSets}
        title={t('resourceTable.batchActions.restartResourcesTitle', {
          count: batchDaemonSets.length,
          resource: t('nav.daemonsets'),
        })}
        description={t(
          'resourceTable.batchActions.restartResourcesDescription',
          {
            resource: t('nav.daemonsets'),
          }
        )}
        actionLabel={t('common.actions.restart')}
        onExecute={(daemonSet) =>
          restartWorkload(
            'daemonsets',
            daemonSet.metadata!.name!,
            daemonSet.metadata!.namespace!
          )
        }
        onComplete={() =>
          queryClient.invalidateQueries({ queryKey: ['daemonsets'] })
        }
        destructive={true}
      />
    </>
  )
}
