import { useCallback, useMemo, useState } from 'react'
import {
  IconAlertTriangle,
  IconBan,
  IconCircleCheckFilled,
  IconDownload,
  IconDroplet,
  IconTrash,
} from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { createColumnHelper } from '@tanstack/react-table'
import * as yaml from 'js-yaml'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { NodeWithMetrics } from '@/types/api'
import { cordonNode, uncordonNode } from '@/lib/api'
import { createSearchFilter, getNodeStatus, type NodeStatus } from '@/lib/k8s'
import { statusBadge } from '@/lib/status-badge'
import { formatDate, translateError } from '@/lib/utils'
import { useCan } from '@/hooks/use-can'
import { Badge } from '@/components/ui/badge'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ClusterLink } from '@/components/cluster-link'
import { MetricCell } from '@/components/metrics-cell'
import { NodeDeleteDialog } from '@/components/node-delete-dialog'
import { NodeDrainDialog } from '@/components/node-drain-dialog'
import { NodeRowActions } from '@/components/node-row-actions'
import { NodeStatusIcon } from '@/components/node-status-icon'
import {
  ResourceTable,
  type ResourceTableBatchAction,
} from '@/components/resource-table'

function getNodeRoles(node: NodeWithMetrics): string[] {
  const labels = node.metadata?.labels || {}
  const roles: string[] = []

  // 检查常见的节点角色标签
  if (
    labels['node-role.kubernetes.io/master'] !== undefined ||
    labels['node-role.kubernetes.io/control-plane'] !== undefined
  ) {
    roles.push('control-plane')
  }

  if (labels['node-role.kubernetes.io/worker'] !== undefined) {
    roles.push('worker')
  }

  if (labels['node-role.kubernetes.io/etcd'] !== undefined) {
    roles.push('etcd')
  }

  Object.keys(labels).forEach((key) => {
    if (
      key.startsWith('node-role.kubernetes.io/') &&
      !['master', 'control-plane', 'worker', 'etcd'].includes(key.split('/')[1])
    ) {
      const role = key.split('/')[1]
      if (role && !roles.includes(role)) {
        roles.push(role)
      }
    }
  })

  return roles // Do not assume a default role if none are found
}

// 优先 Internal IP，其次 External IP，最后回退到主机名
function getNodeIP(node: NodeWithMetrics): string {
  const addresses = node.status?.addresses || []

  const internalIP = addresses.find((addr) => addr.type === 'InternalIP')
  if (internalIP) {
    return internalIP.address
  }

  const externalIP = addresses.find((addr) => addr.type === 'ExternalIP')
  if (externalIP) {
    return externalIP.address
  }

  const hostname = addresses.find((addr) => addr.type === 'Hostname')
  if (hostname) {
    return hostname.address
  }

  return 'N/A'
}

// 系统管理的键（kubernetes.io/...）是自动创建的，对运维来说是噪音，因此一律隐藏。
const isSystemKey = (key: string) => key.includes('kubernetes.io')

// 例外：节点异常时 node-controller / kubelet 打的这些污点必须留在污点列里，
// 它们是「节点掉过线」「资源吃紧」的直接证据，藏起来就看不出异常。
const VISIBLE_SYSTEM_TAINT_KEYS = new Set([
  'node.kubernetes.io/unreachable',
  'node.kubernetes.io/not-ready',
  'node.kubernetes.io/network-unavailable',
  'node.kubernetes.io/memory-pressure',
  'node.kubernetes.io/disk-pressure',
  'node.kubernetes.io/pid-pressure',
])

/** 污点列需要隐藏的键。 */
const isHiddenTaintKey = (key: string) =>
  isSystemKey(key) && !VISIBLE_SYSTEM_TAINT_KEYS.has(key)

function formatNodeTaint(taint: {
  key: string
  value?: string
  effect?: string
}): string {
  const value = taint.value ? `=${taint.value}` : ''
  return `${taint.key}${value}:${taint.effect ?? ''}`
}

