import { useMemo, useState } from 'react'
import {
  IconCopy,
  IconDownload,
  IconPencil,
  IconTrash,
} from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import * as yaml from 'js-yaml'
import { Namespace } from 'kubernetes-types/core/v1'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import {
  deleteResource,
  updateResource,
  useResource,
  useResources,
} from '@/lib/api'
import { useClusterNavigate } from '@/lib/cluster-path'
import { getPodStatus } from '@/lib/k8s'
import { getResourceDetailPath } from '@/lib/resource-catalog'
import { getAge, translateError } from '@/lib/utils'
import { useCan } from '@/hooks/use-can'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CloneResourceDialog } from '@/components/clone-resource-dialog'
import { ClusterLink } from '@/components/cluster-link'
import {
  DeleteNamespaceDialog,
  EditNamespaceDialog,
} from '@/components/namespace-row-actions'
import { PodStatusIcon } from '@/components/pod-status-icon'

import { ResourceDetailShell } from './resource-detail-shell'

const POD_PHASES = [
  { phase: 'Running', labelKey: 'status.running', fallback: 'Running' },
  { phase: 'Pending', labelKey: 'status.pending', fallback: 'Pending' },
  { phase: 'Succeeded', labelKey: 'status.succeeded', fallback: 'Succeeded' },
  { phase: 'Failed', labelKey: 'status.failed', fallback: 'Failed' },
  { phase: 'Unknown', labelKey: 'status.unknown', fallback: 'Unknown' },
] as const

const PHASE_STYLES: Record<string, string> = {
  Running: 'border-l-success',
  Pending: 'border-l-info',
  Succeeded: 'border-l-warning',
  Failed: 'border-l-destructive',
  Unknown: 'border-l-muted-foreground/40',
}

interface WorkloadRow {
  kind: string
  resourceType: string
  name: string
  images: string[]
  ready: string
  created?: string
}

interface PodRow {
  name: string
  namespace: string
  status: string
  ready: string
  restarts: string
  ip: string
  node: string
  created?: string
}

type MutableItem = Record<string, unknown> & {
  metadata?: Record<string, unknown>
  spec?: Record<string, unknown>
  status?: Record<string, unknown>
}

