import { useMemo } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { Pod } from 'kubernetes-types/core/v1'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { PodWithMetrics } from '@/types/api'
import { getClusterScopedStorageKey } from '@/lib/current-cluster'
import {
  createSearchFilter,
  getPodStatus,
  resolveCreateNamespace,
} from '@/lib/k8s'
import { formatDate, getAge } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { MetricCell } from '@/components/metrics-cell'
import { NodeLink } from '@/components/node-link'
import { PodStatusIcon } from '@/components/pod-status-icon'
import { ResourceTable } from '@/components/resource-table'

const podSearchFilter = createSearchFilter<Pod>(
  (p) => p.metadata?.name,
  (p) => p.spec?.nodeName,
  (p) => p.status?.podIP
)

const columnHelper = createColumnHelper<PodWithMetrics>()

export function PodListPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { namespace: namespaceParam } = useParams()

  // Define columns for the pod table - moved outside render cycle for better performance
  const columns = useMemo(
    () => [
      columnHelper.accessor('metadata.name', {
        header: t('common.fields.name'),
        cell: ({ row }) => (
          <div className="font-medium app-link">
            <Link
              to={`/pods/${row.original.metadata!.namespace}/${
                row.original.metadata!.name
              }`}
            >
              {row.original.metadata!.name}
            </Link>
          </div>
        ),
      }),
      columnHelper.accessor((row) => getPodStatus(row).readyContainers, {
        id: 'containers',
        header: t('common.fields.ready'),
        cell: ({ row }) => {
          const status = getPodStatus(row.original)

          return (
            <div>
              {status.readyContainers} / {status.totalContainers}
            </div>
          )
        },
      }),
      columnHelper.accessor((row) => getPodStatus(row).reason, {
        header: t('common.fields.status'),
        enableColumnFilter: true,
        cell: ({ row }) => {
          const status = getPodStatus(row.original)
          return (
            <Badge variant="outline" className="text-muted-foreground px-1.5">
              <PodStatusIcon status={status.reason} />
              {status.reason}
            </Badge>
          )
        },
      }),
      columnHelper.accessor((row) => getPodStatus(row).restarts, {
        id: 'restarts',
        header: t('common.fields.restarts'),
        cell: ({ row }) => {
          const status = getPodStatus(row.original)
          return (
            <span className="text-muted-foreground text-sm">
              {status.restartString}
            </span>
          )
        },
      }),
      columnHelper.accessor((row) => row.metrics?.cpuUsage || 0, {
        id: 'cpu',
        header: 'CPU',
        cell: ({ row }) => (
          <MetricCell metrics={row.original.metrics} type="cpu" />
        ),
      }),
      columnHelper.accessor((row) => row.metrics?.memoryUsage || 0, {
        id: 'memory',
        header: 'Memory',
        cell: ({ row }) => (
          <MetricCell metrics={row.original.metrics} type="memory" />
        ),
      }),
      columnHelper.accessor((row) => row.status?.podIP, {
        id: 'podIP',
        header: 'IP',
        cell: ({ getValue }) => {
          const ip = getValue() || '-'
          return (
            <span className="text-muted-foreground text-sm font-mono">
              {ip}
            </span>
          )
        },
      }),
      columnHelper.accessor((row) => row.spec?.nodeName, {
        id: 'nodeName',
        header: t('common.fields.node'),
        enableColumnFilter: true,
        cell: ({ row }) => (
          <div className="font-medium">
            <NodeLink name={row.original.spec?.nodeName} />
          </div>
        ),
      }),
      columnHelper.accessor((row) => row.metadata?.creationTimestamp, {
        id: 'creationTimestamp',
        header: t('common.fields.created'),
        cell: ({ getValue }) => {
          const dateStr = formatDate(getValue() || '')
          return (
            <Tooltip>
              <TooltipTrigger>
                <span className="text-muted-foreground text-sm">
                  {getAge(getValue() || '')}
                </span>
              </TooltipTrigger>
              <TooltipContent>{dateStr}</TooltipContent>
            </Tooltip>
          )
        },
      }),
    ],
    [t]
  )

  const handleCreateClick = () => {
    // The URL wins, then the table's persisted selection; a multi or
    // "all namespaces" selection cannot host a new object.
    const ns = resolveCreateNamespace(
      namespaceParam,
      sessionStorage.getItem(getClusterScopedStorageKey('selectedNamespace')),
      localStorage.getItem(getClusterScopedStorageKey('selectedNamespace'))
    )
    navigate(`/pods/${encodeURIComponent(ns)}/create?tab=container-0`)
  }

  return (
    <>
      <ResourceTable<Pod>
        resourceName="Pods"
        columns={columns}
        clusterScope={false}
        searchQueryFilter={podSearchFilter}
        initialNamespace={namespaceParam}
        onNamespaceChange={(ns) => {
          navigate(
            ns && ns !== '_all' ? `/pods/${encodeURIComponent(ns)}` : '/pods',
            { replace: true }
          )
        }}
        showCreateButton={true}
        onCreateClick={handleCreateClick}
      />
    </>
  )
}
