import { useMemo } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { ConfigMap } from 'kubernetes-types/core/v1'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { getClusterScopedStorageKey } from '@/lib/current-cluster'
import { createSearchFilter, resolveCreateNamespace } from '@/lib/k8s'
import { formatDate } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ResourceTable } from '@/components/resource-table'

const configMapSearchFilter = createSearchFilter<ConfigMap>(
  (cm) => cm.metadata?.name,
  (cm) => cm.metadata?.namespace,
  (cm) => Object.keys(cm.data || {}),
  (cm) => Object.keys(cm.binaryData || {})
)

const columnHelper = createColumnHelper<ConfigMap>()

export function ConfigMapListPage() {
  const navigate = useNavigate()
  const { namespace: namespaceParam } = useParams()
  const { t } = useTranslation()

  // 新 ConfigMap 创建在当前查看的命名空间中：URL
  // 优先，其次是命名空间选择器持久化的选择。
  const handleCreateClick = () => {
    const ns = resolveCreateNamespace(
      namespaceParam,
      sessionStorage.getItem(getClusterScopedStorageKey('selectedNamespace')),
      localStorage.getItem(getClusterScopedStorageKey('selectedNamespace'))
    )
    navigate(`/configmaps/${encodeURIComponent(ns)}/create`)
  }

  // 定义 ConfigMap 表格的列
  const columns = useMemo(
    () => [
      columnHelper.accessor('metadata.name', {
        header: t('common.fields.name', 'Name'),
        cell: ({ row }) => (
          <div className="font-medium app-link">
            <Link
              to={`/configmaps/${row.original.metadata!.namespace}/${
                row.original.metadata!.name
              }`}
            >
              {row.original.metadata!.name}
            </Link>
          </div>
        ),
      }),
      columnHelper.accessor((row) => Object.keys(row.data || {}).join(', '), {
        id: 'data',
        header: t('common.fields.keys', 'Data Keys'),
        cell: ({ row }) => {
          const data = row.original.data || {}
          const keys = Object.keys(data)
          if (keys.length === 0) {
            return '-'
          }
          const keyList = keys.join(', ')
          return (
            <Tooltip>
              <TooltipTrigger>
                <span className="line-clamp-2 max-w-64 break-all text-left text-muted-foreground">
                  {keyList}
                </span>
              </TooltipTrigger>
              <TooltipContent>
                <p className="max-w-sm break-all">{keyList}</p>
              </TooltipContent>
            </Tooltip>
          )
        },
      }),
      columnHelper.accessor('metadata.creationTimestamp', {
        header: t('common.fields.created', 'Created'),
        cell: ({ getValue }) => {
          const dateStr = formatDate(getValue() || '')

          return (
            <span className="text-muted-foreground text-sm">{dateStr}</span>
          )
        },
      }),
    ],
    [t]
  )

  // 创建与批量删除由 ResourceTable 本身做门控。
  return (
    <ResourceTable
      resourceName="ConfigMaps"
      columns={columns}
      searchQueryFilter={configMapSearchFilter}
      showCreateButton
      onCreateClick={handleCreateClick}
    />
  )
}