function downloadNamespaceYaml(resource: unknown, name: string) {
  const content = yaml.dump(resource, { indent: 2, noRefs: true })
  const blob = new Blob([content], { type: 'application/x-yaml' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${name}-namespace.yaml`
  link.click()
  URL.revokeObjectURL(url)
}

export function NamespaceDetailPage({ name }: { name: string }) {
  const { t } = useTranslation()
  const navigate = useClusterNavigate()
  const queryClient = useQueryClient()
  const can = useCan()
  // 克隆 / 编辑 / 删除命名空间都是写操作；只读角色只保留下载 YAML。
  const canCreateNamespace = can('namespaces', 'create')
  const canUpdateNamespace = can('namespaces', 'update')
  const canDeleteNamespace = can('namespaces', 'delete')

  const {
    data: ns,
    isLoading,
    error,
    refetch,
  } = useResource('namespaces', name)
  const { data: pods = [] } = useResources('pods', name, { limit: 500 })
  const { data: deployments = [] } = useResources('deployments', name, {
    limit: 500,
  })
  const { data: statefulsets = [] } = useResources('statefulsets', name, {
    limit: 500,
  })
  const { data: daemonsets = [] } = useResources('daemonsets', name, {
    limit: 500,
  })
  const { data: quotas = [] } = useResources('resourcequotas', name, {
    limit: 10,
  })

  const [showEdit, setShowEdit] = useState(false)
  const [showDelete, setShowDelete] = useState(false)
  const [showClone, setShowClone] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const podStats = useMemo(() => {
    const counts = new Map<string, number>()
    for (const pod of pods) {
      const phase = pod.status?.phase || 'Unknown'
      counts.set(phase, (counts.get(phase) || 0) + 1)
    }
    return POD_PHASES.map(({ phase, labelKey, fallback }) => ({
      phase,
      label: t(labelKey, fallback),
      count: counts.get(phase) || 0,
    }))
  }, [pods, t])

  const workloads = useMemo<WorkloadRow[]>(() => {
    const rows: WorkloadRow[] = []
    const collect = (
      kind: string,
      resourceType: string,
      items: MutableItem[]
    ) => {
      for (const item of items) {
        const spec = item.spec || {}
        const status = item.status || {}
        const template = (spec.template || {}) as Record<string, unknown>
        const podSpec = (template.spec || {}) as Record<string, unknown>
        const containers = Array.isArray(podSpec.containers)
          ? (podSpec.containers as Array<Record<string, unknown>>)
          : []
        const images = containers
          .map((c) => c.image)
          .filter((i): i is string => typeof i === 'string')
        const desired = Number(spec.replicas ?? 1)
        const ready = Number(status.readyReplicas ?? 0)
        rows.push({
          kind,
          resourceType,
          name: String(item.metadata?.name || ''),
          images,
          ready: `${ready}/${desired}`,
          created: item.metadata?.creationTimestamp as string | undefined,
        })
      }
    }
    collect(
      'Deployment',
      'deployments',
      deployments as unknown as MutableItem[]
    )
    collect(
      'StatefulSet',
      'statefulsets',
      statefulsets as unknown as MutableItem[]
    )
    collect('DaemonSet', 'daemonsets', daemonsets as unknown as MutableItem[])
    return rows.sort((a, b) => a.name.localeCompare(b.name))
  }, [deployments, statefulsets, daemonsets])

  const podRows = useMemo<PodRow[]>(() => {
    return [...pods]
      .map((pod) => {
        const status = getPodStatus(pod)
        return {
          name: pod.metadata?.name || '',
          namespace: pod.metadata?.namespace || '',
          status: status.reason,
          ready: `${status.readyContainers}/${status.totalContainers}`,
          restarts: status.restartString,
          ip: pod.status?.podIP || '-',
          node: pod.spec?.nodeName || '-',
          created: pod.metadata?.creationTimestamp,
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [pods])

  const labels = useMemo(
    () =>
      Object.entries((ns?.metadata?.labels as Record<string, string>) || {}),
    [ns]
  )

  const quota = quotas[0] as
    (MutableItem & { spec?: { hard?: Record<string, unknown> } }) | undefined

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await deleteResource('namespaces', name, undefined)
      toast.success(
        t('nsActions.deleted', {
          name,
          defaultValue: 'Namespace {{name}} deleted',
        })
      )
      queryClient.invalidateQueries()
      navigate('/namespaces')
    } catch (error) {
      toast.error(translateError(error, t))
      setDeleting(false)
    }
  }

  const hard = (quota?.spec?.hard || {}) as Record<string, unknown>
  const quotaCells: Array<[string, unknown]> = [
    ['CPU', hard['limits.cpu'] ?? hard['requests.cpu']],
    ['Memory', hard['limits.memory'] ?? hard['requests.memory']],
    ['Pods', hard['pods']],
    ['GPU', hard['limits.nvidia.com/gpu']],
  ]

  return (
    <>
      <ResourceDetailShell
        resourceType="namespaces"
        resourceLabel={t('common.fields.namespace', 'Namespace')}
        name={name}
        data={ns}
        isLoading={isLoading}
        error={error}
        onRefresh={refetch}
        showClone={false}
        showDelete={false}
        defaultTab="workloads"
        onSaveYaml={(content) =>
          updateResource('namespaces', name, undefined, content as Namespace)
        }
        overview={
          <div className="space-y-4">
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <span className="text-muted-foreground">
                {t('common.fields.age', 'Age')}:{' '}
                <span className="font-medium text-foreground">
                  {ns?.metadata?.creationTimestamp
                    ? getAge(ns.metadata.creationTimestamp)
                    : '-'}
                </span>
              </span>
            </div>

            <div>
              <div className="mb-2 text-sm font-medium">
                {t('nsEdit.labels', 'Labels')}
              </div>
              {labels.length === 0 ? (
                <p className="text-sm text-muted-foreground">-</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {labels.map(([key, value]) => (
                    <Badge key={key} variant="outline" className="max-w-full">
                      <span className="truncate">
                        {key}={value}
                      </span>
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            {quota && (
              <div>
                <div className="mb-2 text-sm font-medium">
                  {t('nsEdit.quotaTitle', 'Container Resource Limits')}
                </div>
                <div className="rounded-md border">
                  <div className="grid grid-cols-2 gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs font-semibold text-muted-foreground sm:grid-cols-4">
                    {quotaCells.map(([label]) => (
                      <span key={label}>{label}</span>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 gap-2 px-3 py-2 text-sm sm:grid-cols-4">
                    {quotaCells.map(([label, value]) => (
                      <span key={label}>{value ? String(value) : '-'}</span>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        }
        extraTabs={[
          {
            value: 'workloads',
            label: t('nsDetail.workloadsTab', 'Workloads'),
            content: (
              <div className="space-y-4">
                <div>
                  <div className="mb-2 text-sm font-medium">
                    {t('nsDetail.podStatsTitle', 'Pod Status')}
                  </div>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                    {podStats.map((stat) => (
                      <div
                        key={stat.phase}
                        className={`rounded-md border border-l-4 bg-card px-3 py-2 ${
                          PHASE_STYLES[stat.phase] ||
                          'border-l-muted-foreground/40'
                        }`}
                      >
                        <div className="text-2xl font-bold">{stat.count}</div>
                        <div className="text-xs text-muted-foreground">
                          {stat.label}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="overflow-hidden rounded-md border">
                  <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1.5fr)_auto_auto] items-center gap-3 border-b bg-muted/40 px-3 py-2 text-xs font-semibold text-muted-foreground">
                    <span>{t('common.fields.status', 'Status')}</span>
                    <span>{t('common.fields.name', 'Name')}</span>
                    <span>{t('common.fields.type', 'Type')}</span>
                    <span>{t('common.fields.image', 'Image')}</span>
                    <span>{t('pods.ready', 'Ready')}</span>
                    <span>{t('common.fields.created', 'Created')}</span>
                  </div>
                  {workloads.length === 0 ? (
                    <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                      {t('common.messages.noOptionsFound', 'No options found')}
                    </div>
                  ) : (
                    workloads.map((w) => (
                      <div
                        key={`${w.kind}-${w.name}`}
                        className="grid grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1.5fr)_auto_auto] items-center gap-3 border-b px-3 py-2 text-sm last:border-b-0"
                      >
                        <Badge variant="outline" className="text-xs">
                          {t('status.active', 'Active')}
                        </Badge>
                        <ClusterLink
                          to={getResourceDetailPath(
                            w.resourceType,
                            w.name,
                            name
                          )}
                          className="app-link truncate font-medium"
                          title={w.name}
                        >
                          {w.name}
                        </ClusterLink>
                        <span className="text-xs text-muted-foreground">
                          {w.kind}
                        </span>
                        <span
                          className="truncate text-xs text-muted-foreground"
                          title={w.images.join(', ')}
                        >
                          {w.images[0] || '-'}
                        </span>
                        <span className="text-xs">{w.ready}</span>
                        <span className="text-xs text-muted-foreground">
                          {w.created ? getAge(w.created) : '-'}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ),
          },
          {
            value: 'pods',
            label: t('nsDetail.podsTab', 'Pods'),
            content: (
              <div className="overflow-hidden rounded-md border">
                <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto_auto_auto_auto] items-center gap-3 border-b bg-muted/40 px-3 py-2 text-xs font-semibold text-muted-foreground">
                  <span>{t('common.fields.status', 'Status')}</span>
                  <span>{t('common.fields.name', 'Name')}</span>
                  <span>{t('common.fields.ready', 'Ready')}</span>
                  <span>{t('common.fields.restarts', 'Restarts')}</span>
                  <span>{t('common.fields.podIP', 'Pod IP')}</span>
                  <span>{t('common.fields.node', 'Node')}</span>
                  <span>{t('common.fields.age', 'Age')}</span>
                </div>
                {podRows.length === 0 ? (
                  <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                    {t('common.messages.noOptionsFound', 'No options found')}
                  </div>
                ) : (
                  podRows.map((p) => (
                    <div
                      key={`${p.namespace}-${p.name}`}
                      className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto_auto_auto_auto] items-center gap-3 border-b px-3 py-2 text-sm last:border-b-0"
                    >
                      <Badge
                        variant="outline"
                        className="px-1.5 text-muted-foreground"
                      >
                        <PodStatusIcon status={p.status} />
                        {p.status}
                      </Badge>
                      <ClusterLink
                        to={`/pods/${p.namespace}/${p.name}`}
                        className="app-link truncate font-medium"
                        title={p.name}
                      >
                        {p.name}
                      </ClusterLink>
                      <span className="text-xs">{p.ready}</span>
                      <span className="text-xs text-muted-foreground">
                        {p.restarts}
                      </span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {p.ip}
                      </span>
                      <span
                        className="truncate text-xs text-muted-foreground"
                        title={p.node}
                      >
                        {p.node}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {p.created ? getAge(p.created) : '-'}
                      </span>
                    </div>
                  ))
                )}
              </div>
            ),
          },
        ]}
        headerActions={
          <>
            {canCreateNamespace && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowClone(true)}
              >
                <IconCopy className="h-4 w-4" />
                {t('nsActions.clone', 'Clone')}
              </Button>
            )}
            {canUpdateNamespace && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowEdit(true)}
              >
                <IconPencil className="h-4 w-4" />
                {t('common.actions.edit', 'Edit')}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (!ns) return
                downloadNamespaceYaml(ns, name)
              }}
            >
              <IconDownload className="h-4 w-4" />
              {t('nsActions.downloadYaml', 'Download YAML')}
            </Button>
            {canDeleteNamespace && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setShowDelete(true)}
              >
                <IconTrash className="h-4 w-4" />
                {t('common.actions.delete', 'Delete')}
              </Button>
            )}
          </>
        }
      />

      {showEdit && (
        <EditNamespaceDialog
          name={name}
          resource={(ns || {}) as MutableItem}
          onClose={() => setShowEdit(false)}
        />
      )}

      {showDelete && (
        <DeleteNamespaceDialog
          name={name}
          deleting={deleting}
          onConfirm={() => void handleDelete()}
          onClose={() => setShowDelete(false)}
        />
      )}

      {showClone && (
        <CloneResourceDialog
          open={showClone}
          onOpenChange={setShowClone}
          resourceType="namespaces"
          resourceLabel={t('common.fields.namespace', 'Namespace')}
          sourceName={name}
          resource={ns}
        />
      )}
    </>
  )
}

export default NamespaceDetailPage
