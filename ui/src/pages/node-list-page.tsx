import { useCallback, useMemo, useState } from 'react'
import {
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
import { Link } from 'react-router-dom'
import { toast } from 'sonner'

import { NodeWithMetrics } from '@/types/api'
import { cordonNode, uncordonNode } from '@/lib/api'
import { createSearchFilter } from '@/lib/k8s'
import { formatDate, translateError } from '@/lib/utils'
import { useCan } from '@/hooks/use-can'
import { Badge } from '@/components/ui/badge'
import { MetricCell } from '@/components/metrics-cell'
import { NodeDeleteDialog } from '@/components/node-delete-dialog'
import { NodeDrainDialog } from '@/components/node-drain-dialog'
import { NodeRowActions } from '@/components/node-row-actions'
import { NodeStatusIcon } from '@/components/node-status-icon'
import {
  ResourceTable,
  type ResourceTableBatchAction,
} from '@/components/resource-table'

function getNodeStatus(node: NodeWithMetrics): string {
  const conditions = node.status?.conditions || []
  const isUnschedulable = node.spec?.unschedulable || false

  // Check if node is ready first
  const readyCondition = conditions.find((c) => c.type === 'Ready')
  const isReady = readyCondition?.status === 'True'

  if (isUnschedulable) {
    if (isReady) {
      return 'Ready,SchedulingDisabled'
    } else {
      return 'NotReady,SchedulingDisabled'
    }
  }

  if (isReady) {
    return 'Ready'
  }

  const networkUnavailable = conditions.find(
    (c) => c.type === 'NetworkUnavailable'
  )
  if (networkUnavailable?.status === 'True') {
    return 'NetworkUnavailable'
  }

  const memoryPressure = conditions.find((c) => c.type === 'MemoryPressure')
  if (memoryPressure?.status === 'True') {
    return 'MemoryPressure'
  }

  const diskPressure = conditions.find((c) => c.type === 'DiskPressure')
  if (diskPressure?.status === 'True') {
    return 'DiskPressure'
  }

  const pidPressure = conditions.find((c) => c.type === 'PIDPressure')
  if (pidPressure?.status === 'True') {
    return 'PIDPressure'
  }

  return 'NotReady'
}

function getNodeRoles(node: NodeWithMetrics): string[] {
  const labels = node.metadata?.labels || {}
  const roles: string[] = []

  // Check for common node role labels
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

// Prefer Internal IP, then External IP, then fallback to hostname
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

const NODE_LABEL_DISPLAY_LIMIT = 6

function formatNodeTaint(taint: {
  key: string
  value?: string
  effect?: string
}): string {
  const value = taint.value ? `=${taint.value}` : ''
  return `${taint.key}${value}:${taint.effect ?? ''}`
}

// NodeLabelsAndTaints renders the node's taints and labels in a full-width
// details row. Labels beyond the display limit collapse behind "Show more".
function NodeLabelsAndTaints({ node }: { node: NodeWithMetrics }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)

  // System-managed keys (kubernetes.io/...) are created automatically and are
  // noise for operators, so they are hidden from this summary.
  const isSystemKey = (key: string) => key.includes('kubernetes.io')

  const taints = (node.spec?.taints ?? []).filter(
    (taint) => !isSystemKey(taint.key)
  )
  const labels = Object.entries(node.metadata?.labels ?? {})
    .filter(([key]) => !isSystemKey(key))
    .sort(([a], [b]) => a.localeCompare(b))

  if (taints.length === 0 && labels.length === 0) {
    return null
  }

  const visibleLabels = expanded
    ? labels
    : labels.slice(0, NODE_LABEL_DISPLAY_LIMIT)
  const hasHiddenLabels = labels.length > NODE_LABEL_DISPLAY_LIMIT

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {taints.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="shrink-0">
            {t('common.fields.taints', 'Taints')}:
          </span>
          {taints.map((taint) => (
            <Badge
              key={`${taint.key}-${taint.effect}`}
              variant="outline"
              className="font-normal"
            >
              {formatNodeTaint(taint)}
            </Badge>
          ))}
        </div>
      )}
      {labels.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="shrink-0">
            {t('common.fields.labels', 'Labels')}:
          </span>
          {visibleLabels.map(([key, value]) => (
            <Badge key={key} variant="outline" className="font-normal">
              {key}={value}
            </Badge>
          ))}
          {hasHiddenLabels && (
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() => setExpanded((prev) => !prev)}
            >
              {expanded
                ? t('common.actions.showLess', 'Show less')
                : t('common.actions.showMore', 'Show more')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

const nodeSearchFilter = createSearchFilter<NodeWithMetrics>(
  (n) => n.metadata?.name,
  (n) => n.status?.nodeInfo?.kubeletVersion,
  (n) => getNodeStatus(n),
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

  // Row-level drain opens the same options dialog as the toolbar action.
  const handleRowDrain = useCallback((node: NodeWithMetrics) => {
    setDrainTargets([node])
    setShowDrainDialog(true)
  }, [])

  // Define columns for the node table
  const columns = useMemo(
    () => [
      columnHelper.accessor('metadata.name', {
        header: t('common.fields.name'),
        cell: ({ row }) => (
          <div className="font-medium app-link">
            <Link to={`/nodes/${row.original.metadata!.name}`}>
              {row.original.metadata!.name}
            </Link>
          </div>
        ),
      }),
      columnHelper.accessor((row) => getNodeStatus(row), {
        id: 'status',
        header: t('common.fields.status'),
        cell: ({ row }) => {
          if (row.original.spec?.unschedulable) {
            return (
              <Badge variant="destructive" className="text-xs">
                {t('nodes.cordoned', 'Cordoned')}
              </Badge>
            )
          }
          const status = getNodeStatus(row.original)
          return (
            <Badge variant="outline" className="text-muted-foreground px-1.5">
              <NodeStatusIcon status={status} />
              {status}
            </Badge>
          )
        },
      }),
      columnHelper.accessor((row) => getNodeRoles(row).join(', '), {
        id: 'roles',
        header: 'Roles',
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
      columnHelper.accessor((row) => row.metrics?.pods || 0, {
        id: 'pods',
        header: 'Pods',
        cell: ({ row }) => (
          <Link
            to={`/nodes/${row.original.metadata!.name}?tab=pods`}
            className="text-muted-foreground hover:text-primary/80 hover:underline transition-colors cursor-pointer"
          >
            {row.original.metrics?.pods || 0} /{' '}
            {row.original.metrics?.podsLimit || 0}
          </Link>
        ),
      }),
      columnHelper.accessor((row) => row.metrics?.cpuUsage || 0, {
        id: 'cpu',
        header: 'CPU',
        cell: ({ row }) => (
          <MetricCell
            metrics={row.original.metrics}
            type="cpu"
            limitLabel="Allocatable"
            showPercentage={true}
            showRequest={false}
          />
        ),
      }),
      columnHelper.accessor((row) => row.metrics?.memoryUsage || 0, {
        id: 'memory',
        header: 'Memory',
        cell: ({ row }) => (
          <MetricCell
            metrics={row.original.metrics}
            type="memory"
            limitLabel="Allocatable"
            showPercentage={true}
            showRequest={false}
          />
        ),
      }),
      columnHelper.accessor((row) => getNodeIP(row), {
        id: 'ip',
        header: 'IP Address',
        cell: ({ getValue }) => {
          const ip = getValue()
          return (
            <span className="text-sm font-mono text-muted-foreground">
              {ip}
            </span>
          )
        },
      }),
      columnHelper.accessor('status.nodeInfo.kubeletVersion', {
        header: 'Version',
        cell: ({ getValue }) => {
          const version = getValue()
          return version ? (
            <span className="text-sm font-mono">{version}</span>
          ) : (
            <span className="text-muted-foreground">N/A</span>
          )
        },
      }),
      columnHelper.accessor('status.nodeInfo.kernelVersion', {
        header: 'Kernel Version',
        cell: ({ getValue }) => {
          const kernelVersion = getValue()
          return kernelVersion ? (
            <span className="text-sm">{kernelVersion}</span>
          ) : (
            <span className="text-muted-foreground">N/A</span>
          )
        },
      }),
      columnHelper.accessor('status.nodeInfo.osImage', {
        header: 'OS Image',
        cell: ({ getValue }) => {
          const osImage = getValue()
          return osImage ? (
            <span className="text-sm">{osImage}</span>
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
            <span className="text-muted-foreground text-sm">{dateStr}</span>
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
        renderRowDetails={(node) => <NodeLabelsAndTaints node={node} />}
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
