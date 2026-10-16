import { useMemo } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { ConfigMap } from 'kubernetes-types/core/v1'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router-dom'

import { useClusterNavigate } from '@/lib/cluster-path'
import { getClusterScopedStorageKey } from '@/lib/current-cluster'
import { createSearchFilter, resolveCreateNamespace } from '@/lib/k8s'
import { formatDate } from '@/lib/utils'
import { ClusterLink } from '@/components/cluster-link'
import { DataKeysCell } from '@/components/data-keys-cell'
import { ResourceRowActions } from '@/components/resource-row-actions'
import { ResourceTable } from '@/components/resource-table'

const configMapSearchFilter = createSearchFilter<ConfigMap>(
  (cm) => cm.metadata?.name,
  (cm) => cm.metadata?.namespace,
  (cm) => Object.keys(cm.data || {}),
  (cm) => Object.keys(cm.binaryData || {})
)

const columnHelper = createColumnHelper<ConfigMap>()

export function ConfigMapListPage() {
  const navigate = useClusterNavigate()
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
            <ClusterLink
              to={`/configmaps/${row.original.metadata!.namespace}/${
                row.original.metadata!.name
              }`}
            >
              {row.original.metadata!.name}
            </ClusterLink>
          </div>
        ),
      }),
      columnHelper.accessor((row) => Object.keys(row.data || {}).join(', '), {
        id: 'data',
        header: t('common.fields.keys', 'Data Keys'),
        // 键的数量与长度都不受控：只显示一行，其余交给 tooltip。
        cell: ({ row }) => (
          <DataKeysCell keys={Object.keys(row.original.data || {})} />
        ),
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
      columnHelper.display({
        id: 'actions',
        header: () => (
          <div className="text-right">{t('common.fields.actions')}</div>
        ),
        cell: ({ row }) => (
          <div className="flex justify-end">
            <ResourceRowActions
              resourceType="configmaps"
              resource={row.original}
            />
          </div>
        ),
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
