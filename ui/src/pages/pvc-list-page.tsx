import { useMemo } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { PersistentVolumeClaim } from 'kubernetes-types/core/v1'
import { useTranslation } from 'react-i18next'

import { createSearchFilter } from '@/lib/k8s'
import { neutralBadge, statusBadge } from '@/lib/status-badge'
import { formatDate, parseBytes } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { ClusterLink } from '@/components/cluster-link'
import { ResourceTable } from '@/components/resource-table'

const pvcSearchFilter = createSearchFilter<PersistentVolumeClaim>(
  (pvc) => pvc.metadata?.name,
  (pvc) => pvc.metadata?.namespace,
  (pvc) => pvc.spec?.volumeName,
  (pvc) => pvc.spec?.storageClassName,
  (pvc) => pvc.status?.phase
)

const columnHelper = createColumnHelper<PersistentVolumeClaim>()

export function PVCListPage() {
  const { t } = useTranslation()

  // 定义 PVC 表格的列
  const columns = useMemo(
    () => [
      columnHelper.accessor('metadata.name', {
        header: t('common.fields.name'),
        cell: ({ row }) => (
          <div className="font-medium app-link">
            <ClusterLink
              to={`/persistentvolumeclaims/${row.original.metadata!.namespace}/${
                row.original.metadata!.name
              }`}
            >
              {row.original.metadata!.name}
            </ClusterLink>
          </div>
        ),
      }),
      columnHelper.accessor('status.phase', {
        header: t('common.fields.status'),
        cell: ({ getValue }) => {
          const phase = getValue() || 'Unknown'
          let badge = neutralBadge()

          switch (phase) {
            case 'Bound':
              badge = statusBadge('success')
              break
            case 'Lost':
              badge = statusBadge('failure')
              break
            case 'Pending':
              badge = neutralBadge()
              break
          }

          return (
            <Badge variant={badge.variant} className={badge.className}>
              {phase}
            </Badge>
          )
        },
      }),
      columnHelper.accessor('spec.volumeName', {
        header: t('common.fields.volume'),
        cell: ({ getValue }) => {
          const volumeName = getValue()
          if (volumeName) {
            return (
              <div className="font-medium app-link">
                <ClusterLink to={`/persistentvolumes/${volumeName}`}>
                  {volumeName}
                </ClusterLink>
              </div>
            )
          }
          return '-'
        },
      }),
      columnHelper.accessor('spec.storageClassName', {
        header: t('common.fields.storageClass'),
        enableColumnFilter: true,
        cell: ({ getValue }) => {
          const scName = getValue()
          if (scName) {
            return (
              <div className="font-medium app-link">
                <ClusterLink to={`/storageclasses/${scName}`}>
                  {scName}
                </ClusterLink>
              </div>
            )
          }
          return '-'
        },
      }),
      columnHelper.accessor(
        (row) => parseBytes(row.spec?.resources?.requests?.storage || '0'),
        {
          header: t('common.fields.capacity'),
          cell: ({ row }) =>
            row.original.spec?.resources?.requests?.storage || '-',
        }
      ),
      columnHelper.accessor((row) => row.spec?.accessModes?.join(', ') || '', {
        id: 'spec_accessModes',
        header: t('common.fields.accessModes'),
        cell: ({ getValue }) => getValue() || '-',
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
      resourceName={'PersistentVolumeClaims'}
      columns={columns}
      searchQueryFilter={pvcSearchFilter}
    />
  )
}
