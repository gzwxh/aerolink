import { useMemo } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { useTranslation } from 'react-i18next'

import { HTTPRoute } from '@/types/gateway'
import { createSearchFilter } from '@/lib/k8s'
import { formatDate } from '@/lib/utils'
import { ClusterLink } from '@/components/cluster-link'
import { ResourceTable } from '@/components/resource-table'

const filter = createSearchFilter<HTTPRoute>((hr) => hr.metadata?.name)

const columnHelper = createColumnHelper<HTTPRoute>()

export function HTTPRouteListPage() {
  const { t } = useTranslation()
  const columns = useMemo(
    () => [
      columnHelper.accessor('metadata.name', {
        header: t('common.fields.name'),
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
        header: t('common.fields.hostname'),
        cell: ({ getValue }) => getValue() || 'N/A',
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
    ],
    [t]
  )

  return (
    <ResourceTable
      resourceName="HTTPRoutes"
      columns={columns}
      searchQueryFilter={filter}
    />
  )
}
