import { useMemo } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { Service } from 'kubernetes-types/core/v1'
import { useTranslation } from 'react-i18next'
import { useParams, useSearchParams } from 'react-router-dom'

import { useClusterNavigate } from '@/lib/cluster-path'
import { getClusterScopedStorageKey } from '@/lib/current-cluster'
import {
  createSearchFilter,
  getServiceExternalIP,
  getServicePortSearchValues,
  resolveCreateNamespace,
} from '@/lib/k8s'
import { formatDate } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { ClusterLink } from '@/components/cluster-link'
import { ResourceRowActions } from '@/components/resource-row-actions'
import { ResourceTable } from '@/components/resource-table'

const serviceSearchFilter = createSearchFilter<Service>(
  (s) => s.metadata?.name,
  (s) => s.spec?.type,
  (s) => s.spec?.clusterIP,
  (s) => getServicePortSearchValues(s)
)

const columnHelper = createColumnHelper<Service>()

export function ServiceListPage() {
  const navigate = useClusterNavigate()
  const { namespace: namespaceParam } = useParams()
  // 从工作负载页点 Service 名称跳过来时带 `?search=<name>`：只显示那一个。
  const [searchParams] = useSearchParams()
  const initialSearch = searchParams.get('search') ?? undefined

  const handleCreateClick = () => {
    // URL 优先，其次是表格持久化的选择；多选或
    // "所有命名空间"的选择无法承载新对象。
    const ns = resolveCreateNamespace(
      namespaceParam,
      sessionStorage.getItem(getClusterScopedStorageKey('selectedNamespace')),
      localStorage.getItem(getClusterScopedStorageKey('selectedNamespace'))
    )
    navigate(`/services/${encodeURIComponent(ns)}/create`)
  }
  const { t } = useTranslation()

  // 定义 Service 表格的列
  const columns = useMemo(
    () => [
      columnHelper.accessor('metadata.name', {
        header: t('common.fields.name'),
        cell: ({ row }) => (
          <div className="font-medium app-link">
            <ClusterLink
              to={`/services/${row.original.metadata!.namespace}/${
                row.original.metadata!.name
              }`}
            >
              {row.original.metadata!.name}
            </ClusterLink>
          </div>
        ),
      }),
      columnHelper.accessor((row) => row.spec?.type || 'ClusterIP', {
        id: 'spec_type',
        header: t('common.fields.type'),
        enableColumnFilter: true,
        cell: ({ getValue }) => {
          const type = getValue() || 'ClusterIP'
          return <Badge variant="outline">{type}</Badge>
        },
      }),
      columnHelper.accessor('spec.clusterIP', {
        header: t('common.fields.clusterIP'),
        cell: ({ getValue }) => {
          const val = getValue() || '-'
          return (
            <span
              className="block truncate font-mono text-sm text-muted-foreground"
              title={val}
            >
              {val}
            </span>
          )
        },
      }),
      columnHelper.accessor((row) => getServiceExternalIP(row), {
        id: 'status_loadBalancer_ingress',
        header: t('common.fields.externalIP'),
        cell: ({ getValue }) => {
          const val = getValue()
          return (
            <span
              className="block truncate font-mono text-sm text-muted-foreground"
              title={String(val ?? '')}
            >
              {val}
            </span>
          )
        },
      }),
      columnHelper.accessor(
        (row) => getServicePortSearchValues(row).join(', '),
        {
          id: 'spec_ports',
          header: t('common.fields.ports'),
          cell: ({ row }) => {
            const ports = row.original.spec?.ports || []
            if (ports.length === 0) return '-'
            const text = ports
              .map((port) => {
                const protocol = port.protocol || 'TCP'
                if (port.nodePort) {
                  return `${port.port}:${port.nodePort}/${protocol}`
                }
                return `${port.port}/${protocol}`
              })
              .join(', ')
            return (
              <span
                className="block truncate font-mono text-sm text-muted-foreground"
                title={text}
              >
                {text}
              </span>
            )
          },
        }
      ),
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
              resourceType="services"
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
      resourceName="Services"
      columns={columns}
      clusterScope={false} // Services are namespace-scoped
      searchQueryFilter={serviceSearchFilter}
      showCreateButton={true}
      onCreateClick={handleCreateClick}
      initialNamespace={namespaceParam}
      initialSearch={initialSearch}
      onNamespaceChange={(ns) => {
        navigate(
          ns && ns !== '_all'
            ? `/services/${encodeURIComponent(ns)}`
            : '/services',
          { replace: true }
        )
      }}
    />
  )
}
