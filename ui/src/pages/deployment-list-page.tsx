import { useMemo, useState } from 'react'
import { IconNotes, IconReload, IconScale, IconTag } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { createColumnHelper } from '@tanstack/react-table'
import type { TFunction } from 'i18next'
import { Deployment } from 'kubernetes-types/apps/v1'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router-dom'

import {
  patchResource,
  restartWorkload,
  useResourceLastUpdates,
  useResources,
} from '@/lib/api'
import { useClusterNavigate } from '@/lib/cluster-path'
import { getClusterScopedStorageKey } from '@/lib/current-cluster'
import {
  createSearchFilter,
  getDeploymentRolloutTime,
  getDeploymentStatus,
  groupPodsByNamespace,
  resolveCreateNamespace,
  sumPodRestarts,
} from '@/lib/k8s'
import { formatAge, formatDate } from '@/lib/utils'
import { useCanAnyNamespace } from '@/hooks/use-can'
import { useNamespaceBindingMap } from '@/hooks/use-namespace-binding-map'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ClusterLink } from '@/components/cluster-link'
import { DeploymentStatusIcon } from '@/components/deployment-status-icon'
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

const deploymentSearchFilter = createSearchFilter<Deployment>(
  (d) => d.metadata?.name,
  (d) => d.metadata?.namespace
)

const columnHelper = createColumnHelper<Deployment>()

// 参考版式里没有的列保留但默认隐藏，需要时从表头「列」菜单打开。
const HIDDEN_BY_DEFAULT_COLUMNS = [
  'namespace',
  'labels',
  'annotations',
  'resource_limits',
  'created',
  'platform_updated',
  'rollout_updated',
]

// 注解值可能很长（如 last-applied-configuration），tooltip 里按长度裁剪。
const METADATA_VALUE_MAX_LENGTH = 60

function toSortedEntries(record?: Record<string, string>): [string, string][] {
  return Object.entries(record ?? {}).sort(([a], [b]) => a.localeCompare(b))
}

// kubectl apply 留下的整份清单副本：体积大、不是注解语义，导出时跳过。
const SKIPPED_EXPORT_ANNOTATIONS = new Set([
  'kubectl.kubernetes.io/last-applied-configuration',
])

function exportableAnnotationEntries(row: Deployment): [string, string][] {
  return toSortedEntries(row.metadata?.annotations).filter(
    ([key]) => !SKIPPED_EXPORT_ANNOTATIONS.has(key)
  )
}

/** 容器资源上限的分组文本：表格 chips 与导出共用同一口径。 */
function resourceLimitGroups(row: Deployment, t: TFunction) {
  return (row.spec?.template.spec?.containers ?? []).flatMap((container) => {
    const limits = container.resources?.limits
    const chips: string[] = []
    if (limits?.cpu) {
      chips.push(
        `${t('common.fields.cpu')}: ${formatCpuLimit(
          limits.cpu,
          t('common.units.cores', 'cores')
        )}`
      )
    }
    if (limits?.memory) {
      chips.push(`${t('common.fields.memory')}: ${limits.memory}`)
    }
    return chips.length > 0 ? [{ name: container.name, chips }] : []
  })
}

function truncateMetadataValue(value: string) {
  return value.length > METADATA_VALUE_MAX_LENGTH
    ? `${value.slice(0, METADATA_VALUE_MAX_LENGTH)}…`
    : value
}

// 纯数字的 CPU 值（如 "1"）补上单位，带单位的（如 "500m"）保持原样。
function formatCpuLimit(value: string, coresUnit: string) {
  return /^[\d.]+$/.test(value) ? `${value} ${coresUnit}` : value
}

