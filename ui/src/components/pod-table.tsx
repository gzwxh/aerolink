import { useMemo } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { Pod } from 'kubernetes-types/core/v1'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { PodWithMetrics } from '@/types/api'
import { createSearchFilter, getPodStatus } from '@/lib/k8s'
import { formatDate, getAge } from '@/lib/utils'

import { MetricCell } from './metrics-cell'
import { NodeLink } from './node-link'
import { PodStatusIcon } from './pod-status-icon'
import { ResourceRowActions } from './resource-row-actions'
import { ResourceTable } from './resource-table'
import { Badge } from './ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

const podSearchFilter = createSearchFilter<Pod>(
  (p) => p.metadata?.name,
  (p) => p.spec?.nodeName,
  (p) => p.status?.podIP
)

const columnHelper = createColumnHelper<PodWithMetrics>()

/**
 * 详情页（Deployment / StatefulSet / DaemonSet / Job / Node）里内嵌的
 * Pod 表格。数据由调用方按 labelSelector 监听后传入（外部数据模式），
 * 交互能力与 Pod 列表页一致：排序、搜索、全选、批量删除，行内操作
 * 与批量按钮都按 RBAC 权限显隐。
 */
export function PodTable(props: {
  pods?: PodWithMetrics[]
  labelSelector?: string
  isLoading?: boolean
  hiddenNode?: boolean
}) {
  const { t } = useTranslation()
  const { pods, isLoading, hiddenNode } = props

  const columns = useMemo(
    () => [
      columnHelper.accessor('metadata.name', {
        header: t('common.fields.name'),
        cell: ({ row }) => (
          <div className="font-medium app-link">
            {/* Pod 名很长（aero-link-6b5c5fb7f7-hug 这种），列宽固定时截断显示，
                悬浮看全名，否则会压到右侧的列上。 */}
            <Link
              to={`/pods/${row.original.metadata!.namespace}/${
                row.original.metadata!.name
              }`}
              className="block truncate"
              title={row.original.metadata!.name}
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
        // 指标列要放下「用量 / 上限 + 百分比」两行，比默认列宽宽一些。
        size: 180,
        cell: ({ row }) => (
          <MetricCell metrics={row.original.metrics} type="cpu" />
        ),
      }),
      columnHelper.accessor((row) => row.metrics?.memoryUsage || 0, {
        id: 'memory',
        header: 'Memory',
        // 内存文本最长（4.69 GiB / 8 GiB），再宽一点，免得和百分比挤在一起。
        size: 200,
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
            <span
              className="block truncate font-mono text-sm text-muted-foreground"
              title={ip}
            >
              {ip}
            </span>
          )
        },
      }),
      ...(hiddenNode
        ? []
        : [
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
          ]),
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
      columnHelper.display({
        id: 'actions',
        header: () => (
          <div className="text-right">{t('common.fields.actions')}</div>
        ),
        cell: ({ row }) => (
          <div className="flex justify-end">
            <ResourceRowActions resourceType="pods" resource={row.original} />
          </div>
        ),
      }),
    ],
    [hiddenNode, t]
  )

  return (
    <ResourceTable<Pod>
      resourceName="Pods"
      resourceType="pods"
      columns={columns}
      // 命名空间由所属对象决定，选择器没有意义；批量删除按行上的
      // metadata.namespace 定位，不受影响。
      clusterScope={true}
      permissionResource="pods"
      data={pods}
      isLoading={isLoading}
      searchQueryFilter={podSearchFilter}
    />
  )
}
