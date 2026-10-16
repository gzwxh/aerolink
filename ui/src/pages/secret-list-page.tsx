import { useMemo } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { Secret } from 'kubernetes-types/core/v1'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router-dom'

import { useClusterNavigate } from '@/lib/cluster-path'
import { getClusterScopedStorageKey } from '@/lib/current-cluster'
import { createSearchFilter, resolveCreateNamespace } from '@/lib/k8s'
import { formatDate } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { ClusterLink } from '@/components/cluster-link'
import { DataKeysCell } from '@/components/data-keys-cell'
import { ResourceRowActions } from '@/components/resource-row-actions'
import { ResourceTable } from '@/components/resource-table'

const secretSearchFilter = createSearchFilter<Secret>(
  (s) => s.metadata?.name,
  (s) => s.metadata?.namespace,
  (s) => s.type,
  (s) => Object.keys(s.data || {})
)

const columnHelper = createColumnHelper<Secret>()

export function SecretListPage() {
  const { t } = useTranslation()
  const navigate = useClusterNavigate()
  const { namespace: namespaceParam } = useParams()

  // 新 Secret 创建在当前查看的命名空间中：URL 优先，
  // 其次是命名空间选择器持久化的选择。
  const handleCreateClick = () => {
    const ns = resolveCreateNamespace(
      namespaceParam,
      sessionStorage.getItem(getClusterScopedStorageKey('selectedNamespace')),
      localStorage.getItem(getClusterScopedStorageKey('selectedNamespace'))
    )
    navigate(`/secrets/${encodeURIComponent(ns)}/create`)
  }

  // 定义 Secret 表格的列
  const columns = useMemo(
    () => [
      columnHelper.accessor('metadata.name', {
        header: t('common.fields.name'),
        cell: ({ row }) => (
          <div className="font-medium app-link">
            <ClusterLink
              to={`/secrets/${row.original.metadata!.namespace}/${
                row.original.metadata!.name
              }`}
            >
              {row.original.metadata!.name}
            </ClusterLink>
          </div>
        ),
      }),
      columnHelper.accessor((row) => row.type || 'Opaque', {
        id: 'type',
        header: t('common.fields.type'),
        cell: ({ getValue }) => {
          const type = getValue() || 'Opaque'
          return <Badge variant="outline">{type}</Badge>
        },
      }),
      columnHelper.accessor((row) => Object.keys(row.data || {}).join(', '), {
        id: 'data',
        header: t('common.fields.keys'),
        // 键的数量与长度都不受控：只显示一行，其余交给 tooltip。
        cell: ({ row }) => (
          <DataKeysCell keys={Object.keys(row.original.data || {})} />
        ),
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
        header: () => (
          <div className="text-right">{t('common.fields.actions')}</div>
        ),
        cell: ({ row }) => (
          <div className="flex justify-end">
            <ResourceRowActions
              resourceType="secrets"
              resource={row.original}
            />
          </div>
        ),
      }),
    ],
    [t]
  )

  return (
    <ResourceTable
      resourceName="Secrets"
      columns={columns}
      clusterScope={false} // Secrets are namespace-scoped
      searchQueryFilter={secretSearchFilter}
      showCreateButton
      onCreateClick={handleCreateClick}
    />
  )
}
