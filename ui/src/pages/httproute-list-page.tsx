import { useMemo } from 'react'
import { createColumnHelper } from '@tanstack/react-table'

import { HTTPRoute } from '@/types/gateway'
import { createSearchFilter } from '@/lib/k8s'
import { formatDate } from '@/lib/utils'
import { ClusterLink } from '@/components/cluster-link'
import { ResourceTable } from '@/components/resource-table'

const filter = createSearchFilter<HTTPRoute>((hr) => hr.metadata?.name)

const columnHelper = createColumnHelper<HTTPRoute>()

export function HTTPRouteListPage() {
  const columns = useMemo(
    () => [
      columnHelper.accessor('metadata.name', {
        header: 'Name',
        cell: ({ row }) => (
          <div className="font-medium app-link">
            <ClusterLink
              to={`/httproutes/${row.original.metadata!.namespace}/${row.original.metadata!.name}`}
            >
              {row.original.metadata!.name}
            </ClusterLink>
          </div>
        ),
      }),
      columnHelper.accessor((row) => row.spec?.hostnames?.join(', ') || '', {
        id: 'spec_hostnames',
        header: 'Hostnames',
        cell: ({ getValue }) => getValue() || 'N/A',
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
      resourceName="HTTPRoutes"
      columns={columns}
      searchQueryFilter={filter}
    />
  )
}