// 标签、注解都用「图标 + 数量」，具体键值放在 tooltip 里，避免撑宽表格。
function MetadataSummaryCell({
  entries,
  icon: Icon,
}: {
  entries: [string, string][]
  icon: typeof IconTag
}) {
  if (entries.length === 0) {
    return <EmptyValue />
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="text-muted-foreground inline-flex cursor-default items-center gap-1 text-sm">
          <Icon className="size-4" />
          {entries.length}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">
        <div className="space-y-0.5 text-xs">
          {entries.map(([key, value]) => (
            <div key={key} className="break-all">
              <span className="font-medium">{key}</span>
              {value ? `=${truncateMetadataValue(value)}` : ''}
            </div>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

// 更新时间两列都是「相对时间 + 悬浮看完整时间与口径」：列宽有限，
// 而「哪种改动才算更新」的边界不适合写在单元格里。
function LastUpdateCell({ value, hint }: { value?: string; hint: string }) {
  const { t } = useTranslation()

  if (!value) {
    return (
      <Tooltip>
        <TooltipTrigger>
          <EmptyValue />
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs">{hint}</TooltipContent>
      </Tooltip>
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger>
        <span className="text-muted-foreground text-sm tabular-nums">
          {formatAge(value, t)}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs space-y-1 text-xs">
        <p className="font-mono">{formatDate(value)}</p>
        <p>{hint}</p>
      </TooltipContent>
    </Tooltip>
  )
}

export function DeploymentListPage() {
  const { namespace: namespaceParam } = useParams()
  const { t } = useTranslation()
  const navigate = useClusterNavigate()
  const queryClient = useQueryClient()
  const [isRestartDialogOpen, setIsRestartDialogOpen] = useState(false)
  const [isScaleDialogOpen, setIsScaleDialogOpen] = useState(false)
  const [batchDeployments, setBatchDeployments] = useState<Deployment[]>([])
  const [batchReplicas, setBatchReplicas] = useState(1)

  // 命名空间 → 权限绑定组名（导出时随行带上）。
  const bindingMap = useNamespaceBindingMap()

  // 重启会 patch pod 模板，因此需要 update 权限。
  const canUpdate = useCanAnyNamespace()('deployments', 'update')
  const batchActions = useMemo<ResourceTableBatchAction<Deployment>[]>(
    () => [
      {
        id: 'restart',
        label: t('common.actions.restart'),
        icon: <IconReload className="size-4" />,
        hidden: !canUpdate,
        onSelect: (deployments) => {
          setBatchDeployments(deployments)
          setIsRestartDialogOpen(true)
        },
      },
      {
        id: 'scale',
        label: t('common.actions.scale'),
        icon: <IconScale className="size-4" />,
        hidden: !canUpdate,
        onSelect: (deployments) => {
          setBatchDeployments(deployments)
          // 用第一个选中项的当前副本数作为初值，比固定 1 更贴近意图。
          setBatchReplicas(deployments[0]?.spec?.replicas ?? 1)
          setIsScaleDialogOpen(true)
        },
      },
    ],
    [t, canUpdate]
  )

  // 「平台操作时间」要按命名空间批量取数，但命名空间选择由表格自己的
  // 状态持有（见 use-resource-table-state）：这里按同一口径初始化，并在
  // onNamespaceChange 里跟进，不然列会停在旧命名空间的时点上。
  const [namespaceSelection, setNamespaceSelection] = useState<
    string | undefined
  >(() => {
    if (namespaceParam) return namespaceParam
    // 不写死 default：默认命名空间由表格按可访问列表解析，解析结果通过
    // onNamespaceChange 回传过来，在那之前不发「平台操作时间」的请求。
    return (
      sessionStorage.getItem(getClusterScopedStorageKey('selectedNamespace')) ||
      localStorage.getItem(getClusterScopedStorageKey('selectedNamespace')) ||
      undefined
    )
  })

  // 重启次数要按 selector 在 Pod 上汇总（Deployment 自身没有这个字段）。
  // 只在选中单个命名空间时取数：「全部 / 多选」下必须拉全集群 Pod，既慢又
  // 拖垮首屏，这一列在那种视图里留空（表格已加载的 Deployment 不受影响）。
  const podNamespace =
    namespaceSelection &&
    namespaceSelection !== '_all' &&
    !namespaceSelection.includes(',')
      ? namespaceSelection
      : undefined
  const { data: pods } = useResources('pods', podNamespace, {
    staleTime: 30_000,
    disable: !podNamespace,
  })
  const podsByNamespace = useMemo(() => groupPodsByNamespace(pods), [pods])
  const podsLoaded = pods !== undefined
  // 多选（逗号拼接）没有单段 URL 能表达，按命名空间逐个取，每个命名空间
  // 按自己的权限判定；「未选」时等表格解析出默认命名空间再取。
  const lastUpdateNamespaces = useMemo(() => {
    if (!namespaceSelection) return []
    if (namespaceSelection === '_all') return ['_all']
    return namespaceSelection.split(',').filter(Boolean)
  }, [namespaceSelection])
  const { data: lastUpdates } = useResourceLastUpdates(
    'deployments',
    lastUpdateNamespaces,
    // 列默认隐藏，但取数在页面挂载时就会发生：平台时间不敏感，放长缓存
    // 少几次聚合查询。
    { enabled: lastUpdateNamespaces.length > 0, staleTime: 60_000 }
  )

  // 定义 Deployment 表格的列
  const columns = useMemo(
    () => [
      columnHelper.accessor((row) => getDeploymentStatus(row), {
        id: 'status_conditions',
        header: t('common.fields.status'),
        cell: ({ getValue }) => {
          const status = getValue()
          return (
            <Badge variant="outline" className="text-muted-foreground px-1.5">
              <DeploymentStatusIcon status={status} />
              {status}
            </Badge>
          )
        },
      }),
      columnHelper.accessor('metadata.name', {
        header: t('common.fields.name'),
        cell: ({ row }) => (
          // 状态列排在最前，名称列不再是表格认定的「首个数据列」，这里显式
          // 保持左对齐与长名字换行。
          <div className="max-w-[400px] text-left font-medium break-words app-link">
            <ClusterLink
              to={`/deployments/${row.original.metadata!.namespace}/${
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
          // 界面显示「容器名: 镜像」；导出只留镜像字符串，避免把整个容器对象
          // 塞进一个单元格（一个容器就有 name/image/ports/volumeMounts/...）。
          meta: {
            csvValue: (row: Deployment) =>
              (row.spec?.template.spec?.containers ?? [])
                .map((container) => container.image)
                .filter(Boolean)
                .join('; '),
          },
        }
      ),
      columnHelper.accessor((row) => row.status?.readyReplicas ?? 0, {
        id: 'ready',
        header: t('common.fields.ready'),
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.status?.readyReplicas ?? 0} /{' '}
            {row.original.spec?.replicas ?? 0}
          </span>
        ),
      }),
      columnHelper.accessor((row) => row.status?.updatedReplicas ?? 0, {
        id: 'updated',
        header: t('common.fields.upToDate'),
        cell: ({ getValue }) => (
          <span className="tabular-nums">{getValue()}</span>
        ),
      }),
      columnHelper.accessor((row) => row.status?.availableReplicas ?? 0, {
        id: 'available',
        header: t('common.fields.available'),
        cell: ({ getValue }) => (
          <span className="tabular-nums">{getValue()}</span>
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
      // 健康列就是旧「就绪」上的扩缩容入口，挪到比例条上。
      columnHelper.display({
        id: 'health',
        header: t('common.fields.health'),
        cell: ({ row }) => (
          <WorkloadHealthBar
            ready={row.original.status?.readyReplicas ?? 0}
            desired={row.original.spec?.replicas ?? 0}
            name={row.original.metadata!.name!}
            namespace={row.original.metadata!.namespace!}
            resourceType="deployments"
            resourceLabel={t('nav.deployments')}
            canUpdate={canUpdate}
          />
        ),
      }),
      columnHelper.accessor((row) => row.metadata?.labels, {
        id: 'labels',
        header: t('common.fields.labels'),
        cell: ({ row }) => (
          <MetadataSummaryCell
            entries={toSortedEntries(row.original.metadata?.labels)}
            icon={IconTag}
          />
        ),
        // 导出写扁平文本，别把整个 labels 对象塞进单元格。
        meta: {
          csvValue: (row: Deployment) =>
            toSortedEntries(row.metadata?.labels)
              .map(([key, value]) => `${key}=${value}`)
              .join('; '),
        },
      }),
      columnHelper.accessor((row) => row.metadata?.annotations, {
        id: 'annotations',
        header: t('common.fields.annotations'),
        cell: ({ row }) => (
          <MetadataSummaryCell
            entries={toSortedEntries(row.original.metadata?.annotations)}
            icon={IconNotes}
          />
        ),
        meta: {
          csvValue: (row: Deployment) =>
            exportableAnnotationEntries(row)
              .map(([key, value]) => `${key}=${value}`)
              .join('; '),
        },
      }),
      columnHelper.accessor(
        (row) => row.spec?.template.spec?.containers ?? [],
        {
          id: 'resource_limits',
          enableSorting: false,
          header: t('common.fields.resourceLimits'),
          cell: ({ row }) => {
            const containers =
              row.original.spec?.template.spec?.containers ?? []
            const groups = resourceLimitGroups(row.original, t)

            if (groups.length === 0) {
              return <EmptyValue />
            }

            return (
              <div className="flex flex-col items-center gap-0.5">
                {groups.map((group) => (
                  <div
                    key={group.name}
                    className="flex flex-wrap items-center justify-center gap-1"
                  >
                    {containers.length > 1 && (
                      <span className="text-muted-foreground text-xs">
                        {group.name}
                      </span>
                    )}
                    {group.chips.map((chip) => (
                      <Badge
                        key={chip}
                        variant="secondary"
                        className="font-normal"
                      >
                        {chip}
                      </Badge>
                    ))}
                  </div>
                ))}
              </div>
            )
          },
          // 与表格 chips 一致：单容器只写「cpu: 1 核, memory: 1Gi」，
          // 多容器带容器名前缀，避免输出整个容器对象。
          meta: {
            csvValue: (row: Deployment) => {
              const containers = row.spec?.template.spec?.containers ?? []
              return resourceLimitGroups(row, t)
                .map((group) =>
                  containers.length > 1
                    ? `${group.name}: ${group.chips.join(', ')}`
                    : group.chips.join(', ')
                )
                .join('; ')
            },
          },
        }
      ),
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
      // 两个口径的更新时间：一个看平台里最后一次写入（审计记录），
      // 一个看对象实际发布推进的时间（K8s 状态）。
      columnHelper.accessor(
        (row) =>
          lastUpdates?.[`${row.metadata?.namespace}/${row.metadata?.name}`],
        {
          id: 'platform_updated',
          header: t('common.fields.platformUpdated'),
          cell: ({ getValue }) => (
            <LastUpdateCell
              value={getValue()}
              hint={t('common.messages.platformUpdatedHint')}
            />
          ),
        }
      ),
      columnHelper.accessor((row) => getDeploymentRolloutTime(row), {
        id: 'rollout_updated',
        header: t('common.fields.rolloutUpdated'),
        cell: ({ getValue }) => (
          <LastUpdateCell
            value={getValue()}
            hint={t('common.messages.rolloutUpdatedHint')}
          />
        ),
      }),
      columnHelper.display({
        id: 'actions',
        header: () => (
          <div className="text-right">{t('common.fields.actions')}</div>
        ),
        cell: ({ row }) => (
          <div className="flex justify-end">
            <ResourceRowActions
              resourceType="deployments"
              resource={row.original}
            />
          </div>
        ),
      }),
    ],
    [t, canUpdate, podsByNamespace, podsLoaded, lastUpdates]
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

  // 导出时带上命名空间（分组列会自动补进 CSV）与该命名空间所属的权限
  // 绑定组（与 /namespaces 页的「权限绑定」同源，未绑定时为空）。
  const exportData = useMemo(
    () => ({
      fileName: 'deployments',
      csvColumns: [
        {
          header: t('common.fields.bindingGroup'),
          value: (row: Deployment) =>
            bindingMap.get(row.metadata?.namespace ?? '') ?? '',
        },
      ],
    }),
    [t, bindingMap]
  )

  // URL 的命名空间段只能表达一个命名空间。多选时表格自己把选择存在
  // sessionStorage / localStorage 里（见 useResourceTableState 的
  // handleNamespaceChange），逗号拼接的形态只存在于状态、不该出现在 URL 上。
  const namespaceParamNames = useMemo(
    () => (namespaceParam ? namespaceParam.split(',').filter(Boolean) : []),
    [namespaceParam]
  )
  // URL 中的命名空间在当前集群中是否存在？当用户切换集群时，URL 里的命名空间可能已不存在。
  const { data: allNamespaces } = useResources('namespaces', undefined, {
    staleTime: 60_000,
  })
  const namespaceExists = useMemo(() => {
    // 多选不是一个命名空间名，不做存在性判定：它一旦命中这个分支，整页会被
    // 替换成「命名空间不存在」，工具栏（含命名空间选择器）一起消失。
    if (namespaceParamNames.length !== 1) return true
    if (!allNamespaces) return true // still loading: assume it exists
    return allNamespaces.some(
      (ns) => ns.metadata?.name === namespaceParamNames[0]
    )
  }, [allNamespaces, namespaceParamNames])

  if (namespaceParam && !namespaceExists) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6">
        <div className="flex max-w-md flex-col items-center gap-3 rounded-md border border-dashed p-8 text-center">
          <p className="text-sm font-medium">
            {t('common.messages.namespaceNotFoundOnCluster', {
              namespace: namespaceParam,
              defaultValue:
                '命名空间 {{namespace}} 在当前集群中不存在，可能来自其他集群。',
            })}
          </p>
          <p className="text-xs text-muted-foreground">
            {t(
              'common.messages.namespaceNotFoundHint',
              '请选择下方的一个命名空间，或查看全部命名空间的资源。'
            )}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate('/deployments')}
            >
              {t('workloadWizard.viewAll', '查看全部')}
            </Button>
            {(allNamespaces || []).slice(0, 5).map((ns) => {
              const name = ns.metadata?.name
              if (!name) return null
              return (
                <Button
                  key={name}
                  variant="secondary"
                  size="sm"
                  onClick={() => navigate(`/deployments/${name}`)}
                >
                  {name}
                </Button>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  const handleCreateClick = () => {
    // URL 优先，其次是表格持久化的选择；多选或
    // "所有命名空间"的选择无法承载新对象。
    const ns = resolveCreateNamespace(
      namespaceParam,
      sessionStorage.getItem(getClusterScopedStorageKey('selectedNamespace')),
      localStorage.getItem(getClusterScopedStorageKey('selectedNamespace'))
    )
    navigate(`/deployments/${encodeURIComponent(ns)}/create?tab=container-0`)
  }

  return (
    <>
      <ResourceTable
        resourceName="Deployments"
        columns={columns}
        searchQueryFilter={deploymentSearchFilter}
        defaultHiddenColumns={HIDDEN_BY_DEFAULT_COLUMNS}
        grouping={grouping}
        exportData={exportData}
        initialSorting={[{ id: 'namespace', desc: false }]}
        showCreateButton={true}
        onCreateClick={handleCreateClick}
        batchActions={batchActions}
        initialNamespace={namespaceParam}
        onNamespaceChange={(ns) => {
          setNamespaceSelection(ns || '_all')
          // 保持 URL 同步：/deployments/<ns> 或 /deployments（表示全部）。
          // 多选（逗号拼接）没有单段 URL 能表达，也写不得——URL 里的逗号值会被
          // 上面的存在性判定当成一个命名空间名，把整页变成报错页。选择本身已经
          // 由表格状态持久化，刷新能恢复。
          const single = ns && ns !== '_all' && !ns.includes(',') ? ns : ''
          navigate(
            single
              ? `/deployments/${encodeURIComponent(single)}`
              : '/deployments',
            { replace: true }
          )
        }}
      />

      <ResourceBatchActionDialog
        open={isRestartDialogOpen}
        onOpenChange={setIsRestartDialogOpen}
        resources={batchDeployments}
        title={t('resourceTable.batchActions.restartResourcesTitle', {
          count: batchDeployments.length,
          resource: t('nav.deployments'),
        })}
        description={t(
          'resourceTable.batchActions.restartResourcesDescription',
          { resource: t('nav.deployments') }
        )}
        actionLabel={t('common.actions.restart')}
        onExecute={(deployment) =>
          restartWorkload(
            'deployments',
            deployment.metadata!.name!,
            deployment.metadata!.namespace!
          )
        }
        onComplete={() => {
          queryClient.invalidateQueries({ queryKey: ['deployments'] })
          // 平台操作时间来自审计记录，不随 K8s watch 刷新：写完主动重取。
          queryClient.invalidateQueries({
            queryKey: ['resource-last-updates'],
          })
        }}
        destructive={true}
      />

      <ResourceBatchActionDialog
        open={isScaleDialogOpen}
        onOpenChange={setIsScaleDialogOpen}
        resources={batchDeployments}
        title={t('resourceTable.batchActions.scaleResourcesTitle', {
          count: batchDeployments.length,
          resource: t('nav.deployments'),
          replicas: batchReplicas,
        })}
        description={t('resourceTable.batchActions.scaleResourcesDescription', {
          resource: t('nav.deployments'),
          replicas: batchReplicas,
        })}
        actionLabel={t('common.actions.scale')}
        options={(isRunning) => (
          <div className="space-y-2">
            <Label htmlFor="batch-replicas">
              {t('common.fields.replicas')}
            </Label>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                className="size-9 p-0"
                onClick={() => setBatchReplicas(Math.max(0, batchReplicas - 1))}
                disabled={isRunning || batchReplicas <= 0}
              >
                -
              </Button>
              <Input
                id="batch-replicas"
                type="number"
                min="0"
                value={batchReplicas}
                onChange={(e) =>
                  setBatchReplicas(Math.max(0, parseInt(e.target.value) || 0))
                }
                disabled={isRunning}
                className="text-center"
              />
              <Button
                variant="outline"
                size="sm"
                className="size-9 p-0"
                onClick={() => setBatchReplicas(batchReplicas + 1)}
                disabled={isRunning}
              >
                +
              </Button>
            </div>
          </div>
        )}
        onExecute={(deployment) =>
          patchResource(
            'deployments',
            deployment.metadata!.name!,
            deployment.metadata!.namespace!,
            { spec: { replicas: batchReplicas } }
          )
        }
        onComplete={() => {
          queryClient.invalidateQueries({ queryKey: ['deployments'] })
          // 平台操作时间来自审计记录，不随 K8s watch 刷新：写完主动重取。
          queryClient.invalidateQueries({
            queryKey: ['resource-last-updates'],
          })
        }}
      />
    </>
  )
}
