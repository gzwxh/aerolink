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
import { useParams } from 'react-router-dom'

import { restartWorkload, useResources } from '@/lib/api'
import { useClusterNavigate } from '@/lib/cluster-path'
import { getClusterScopedStorageKey } from '@/lib/current-cluster'
import {
  createSearchFilter,
  groupPodsByNamespace,
  resolveCreateNamespace,
  sumPodRestarts,
} from '@/lib/k8s'
import { formatAge, formatDate } from '@/lib/utils'
import { useCanAnyNamespace } from '@/hooks/use-can'
import { Badge } from '@/components/ui/badge'
import { ClusterLink } from '@/components/cluster-link'
import { ResourceBatchActionDialog } from '@/components/resource-batch-action-dialog'
import { ResourceRowActions } from '@/components/resource-row-actions'
import {
  ResourceTable,
  type ResourceTableBatchAction,
} from '@/components/resource-table'
import {
  EmptyValue,
  WorkloadHealthBar,
  WorkloadImageCell,
} from '@/components/workload-list-cells'

const daemonSetSearchFilter = createSearchFilter<DaemonSet>(
  (d) => d.metadata?.name,
  (d) => d.metadata?.namespace
)

const columnHelper = createColumnHelper<DaemonSet>()

// 参考版式里没有的列保留但默认隐藏，需要时从表头「列」菜单打开。
const HIDDEN_BY_DEFAULT_COLUMNS = [
  'namespace',
  'desired',
  'current',
  'created',
]

export function DaemonSetListPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const navigate = useClusterNavigate()
  const { namespace: namespaceParam } = useParams()

  // 重启次数要按 selector 在 Pod 上汇总（DaemonSet 自身没有这个字段）。
  // URL 带单个命名空间时只拉这个命名空间，其余情况（全部 / 多选）退化为全量。
  const { data: pods } = useResources('pods', namespaceParam, {
    staleTime: 30_000,
  })
  const podsByNamespace = useMemo(() => groupPodsByNamespace(pods), [pods])
  const podsLoaded = pods !== undefined

  // 定义 DaemonSet 表格的列
  const columns = useMemo(
    () => [
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
      columnHelper.accessor('metadata.name', {
        header: t('common.fields.name'),
        cell: ({ row }) => (
          // 状态列排在最前，名称列不再是表格认定的「首个数据列」，这里显式
          // 保持左对齐与长名字换行。
          <div className="max-w-[400px] text-left font-medium break-words app-link">
            <ClusterLink
              to={`/daemonsets/${row.original.metadata!.namespace}/${
                row.original.metadata!.name
              }`}
            >
              {row.original.metadata!.name}
            </ClusterLink>
          </div>
        ),
      }),
      // 分组依据（见下面的 grouping）：按命名空间成组展示，列本身默认隐藏。
      columnHelper.accessor((row) => row.metadata?.namespace ?? '', {
        id: 'namespace',
        header: t('common.fields.namespace'),
        cell: ({ getValue }) => (
          <Badge variant="outline" className="max-w-full truncate">
            {getValue()}
          </Badge>
        ),
      }),
      columnHelper.accessor(
        (row) => row.spec?.template.spec?.containers ?? [],
        {
          id: 'containers_images',
          enableSorting: false,
          header: t('common.fields.images'),
          cell: ({ row }) => (
            <WorkloadImageCell
              containers={row.original.spec?.template.spec?.containers ?? []}
            />
          ),
        }
      ),
      columnHelper.accessor('status.numberReady', {
        id: 'ready',
        header: t('common.fields.ready'),
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.status?.numberReady ?? 0} /{' '}
            {row.original.status?.desiredNumberScheduled ?? 0}
          </span>
        ),
      }),
      columnHelper.accessor('status.updatedNumberScheduled', {
        id: 'updated',
        header: t('common.fields.upToDate'),
        cell: ({ getValue }) => (
          <span className="tabular-nums">{getValue() || 0}</span>
        ),
      }),
      columnHelper.accessor((row) => row.status?.numberAvailable || 0, {
        id: 'status_numberAvailable',
        header: t('common.fields.available'),
        cell: ({ getValue }) => (
          <span className="tabular-nums">{getValue() || 0}</span>
        ),
      }),
      columnHelper.accessor(
        (row) =>
          sumPodRestarts(
            podsByNamespace,
            row.metadata?.namespace,
            row.spec?.selector?.matchLabels
          ),
        {
          id: 'restarts',
          header: t('common.fields.restarts'),
          cell: ({ getValue }) =>
            podsLoaded ? (
              <span className="tabular-nums">{getValue()}</span>
            ) : (
              <EmptyValue />
            ),
        }
      ),
      columnHelper.accessor('metadata.creationTimestamp', {
        id: 'uptime',
        header: t('common.fields.uptime'),
        cell: ({ getValue }) => (
          <span className="text-muted-foreground text-sm tabular-nums">
            {getValue() ? formatAge(getValue()!, t) : '-'}
          </span>
        ),
      }),
      // DaemonSet 的副本数由控制器按节点决定，条形只读。
      columnHelper.display({
        id: 'health',
        header: t('common.fields.health'),
        cell: ({ row }) => (
          <WorkloadHealthBar
            ready={row.original.status?.numberReady ?? 0}
            desired={row.original.status?.desiredNumberScheduled ?? 0}
            name={row.original.metadata!.name!}
            namespace={row.original.metadata!.namespace!}
            canUpdate={false}
          />
        ),
      }),
      columnHelper.accessor('status.desiredNumberScheduled', {
        id: 'desired',
        header: t('common.fields.desired'),
        cell: ({ getValue }) => getValue() || 0,
      }),
      columnHelper.accessor('status.currentNumberScheduled', {
        id: 'current',
        header: t('common.fields.current'),
        cell: ({ getValue }) => getValue() || 0,
      }),
      columnHelper.accessor('metadata.creationTimestamp', {
        id: 'created',
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
    [t, podsByNamespace, podsLoaded]
  )

  // 按命名空间分组展示（列本身就是分组依据，默认隐藏）。
  const grouping = useMemo(
    () => ({
      columnId: 'namespace',
      renderGroupHeader: (value: string) => (
        <span className="font-medium">
          {t('common.fields.namespace')}：{value}
        </span>
      ),
    }),
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
        defaultHiddenColumns={HIDDEN_BY_DEFAULT_COLUMNS}
        grouping={grouping}
        initialSorting={[{ id: 'namespace', desc: false }]}
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