/** 节点上需要展示的污点。 */
function nodeTaints(node: NodeWithMetrics) {
  return (node.spec?.taints ?? []).filter(
    (taint) => !isHiddenTaintKey(taint.key)
  )
}

/** 节点的非系统标签，按 key 排序。 */
function nodeLabels(node: NodeWithMetrics) {
  return Object.entries(node.metadata?.labels ?? {})
    .filter(([key]) => !isSystemKey(key))
    .sort(([a], [b]) => a.localeCompare(b))
}

/** 表格里的污点列：固定宽度、单行显示（第一个 + 剩余数量），悬浮看全部。 */
function NodeTaintsCell({ node }: { node: NodeWithMetrics }) {
  const taints = nodeTaints(node)
  if (taints.length === 0) {
    return <span className="text-muted-foreground">—</span>
  }

  // 只显示第一个 + 剩余数量：列宽固定、行高不涨，全部内容靠悬浮看。
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex w-full min-w-0 items-center gap-1 overflow-hidden">
          <Badge
            {...statusBadge('warning')}
            className="min-w-0 truncate text-xs font-normal"
          >
            {formatNodeTaint(taints[0])}
          </Badge>
          {taints.length > 1 && (
            <span className="shrink-0 text-xs text-muted-foreground">
              +{taints.length - 1}
            </span>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">
        <div className="flex flex-col gap-1 text-sm">
          {taints.map((taint) => (
            <span key={`${taint.key}-${taint.effect}`} className="break-all">
              {formatNodeTaint(taint)}
            </span>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

/** 表格里的标签列：固定宽度、单行显示（第一个 + 剩余数量），悬浮看全部。 */
function NodeLabelsCell({ node }: { node: NodeWithMetrics }) {
  const labels = nodeLabels(node)
  if (labels.length === 0) {
    return <span className="text-muted-foreground">—</span>
  }

  // 同污点列：定宽单行，第一个标签 + 剩余数量，全部靠悬浮看。
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex w-full min-w-0 items-center gap-1 overflow-hidden">
          <Badge variant="outline" className="min-w-0 truncate font-normal">
            {labels[0][0]}={labels[0][1]}
          </Badge>
          {labels.length > 1 && (
            <span className="shrink-0 text-xs text-muted-foreground">
              +{labels.length - 1}
            </span>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">
        <div className="flex flex-col gap-1 text-sm">
          {labels.map(([key, value]) => (
            <span key={key} className="break-all">
              {key}={value}
            </span>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

/** 表格里的状态徽章：失联单独提示，其余沿用 k8s 的状态字面量。 */
function NodeStatusBadge({ status }: { status: NodeStatus }) {
  const { t } = useTranslation()

  if (status.unreachable) {
    return (
      <Badge {...statusBadge('failure')} className="text-xs">
        <NodeStatusIcon status={status.kind} />
        {t('nodes.status.unreachable')}
      </Badge>
    )
  }

  if (status.cordoned) {
    return (
      <Badge {...statusBadge('warning')} className="text-xs">
        {t('nodes.cordoned', 'Cordoned')}
      </Badge>
    )
  }

  return (
    <Badge variant="outline" className="text-muted-foreground px-1.5">
      <NodeStatusIcon status={status.kind} />
      {status.kind === 'Unknown' ? t('nodes.status.unknown') : status.kind}
    </Badge>
  )
}

const nodeSearchFilter = createSearchFilter<NodeWithMetrics>(
  (n) => n.metadata?.name,
  (n) => n.status?.nodeInfo?.kubeletVersion,
  (n) => getNodeStatus(n).kind,
  (n) => getNodeRoles(n),
  (n) => getNodeIP(n)
)

const columnHelper = createColumnHelper<NodeWithMetrics>()

function downloadNodeYaml(node: NodeWithMetrics) {
  const content = yaml.dump(node, { indent: 2, noRefs: true })
  const blob = new Blob([content], { type: 'application/x-yaml' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${node.metadata?.name || 'node'}.yaml`
  link.click()
  URL.revokeObjectURL(url)
}

export function NodeListPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const can = useCan()
  const canUpdateNodes = can('nodes', 'update')
  const canDeleteNodes = can('nodes', 'delete')

  const [selectedNodes, setSelectedNodes] = useState<NodeWithMetrics[]>([])
  const [drainTargets, setDrainTargets] = useState<NodeWithMetrics[]>([])
  const [deleteTargets, setDeleteTargets] = useState<NodeWithMetrics[]>([])
  const [showDrainDialog, setShowDrainDialog] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)

  const hasSelection = selectedNodes.length > 0
  const hasSchedulableSelection = selectedNodes.some(
    (node) => !node.spec?.unschedulable
  )
  const hasCordonedSelection = selectedNodes.some(
    (node) => !!node.spec?.unschedulable
  )

  const runNodeAction = useCallback(
    async (
      nodes: NodeWithMetrics[],
      action: (name: string) => Promise<unknown>,
      successKey: string
    ) => {
      const errors: string[] = []
      let done = 0
      for (const node of nodes) {
        const name = node.metadata?.name || ''
        try {
          await action(name)
          done += 1
        } catch (err) {
          errors.push(`${name}: ${translateError(err, t)}`)
        }
      }
      await queryClient.invalidateQueries({ queryKey: ['nodes'] })
      if (errors.length > 0) {
        toast.error(errors.join('; '))
      } else {
        toast.success(
          t(successKey, {
            count: done,
            defaultValue: '{{count}} node(s) updated',
          })
        )
      }
    },
    [queryClient, t]
  )

  const batchActions = useMemo<ResourceTableBatchAction<NodeWithMetrics>[]>(
    () => [
      {
        id: 'cordon',
        label: t('common.actions.cordon'),
        icon: <IconBan className="size-4" />,
        hidden: !canUpdateNodes,
        disabled: !hasSelection || !hasSchedulableSelection,
        onSelect: (nodes) =>
          void runNodeAction(nodes, cordonNode, 'nodes.cordonedCount'),
      },
      {
        id: 'uncordon',
        label: t('common.actions.uncordon'),
        icon: <IconCircleCheckFilled className="size-4" />,
        hidden: !canUpdateNodes || !hasCordonedSelection,
        disabled: !hasSelection,
        onSelect: (nodes) =>
          void runNodeAction(nodes, uncordonNode, 'nodes.uncordonedCount'),
      },
      {
        id: 'drain',
        label: t('common.actions.drain'),
        icon: <IconDroplet className="size-4" />,
        hidden: !canUpdateNodes,
        disabled: !hasSelection,
        onSelect: (nodes) => {
          setDrainTargets(nodes)
          setShowDrainDialog(true)
        },
      },
      {
        id: 'download',
        label: t('common.actions.downloadYaml'),
        icon: <IconDownload className="size-4" />,
        disabled: !hasSelection,
        onSelect: (nodes) => nodes.forEach(downloadNodeYaml),
      },
      {
        id: 'delete',
        label: t('common.actions.delete'),
        icon: <IconTrash className="size-4" />,
        hidden: !canDeleteNodes,
        disabled: !hasSelection,
        onSelect: (nodes) => {
          setDeleteTargets(nodes)
          setShowDeleteDialog(true)
        },
      },
    ],
    [
      t,
      canUpdateNodes,
      canDeleteNodes,
      hasSelection,
      hasSchedulableSelection,
      hasCordonedSelection,
      runNodeAction,
    ]
  )

  // 行级 drain 打开与工具栏操作相同的选项对话框。
  const handleRowDrain = useCallback((node: NodeWithMetrics) => {
    setDrainTargets([node])
    setShowDrainDialog(true)
  }, [])

  // 定义节点表格的列
  const columns = useMemo(
    () => [
      columnHelper.accessor('metadata.name', {
        header: t('common.fields.name'),
        // 节点名很短（gpu-101 / host-107 这类），列宽按比例分配时给它 220 太占地方。
        // 120 足够放下名字并留出省略号，省下的宽度分给 CPU / 内存 / 污点这些内容列。
        size: 120,
        cell: ({ row }) => (
          <div className="font-medium app-link">
            {/* 主机名完整显示：超长时在列内换行（break-all），不截断；
                想要单行展示可以用列头右侧的拖拽手柄把这一列拉宽。 */}
            <ClusterLink
              to={`/nodes/${row.original.metadata!.name}`}
              className="block whitespace-normal break-all"
              title={row.original.metadata!.name}
            >
              {row.original.metadata!.name}
            </ClusterLink>
          </div>
        ),
      }),
      columnHelper.accessor((row) => getNodeStatus(row).kind, {
        id: 'status',
        header: t('common.fields.status'),
        cell: ({ row }) => {
          const status = getNodeStatus(row.original)
          return (
            <div className="flex items-center gap-1.5">
              <NodeStatusBadge status={status} />
              {status.heartbeatStale && !status.unreachable && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <IconAlertTriangle className="text-warning size-3.5 shrink-0" />
                  </TooltipTrigger>
                  <TooltipContent>
                    {t('nodes.heartbeatStale', {
                      minutes: Math.max(
                        1,
                        Math.round((status.heartbeatAgeMs ?? 0) / 60000)
                      ),
                    })}
                  </TooltipContent>
                </Tooltip>
              )}
              {/* Ready=True 时压力不进 kind（徽标仍显示「就绪」），单独用警告图标提示。 */}
              {status.ready === 'True' && status.pressures.length > 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <IconAlertTriangle className="text-warning size-3.5 shrink-0" />
                  </TooltipTrigger>
                  <TooltipContent>
                    {t('nodes.pressures', {
                      pressures: status.pressures.join(', '),
                    })}
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          )
        },
      }),
      columnHelper.accessor((row) => getNodeRoles(row).join(', '), {
        id: 'roles',
        header: t('common.fields.roles', 'Roles'),
        cell: ({ row }) => {
          const roles = getNodeRoles(row.original)
          return (
            <div>
              {roles.map((role) => (
                <Badge
                  key={role}
                  variant={role === 'control-plane' ? 'default' : 'secondary'}
                  className="text-xs"
                >
                  {role}
                </Badge>
              ))}
            </div>
          )
        },
      }),
      // 污点与标签也放进表格（原先只在展开行里）：节点多的时候不必逐行展开就能扫一遍。
      // 每列只显示前几个，完整列表仍在展开行。
      columnHelper.display({
        id: 'taints',
        header: t('common.fields.taints', 'Taints'),
        // 固定宽度：内容多少都不撑开表格，看全部靠悬浮。
        size: 180,
        cell: ({ row }) => <NodeTaintsCell node={row.original} />,
      }),
      columnHelper.display({
        id: 'labels',
        header: t('common.fields.labels', 'Labels'),
        // 标签一般更长，给宽一点，但同样是固定宽度。
        size: 220,
        cell: ({ row }) => <NodeLabelsCell node={row.original} />,
      }),
      columnHelper.accessor((row) => row.metrics?.pods || 0, {
        id: 'pods',
        header: t('common.fields.pods', 'Pod 数'),
        cell: ({ row }) => (
          <ClusterLink
            to={`/nodes/${row.original.metadata!.name}?tab=pods`}
            className="block transition-colors hover:text-primary/80"
          >
            <MetricCell metrics={row.original.metrics} type="pods" />
          </ClusterLink>
        ),
      }),
      columnHelper.accessor((row) => row.metrics?.cpuUsage || 0, {
        id: 'cpu',
        header: t('common.fields.cpu', 'CPU'),
        // 指标列要放下「用量 / 上限 + 百分比」两行，比默认列宽宽一些。
        size: 180,
        cell: ({ row }) => (
          <MetricCell
            metrics={row.original.metrics}
            type="cpu"
            limitLabel={t('common.fields.allocatable', '可分配')}
            showPercentage={true}
          />
        ),
      }),
      columnHelper.accessor((row) => row.metrics?.memoryUsage || 0, {
        id: 'memory',
        header: t('common.fields.memory', 'Memory'),
        // 内存文本最长（4.69 GiB / 8 GiB），再宽一点。
        size: 200,
        cell: ({ row }) => (
          <MetricCell
            metrics={row.original.metrics}
            type="memory"
            limitLabel={t('common.fields.allocatable', '可分配')}
            showPercentage={true}
          />
        ),
      }),
      columnHelper.accessor((row) => getNodeIP(row), {
        id: 'ip',
        header: t('common.fields.ip', 'IP 地址'),
        cell: ({ getValue }) => {
          const ip = getValue()
          return (
            <span
              className="block truncate font-mono text-sm text-muted-foreground"
              title={ip}
            >
              {ip}
            </span>
          )
        },
      }),
      columnHelper.accessor('status.nodeInfo.kubeletVersion', {
        header: t('common.fields.version', 'Version'),
        cell: ({ getValue }) => {
          const version = getValue()
          return version ? (
            <span className="block truncate font-mono text-sm" title={version}>
              {version}
            </span>
          ) : (
            <span className="text-muted-foreground">N/A</span>
          )
        },
      }),
      columnHelper.accessor('status.nodeInfo.kernelVersion', {
        header: t('common.fields.kernelVersion', 'Kernel Version'),
        cell: ({ getValue }) => {
          const kernelVersion = getValue()
          return kernelVersion ? (
            <span className="block truncate text-sm" title={kernelVersion}>
              {kernelVersion}
            </span>
          ) : (
            <span className="text-muted-foreground">N/A</span>
          )
        },
      }),
      columnHelper.accessor('status.nodeInfo.osImage', {
        header: t('common.fields.osImage', 'OS Image'),
        cell: ({ getValue }) => {
          const osImage = getValue()
          return osImage ? (
            <span className="block truncate text-sm" title={osImage}>
              {osImage}
            </span>
          ) : (
            <span className="text-muted-foreground">N/A</span>
          )
        },
      }),
      columnHelper.accessor('metadata.creationTimestamp', {
        header: t('common.fields.created'),
        cell: ({ getValue }) => {
          const dateStr = formatDate(getValue() || '')
          return (
            <span
              className="block truncate text-sm text-muted-foreground"
              title={dateStr}
            >
              {dateStr}
            </span>
          )
        },
      }),
      columnHelper.display({
        id: 'actions',
        header: t('common.fields.actions', 'Actions'),
        cell: ({ row }) => (
          <NodeRowActions node={row.original} onDrain={handleRowDrain} />
        ),
      }),
    ],
    [t, handleRowDrain]
  )

  return (
    <>
      <ResourceTable
        resourceName="Nodes"
        resourceType="nodes"
        columns={columns}
        clusterScope={true}
        searchQueryFilter={nodeSearchFilter}
        showCreateButton={false}
        batchActions={batchActions}
        alwaysShowBatchActions
        showBatchDelete={false}
        onRowSelectionChange={setSelectedNodes}
        defaultHiddenColumns={[
          'status_nodeInfo_kernelVersion',
          'status_nodeInfo_osImage',
        ]}
      />

      <NodeDrainDialog
        open={showDrainDialog}
        onOpenChange={setShowDrainDialog}
        nodes={drainTargets}
        onDrained={() => queryClient.invalidateQueries({ queryKey: ['nodes'] })}
      />

      <NodeDeleteDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        nodes={deleteTargets}
        onDeleted={() => queryClient.invalidateQueries({ queryKey: ['nodes'] })}
      />
    </>
  )
}
