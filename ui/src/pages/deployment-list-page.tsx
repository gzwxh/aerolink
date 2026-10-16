import { useMemo, useState } from 'react'
import { IconNotes, IconReload, IconScale, IconTag } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { createColumnHelper } from '@tanstack/react-table'
import { Deployment } from 'kubernetes-types/apps/v1'
import type { Container } from 'kubernetes-types/core/v1'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router-dom'
import { toast } from 'sonner'

import { patchResource, restartWorkload, useResources } from '@/lib/api'
import { copyToClipboard } from '@/lib/clipboard'
import { useClusterNavigate } from '@/lib/cluster-path'
import { getClusterScopedStorageKey } from '@/lib/current-cluster'
import { shortenImageName } from '@/lib/image-name'
import {
  createSearchFilter,
  getDeploymentStatus,
  resolveCreateNamespace,
} from '@/lib/k8s'
import { formatDate, translateError } from '@/lib/utils'
import { useCanAnyNamespace } from '@/hooks/use-can'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
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

const deploymentSearchFilter = createSearchFilter<Deployment>(
  (d) => d.metadata?.name,
  (d) => d.metadata?.namespace
)

const columnHelper = createColumnHelper<Deployment>()

// 注解值可能很长（如 last-applied-configuration），tooltip 里按长度裁剪。
const METADATA_VALUE_MAX_LENGTH = 60

function toSortedEntries(record?: Record<string, string>): [string, string][] {
  return Object.entries(record ?? {}).sort(([a], [b]) => a.localeCompare(b))
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

function EmptyValue() {
  return <span className="text-muted-foreground text-sm">-</span>
}

// 数量列的行内扩缩容：把「就绪 / 期望」里的期望值变成可点击的步进器入口
// （参考 TCE 控制台的健康列），确认后按 spec.replicas patch。
function ReplicasCell({
  deployment,
  canUpdate,
}: {
  deployment: Deployment
  canUpdate: boolean
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [replicas, setReplicas] = useState(deployment.spec?.replicas ?? 1)
  const [isApplying, setIsApplying] = useState(false)

  const ready = deployment.status?.readyReplicas || 0
  const desired = deployment.spec?.replicas ?? 0

  const handleApply = async () => {
    setIsApplying(true)
    try {
      await patchResource(
        'deployments',
        deployment.metadata!.name!,
        deployment.metadata!.namespace!,
        { spec: { replicas } }
      )
      toast.success(
        t('detail.status.scaledTo', { resource: 'Deployment', replicas })
      )
      setOpen(false)
      queryClient.invalidateQueries({ queryKey: ['deployments'] })
    } catch (error) {
      toast.error(translateError(error, t))
    } finally {
      setIsApplying(false)
    }
  }

  if (!canUpdate) {
    return (
      <div>
        {ready} / {desired}
      </div>
    )
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          // 每次打开都按当前值重置，避免上一行/上次留下的草稿。
          setReplicas(deployment.spec?.replicas ?? 1)
        }
        setOpen(next)
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          title={t('detail.dialogs.scaleDeployment.description')}
          className="underline-offset-2 hover:underline"
        >
          {ready} / {desired}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56" align="start">
        <div className="space-y-3">
          <Label htmlFor={`replicas-${deployment.metadata?.uid}`}>
            {t('common.fields.replicas')}
          </Label>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="size-9 p-0"
              onClick={() => setReplicas(Math.max(0, replicas - 1))}
              disabled={isApplying || replicas <= 0}
            >
              -
            </Button>
            <Input
              id={`replicas-${deployment.metadata?.uid}`}
              type="number"
              min="0"
              value={replicas}
              onChange={(e) =>
                setReplicas(Math.max(0, parseInt(e.target.value) || 0))
              }
              disabled={isApplying}
              className="text-center"
            />
            <Button
              variant="outline"
              size="sm"
              className="size-9 p-0"
              onClick={() => setReplicas(replicas + 1)}
              disabled={isApplying}
            >
              +
            </Button>
          </div>
          <Button
            onClick={handleApply}
            disabled={isApplying}
            className="w-full"
          >
            {t('common.actions.scale')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
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

// 容器与镜像：列表里只显示镜像名与 tag，完整地址悬浮查看，点击即复制。
export function ContainerImageCell({
  containers,
}: {
  containers: Container[]
}) {
  const { t } = useTranslation()

  if (containers.length === 0) {
    return <EmptyValue />
  }

  const copyImage = async (event: React.MouseEvent, image: string) => {
    // 行点击会跳详情页，复制不能连带触发。
    event.stopPropagation()
    if (await copyToClipboard(image)) {
      toast.success(t('common.messages.copied', '已复制到剪贴板'))
    } else {
      toast.error(
        t('common.messages.copyFailed', '复制失败，请手动选择文本后复制')
      )
    }
  }

  return (
    <div className="flex flex-col items-center gap-0.5 text-xs">
      {containers.map((container) => (
        <Tooltip key={container.name}>
          <TooltipTrigger asChild>
            <div
              className="flex w-full min-w-0 max-w-72 cursor-copy items-baseline justify-center gap-1"
              onClick={(event) => void copyImage(event, container.image || '')}
            >
              <span className="shrink-0 text-muted-foreground">
                {container.name}:{' '}
              </span>
              <span className="min-w-0 truncate font-mono underline-offset-2 hover:underline">
                {shortenImageName(container.image || '')}
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm break-all font-mono text-xs">
            {container.name}: {container.image}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
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

  // 定义 Deployment 表格的列
  const columns = useMemo(
    () => [
      columnHelper.accessor('metadata.name', {
        header: t('common.fields.name'),
        cell: ({ row }) => (
          <div className="font-medium app-link">
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
      columnHelper.accessor((row) => row.status?.readyReplicas ?? 0, {
        id: 'ready',
        header: t('common.fields.ready'),
        cell: ({ row }) => (
          <ReplicasCell deployment={row.original} canUpdate={canUpdate} />
        ),
      }),
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
      columnHelper.accessor((row) => row.metadata?.labels, {
        id: 'labels',
        header: t('common.fields.labels'),
        cell: ({ row }) => (
          <MetadataSummaryCell
            entries={toSortedEntries(row.original.metadata?.labels)}
            icon={IconTag}
          />
        ),
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
      }),
      columnHelper.accessor(
        (row) => row.spec?.template.spec?.containers ?? [],
        {
          id: 'containers_images',
          enableSorting: false,
          header: t('common.fields.containersAndImages'),
          cell: ({ row }) => (
            <ContainerImageCell
              containers={row.original.spec?.template.spec?.containers ?? []}
            />
          ),
        }
      ),
      columnHelper.accessor(
        (row) => row.spec?.template.spec?.containers ?? [],
        {
          id: 'resource_limits',
          enableSorting: false,
          header: t('common.fields.resourceLimits'),
          cell: ({ row }) => {
            const containers =
              row.original.spec?.template.spec?.containers ?? []
            const groups = containers.flatMap((container) => {
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
              resourceType="deployments"
              resource={row.original}
            />
          </div>
        ),
      }),
    ],
    [t, canUpdate]
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
        showCreateButton={true}
        onCreateClick={handleCreateClick}
        batchActions={batchActions}
        initialNamespace={namespaceParam}
        onNamespaceChange={(ns) => {
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
        onComplete={() =>
          queryClient.invalidateQueries({ queryKey: ['deployments'] })
        }
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
        onComplete={() =>
          queryClient.invalidateQueries({ queryKey: ['deployments'] })
        }
      />
    </>
  )
}
