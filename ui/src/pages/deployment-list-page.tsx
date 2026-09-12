import { useMemo, useState } from 'react'
import { IconReload } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { createColumnHelper } from '@tanstack/react-table'
import { Deployment } from 'kubernetes-types/apps/v1'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { restartWorkload, useResources } from '@/lib/api'
import { getClusterScopedStorageKey } from '@/lib/current-cluster'
import {
  createSearchFilter,
  getDeploymentStatus,
  resolveCreateNamespace,
} from '@/lib/k8s'
import { formatDate } from '@/lib/utils'
import { useCanAnyNamespace } from '@/hooks/use-can'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DeploymentStatusIcon } from '@/components/deployment-status-icon'
import { ResourceBatchActionDialog } from '@/components/resource-batch-action-dialog'
import {
  ResourceTable,
  type ResourceTableBatchAction,
} from '@/components/resource-table'

const deploymentSearchFilter = createSearchFilter<Deployment>(
  (d) => d.metadata?.name,
  (d) => d.metadata?.namespace
)

const columnHelper = createColumnHelper<Deployment>()

export function DeploymentListPage() {
  const { namespace: namespaceParam } = useParams()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [isRestartDialogOpen, setIsRestartDialogOpen] = useState(false)
  const [batchDeployments, setBatchDeployments] = useState<Deployment[]>([])

  // Restarting patches the pod template, so it needs update permission.
  const canUpdate = useCanAnyNamespace()('deployments', 'update')
  const batchActions = useMemo<ResourceTableBatchAction<Deployment>[]>(
    () => [
      {
        id: 'restart',
        label: t('common.actions.restart'),
        icon: <IconReload className="size-4" />,
        hidden: !canUpdate,
        onSelect: (deployments) => {
          setBatchDeployments(deployments)
          setIsRestartDialogOpen(true)
        },
      },
    ],
    [t, canUpdate]
  )

  // Define columns for the deployment table
  const columns = useMemo(
    () => [
      columnHelper.accessor('metadata.name', {
        header: t('common.fields.name'),
        cell: ({ row }) => (
          <div className="font-medium app-link">
            <Link
              to={`/deployments/${row.original.metadata!.namespace}/${
                row.original.metadata!.name
              }`}
            >
              {row.original.metadata!.name}
            </Link>
          </div>
        ),
      }),
      columnHelper.accessor((row) => row.status?.readyReplicas ?? 0, {
        id: 'ready',
        header: t('common.fields.ready'),
        cell: ({ row }) => {
          const status = row.original.status
          const ready = status?.readyReplicas || 0
          const desired = status?.replicas || 0
          return (
            <div>
              {ready} / {desired}
            </div>
          )
        },
      }),
      columnHelper.accessor((row) => getDeploymentStatus(row), {
        id: 'status_conditions',
        header: t('common.fields.status'),
        cell: ({ getValue }) => {
          const status = getValue()
          return (
            <Badge variant="outline" className="text-muted-foreground px-1.5">
              <DeploymentStatusIcon status={status} />
              {status}
            </Badge>
          )
        },
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

  // Does the namespace from the URL exist in the current cluster? When the
  // user switches clusters, the namespace in the URL may no longer exist.
  const { data: allNamespaces } = useResources('namespaces', undefined, {
    staleTime: 60_000,
  })
  const namespaceExists = useMemo(() => {
    if (!namespaceParam) return true
    if (!allNamespaces) return true // still loading: assume it exists
    return allNamespaces.some((ns) => ns.metadata?.name === namespaceParam)
  }, [allNamespaces, namespaceParam])

  if (namespaceParam && !namespaceExists) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6">
        <div className="flex max-w-md flex-col items-center gap-3 rounded-md border border-dashed p-8 text-center">
          <p className="text-sm font-medium">
            {t('common.messages.namespaceNotFoundOnCluster', {
              namespace: namespaceParam,
              defaultValue:
                '命名空间 {{namespace}} 在当前集群中不存在，可能来自其他集群。',
            })}
          </p>
          <p className="text-xs text-muted-foreground">
            {t(
              'common.messages.namespaceNotFoundHint',
              '请选择下方的一个命名空间，或查看全部命名空间的资源。'
            )}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate('/deployments')}
            >
              {t('workloadWizard.viewAll', '查看全部')}
            </Button>
            {(allNamespaces || []).slice(0, 5).map((ns) => {
              const name = ns.metadata?.name
              if (!name) return null
              return (
                <Button
                  key={name}
                  variant="secondary"
                  size="sm"
                  onClick={() => navigate(`/deployments/${name}`)}
                >
                  {name}
                </Button>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  const handleCreateClick = () => {
    // The URL wins, then the table's persisted selection; a multi or
    // "all namespaces" selection cannot host a new object.
    const ns = resolveCreateNamespace(
      namespaceParam,
      sessionStorage.getItem(getClusterScopedStorageKey('selectedNamespace')),
      localStorage.getItem(getClusterScopedStorageKey('selectedNamespace'))
    )
    navigate(`/deployments/${encodeURIComponent(ns)}/create?tab=container-0`)
  }

  return (
    <>
      <ResourceTable
        resourceName="Deployments"
        columns={columns}
        searchQueryFilter={deploymentSearchFilter}
        showCreateButton={true}
        onCreateClick={handleCreateClick}
        batchActions={batchActions}
        initialNamespace={namespaceParam}
        onNamespaceChange={(ns) => {
          // Keep the URL in sync: /deployments/<ns> or /deployments for all.
          navigate(
            ns && ns !== '_all'
              ? `/deployments/${encodeURIComponent(ns)}`
              : '/deployments',
            { replace: true }
          )
        }}
      />

      <ResourceBatchActionDialog
        open={isRestartDialogOpen}
        onOpenChange={setIsRestartDialogOpen}
        resources={batchDeployments}
        title={t('resourceTable.batchActions.restartResourcesTitle', {
          count: batchDeployments.length,
          resource: t('nav.deployments'),
        })}
        description={t(
          'resourceTable.batchActions.restartResourcesDescription',
          { resource: t('nav.deployments') }
        )}
        actionLabel={t('common.actions.restart')}
        onExecute={(deployment) =>
          restartWorkload(
            'deployments',
            deployment.metadata!.name!,
            deployment.metadata!.namespace!
          )
        }
        onComplete={() =>
          queryClient.invalidateQueries({ queryKey: ['deployments'] })
        }
        destructive={true}
      />
    </>
  )
}
