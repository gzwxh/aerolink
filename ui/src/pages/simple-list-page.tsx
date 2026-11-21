import { useCallback, useMemo } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { useTranslation } from 'react-i18next'

import { ResourceType, ResourceTypeMap } from '@/types/api'
import { formatDate } from '@/lib/utils'
import { ClusterLink } from '@/components/cluster-link'
import { ResourceTable } from '@/components/resource-table'

import {
  getResourceDefinition,
  getResourceLabel,
  getResourceScope,
} from './resource-definitions'

export interface ResourceTableProps {
  resourceType?: ResourceType
}

export function SimpleListPage<T extends keyof ResourceTypeMap>({
  resourceType,
}: ResourceTableProps) {
  const { t } = useTranslation()
  const columnHelper = useMemo(
    () => createColumnHelper<ResourceTypeMap[T]>(),
    []
  )
  const resourceDefinition = resourceType
    ? getResourceDefinition(resourceType)
    : undefined
  const resourceName = resourceType
    ? resourceDefinition?.titleKey
      ? t(resourceDefinition.titleKey, {
          defaultValue: getResourceLabel(resourceType, true),
        })
      : getResourceLabel(resourceType, true)
    : ''
  const isClusterScope = resourceType
    ? getResourceScope(resourceType) === 'cluster'
    : false

  const columns = useMemo(
    () => [
      columnHelper.accessor((row) => row.metadata?.name, {
        header: t('common.fields.name'),
        cell: ({ row }) => (
          <div className="font-medium app-link">
            <ClusterLink
              to={`/${resourceType}${isClusterScope ? '' : `/${row.original.metadata!.namespace}`}/${row.original.metadata!.name}`}
            >
              {row.original.metadata!.name}
            </ClusterLink>
          </div>
        ),
      }),
      columnHelper.accessor((row) => row.metadata?.creationTimestamp, {
        header: t('common.fields.created'),
        cell: ({ getValue }) => {
          const dateStr = formatDate(getValue() || '')

          return (
            <span className="text-muted-foreground text-sm">{dateStr}</span>
          )
        },
      }),
    ],
    [columnHelper, isClusterScope, resourceType, t]
  )

  const filter = useCallback((resource: ResourceTypeMap[T], query: string) => {
    return resource.metadata!.name!.toLowerCase().includes(query)
  }, [])

  if (!resourceType) {
    return (
      <div>
        {t('common.resourceTypeNotFound', '未知的资源类型：{{type}}', {
          type: resourceType,
        })}
      </div>
    )
  }

  return (
    <ResourceTable
      resourceName={resourceName}
      resourceType={resourceType}
      columns={columns}
      clusterScope={isClusterScope}
      searchQueryFilter={filter}
    />
  )
}
