import { useMemo } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { Secret } from 'kubernetes-types/core/v1'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { getClusterScopedStorageKey } from '@/lib/current-cluster'
import { createSearchFilter, resolveCreateNamespace } from '@/lib/k8s'
import { formatDate } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { ResourceTable } from '@/components/resource-table'

const secretSearchFilter = createSearchFilter<Secret>(
  (s) => s.metadata?.name,
  (s) => s.metadata?.namespace,
  (s) => s.type,
  (s) => Object.keys(s.data || {})
)

const columnHelper = createColumnHelper<Secret>()

export function SecretListPage() {
  const navigate = useNavigate()
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
        header: 'Name',
        cell: ({ row }) => (
          <div className="font-medium app-link">
            <Link
              to={`/secrets/${row.original.metadata!.namespace}/${
                row.original.metadata!.name
              }`}
            >
              {row.original.metadata!.name}
            </Link>
          </div>
        ),
      }),
      columnHelper.accessor((row) => row.type || 'Opaque', {
        id: 'type',
        header: 'Type',
        cell: ({ getValue }) => {
          const type = getValue() || 'Opaque'
          return <Badge variant="outline">{type}</Badge>
        },
      }),
      columnHelper.accessor((row) => Object.keys(row.data || {}).join(', '), {
        id: 'data',
        header: 'Data Keys',
        cell: ({ row }) => {
          const data = row.original.data || {}
          const keys = Object.keys(data)
          if (keys.length === 0) {
            return '-'
          }
          // 展示时只取前 5 个 key
          return keys.length > 5 ? (
            <span className="text-muted-foreground">
              {keys.slice(0, 5).join(', ')}...
            </span>
          ) : (
            <span className="text-muted-foreground">{keys.join(', ')}</span>
          )
        },
      }),
      columnHelper.accessor('metadata.creationTimestamp', {
        header: 'Created',
        cell: ({ getValue }) => {
          const dateStr = formatDate(getValue() || '')

          return (
            <span className="text-muted-foreground text-sm">{dateStr}</span>
          )
        },
      }),
    ],
    []
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
