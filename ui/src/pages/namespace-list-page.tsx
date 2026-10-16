import { useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { Namespace } from 'kubernetes-types/core/v1'
import { useTranslation } from 'react-i18next'

import { createSearchFilter } from '@/lib/k8s'
import { getAge } from '@/lib/utils'
import { useNamespaceBindingMap } from '@/hooks/use-namespace-binding-map'
import { ClusterLink } from '@/components/cluster-link'
import { CreateNamespaceDialog } from '@/components/create-namespace-dialog'
import { NamespaceRowActions } from '@/components/namespace-row-actions'
import { ResourceTable } from '@/components/resource-table'

const filter = createSearchFilter<Namespace>((ns) => ns.metadata?.name)

const columnHelper = createColumnHelper<Namespace>()

export function NamespaceListPage() {
  const { t } = useTranslation()
  const [showCreate, setShowCreate] = useState(false)
  // 命名空间 → 权限绑定组名（当前用户可见的组）
  const bindingMap = useNamespaceBindingMap()

  // 按权限绑定名分组展示（参照云平台的「项目」分组）：绑定列仅作分组依据，
  // 默认隐藏；未绑定任何组的命名空间（如系统命名空间）归入「未绑定」组。
  const grouping = useMemo(
    () => ({
      columnId: 'bindingGroup',
      renderGroupHeader: (value: string) => (
        <span className="font-medium">
          {value
            ? `${t('common.fields.project')}：${value}`
            : t('resourceTable.unboundGroup', '未绑定')}
        </span>
      ),
    }),
    [t]
  )

  const columns = useMemo(
    () => [
      columnHelper.accessor('metadata.name', {
        header: t('common.fields.name'),
        cell: ({ row }) => (
          <div className="font-medium app-link">
            <ClusterLink to={`/namespaces/${row.original.metadata!.name}`}>
              {row.original.metadata!.name}
            </ClusterLink>
          </div>
        ),
      }),
      columnHelper.accessor(
        (row) => bindingMap.get(row.metadata?.name ?? '') ?? '',
        {
          id: 'bindingGroup',
          header: t('common.fields.project', '项目'),
          cell: ({ getValue }) =>
            getValue() ? (
              <span className="text-muted-foreground">{getValue()}</span>
            ) : (
              <span className="text-muted-foreground">—</span>
            ),
        }
      ),
      columnHelper.accessor('status.phase', {
        header: t('common.fields.status'),
        cell: ({ row }) => row.original.status!.phase || 'Unknown',
      }),
      columnHelper.accessor('metadata.creationTimestamp', {
        header: t('common.fields.created'),
        cell: ({ getValue }) => {
          return getAge(getValue() as string)
        },
      }),
      columnHelper.display({
        id: 'actions',
        header: t('common.fields.actions', 'Actions'),
        cell: ({ row }) => (
          <NamespaceRowActions
            name={row.original.metadata?.name ?? ''}
            resource={row.original}
          />
        ),
      }),
    ],
    [t, bindingMap]
  )

  return (
    <>
      <ResourceTable
        resourceName="Namespaces"
        columns={columns}
        clusterScope={true}
        searchQueryFilter={filter}
        showCreateButton={true}
        onCreateClick={() => setShowCreate(true)}
        defaultHiddenColumns={['bindingGroup']}
        grouping={grouping}
        // 默认按「项目」分组列降序排组（未绑定/空值排最后），与分组展示一致。
        initialSorting={[{ id: 'bindingGroup', desc: true }]}
      />
      {showCreate && (
        <CreateNamespaceDialog onClose={() => setShowCreate(false)} />
      )}
    </>
  )
}
