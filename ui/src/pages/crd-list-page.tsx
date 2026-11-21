import { useMemo } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { CustomResourceDefinition } from 'kubernetes-types/apiextensions/v1'
import { useTranslation } from 'react-i18next'

import { createSearchFilter } from '@/lib/k8s'
import { getAge } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { ClusterLink } from '@/components/cluster-link'
import { ResourceTable } from '@/components/resource-table'

const searchQueryFilter = createSearchFilter<CustomResourceDefinition>(
  (crd) => crd.metadata?.name,
  (crd) => crd.spec?.group,
  (crd) => crd.spec?.scope,
  (crd) => crd.spec?.versions?.map((v: { name: string }) => v.name)
)

const columnHelper = createColumnHelper<CustomResourceDefinition>()

export function CRDListPage() {
  const { t } = useTranslation()
  // 定义 CRD 表格的列
  const columns = useMemo(
    () => [
      columnHelper.accessor('metadata.name', {
        header: t('common.fields.name'),
        cell: ({ row }) => (
          <div className="font-medium app-link">
            <ClusterLink to={`/crds/${row.original.metadata!.name}`}>
              {row.original.metadata!.name}
            </ClusterLink>
          </div>
        ),
      }),
      columnHelper.accessor('spec.group', {
        header: t('common.fields.apiGroup'),
        enableColumnFilter: true,
        cell: ({ getValue }) => (
          <span
            className="block truncate text-sm font-mono"
            title={String(getValue() ?? '')}
          >
            {getValue()}
          </span>
        ),
      }),
      columnHelper.accessor(
        (row) => row.spec?.versions?.map((version) => version.name).join(', '),
        {
          id: 'spec_versions',
          header: t('common.fields.versions'),
          cell: ({ row }) => {
            const versions = row.original.spec?.versions || []
            return (
              <div className="flex flex-wrap gap-1">
                {versions.map(
                  (
                    version: {
                      name: string
                      served?: boolean
                      storage?: boolean
                    },
                    index: number
                  ) => (
                    <Badge
                      key={index}
                      variant={version.served ? 'default' : 'secondary'}
                      className="text-xs font-mono"
                    >
                      {version.name}
                    </Badge>
                  )
                )}
              </div>
            )
          },
        }
      ),
      columnHelper.accessor('spec.scope', {
        header: t('common.fields.scope'),
        cell: ({ getValue }) => (
          <Badge
            variant={getValue() === 'Namespaced' ? 'default' : 'outline'}
            className="text-xs"
          >
            {getValue()}
          </Badge>
        ),
      }),
      columnHelper.accessor(
        (row) => {
          const establishedCondition = row.status?.conditions?.find(
            (condition) => condition.type === 'Established'
          )
          return establishedCondition?.status === 'True'
            ? 'Established'
            : 'Not Ready'
        },
        {
          id: 'status_conditions',
          header: t('common.fields.status'),
          cell: ({ getValue }) => {
            const status = getValue()
            const isEstablished = status === 'Established'

            return (
              <Badge
                variant={isEstablished ? 'default' : 'destructive'}
                className="text-xs"
              >
                {status}
              </Badge>
            )
          },
        }
      ),
      columnHelper.accessor('metadata.creationTimestamp', {
        header: t('common.fields.age'),
        cell: ({ getValue }) => {
          return getAge(getValue() as string)
        },
      }),
    ],
    [t]
  )

  return (
    <ResourceTable
      resourceName="Custom Resource Definitions"
      resourceType="crds"
      columns={columns}
      clusterScope={true} // CRDs are cluster-scoped
      searchQueryFilter={searchQueryFilter}
    />
  )
}
