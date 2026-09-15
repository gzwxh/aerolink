import { useMemo } from 'react'
import { IconCopy, IconNetwork } from '@tabler/icons-react'
import { Deployment } from 'kubernetes-types/apps/v1'
import type { Service } from 'kubernetes-types/core/v1'
import { Event as KubernetesEvent, Pod } from 'kubernetes-types/core/v1'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

import { useRelatedResources } from '@/lib/api'
import { getDeploymentStatus, getEventTime, getOwnerInfo } from '@/lib/k8s'
import { formatDate, getAge } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { DeploymentStatusIcon } from '@/components/deployment-status-icon'
import {
  ContainerImagesList,
  WorkloadInfoBlock,
  WorkloadInfoRow,
  WorkloadSummaryCard,
} from '@/components/workload-overview-parts'
import { WorkloadPodsCard } from '@/components/workload-pods-card'

import {
  CompactEventsCard,
  CompactRelatedResourcesCard,
  MetadataListCard,
} from './pod-overview-sidebar'

type TranslationFn = ReturnType<typeof useTranslation>['t']

export function DeploymentOverview({
  deployment,
  namespace,
  name,
  pods,
  isPodsLoading,
  events,
  isEventsLoading,
  services,
}: {
  deployment: Deployment
  namespace: string
  name: string
  pods?: Pod[]
  isPodsLoading: boolean
  events?: KubernetesEvent[]
  isEventsLoading: boolean
  services?: Service[]
}) {
  const { t } = useTranslation()
  const sortedEvents = useMemo(() => {
    return (events || []).slice().sort((a, b) => {
      const timeDiff = getEventTime(b).getTime() - getEventTime(a).getTime()
      if (timeDiff !== 0) {
        return timeDiff
      }
      return (
        Number(b.metadata?.resourceVersion || 0) -
        Number(a.metadata?.resourceVersion || 0)
      )
    })
  }, [events])
  const labels = deployment.metadata?.labels || {}
  const annotations = deployment.metadata?.annotations || {}
  const { data: relatedResources, isLoading: isRelatedLoading } =
    useRelatedResources('deployments', name, namespace)

  return (
    <div className="@container/deployment-overview space-y-3">
      <DeploymentSummaryGrid deployment={deployment} />

      <div className="grid gap-3 @4xl/deployment-overview:grid-cols-3">
        <div className="space-y-3 @4xl/deployment-overview:col-span-2">
          <WorkloadPodsCard
            title={t('common.fields.pods')}
            pods={pods || []}
            isLoading={isPodsLoading}
            loadingText={t('common.messages.loadingPods')}
            emptyText={t('common.messages.noPods')}
            ageLabel={t('common.fields.age')}
          />
          <DeploymentInformationCard deployment={deployment} />
        </div>

        <div className="space-y-3">
          <CompactEventsCard
            events={sortedEvents}
            isLoading={isEventsLoading}
          />
          <CompactRelatedResourcesCard
            resources={relatedResources || []}
            isLoading={isRelatedLoading}
          />
          {(services || []).length > 0 ? (
            <ServiceEndpointsCard services={services!} />
          ) : null}
          {Object.keys(labels).length > 0 ? (
            <MetadataListCard title="common.fields.labels" entries={labels} />
          ) : null}
          {Object.keys(annotations).length > 0 ? (
            <MetadataListCard
              title="common.fields.annotations"
              entries={annotations}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}

/** 网络入口: how to reach the workload from outside/inside the cluster. */
function ServiceEndpointsCard({ services }: { services: Service[] }) {
  const { t } = useTranslation()

  const entries = useMemo(() => {
    const result: Array<{
      key: string
      service: string
      protocol: string
      port: number
      access: string
    }> = []
    for (const svc of services) {
      const svcName = svc.metadata?.name || ''
      const type = svc.spec?.type || 'ClusterIP'
      const clusterIP = svc.spec?.clusterIP
      const lbIngress = svc.status?.loadBalancer?.ingress || []
      for (const p of svc.spec?.ports || []) {
        const port = p.port
        if (!port) continue
        const protocol = p.protocol || 'TCP'
        let access: string
        if (type === 'NodePort' && p.nodePort) {
          access = `任意节点:${p.nodePort}`
        } else if (type === 'LoadBalancer') {
          if (lbIngress.length > 0) {
            access = lbIngress
              .map((ing) => `${ing.ip || ing.hostname || ''}:${p.port}`)
              .join(', ')
          } else {
            access = t('deploymentOverview.lbPending', '外部 IP 待分配')
          }
        } else if (clusterIP === 'None') {
          access = `Headless (${svcName})`
        } else {
          access = `${clusterIP || svcName}:${port}`
        }
        result.push({
          key: `${svcName}-${protocol}-${port}-${access}`,
          service: `${svcName}/${protocol}:${port}`,
          protocol,
          port,
          access,
        })
      }
    }
    return result
  }, [services, t])

  if (entries.length === 0) return null

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      toast.success(t('deploymentOverview.copied', '已复制'))
    } catch {
      // clipboard unavailable
    }
  }

  return (
    <Card>
      <CardHeader className="pb-1.5 pt-4">
        <CardTitle className="flex items-center gap-2 text-sm">
          <IconNetwork className="size-4 text-muted-foreground" />
          {t('deploymentOverview.endpointsTitle', 'Endpoints')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5 pb-3">
        {entries.map((entry) => (
          <div
            key={entry.key}
            className="group flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-2.5 py-1"
          >
            <div className="min-w-0">
              <p className="truncate text-xs text-muted-foreground">
                {entry.service}
              </p>
              <p className="truncate font-mono text-sm font-medium">
                {entry.access}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
              aria-label={t('deploymentOverview.copy', '复制')}
              onClick={() => void copy(entry.access)}
            >
              <IconCopy className="size-3.5" />
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function DeploymentSummaryGrid({ deployment }: { deployment: Deployment }) {
  const { t } = useTranslation()
  const status = deployment.status
  const desiredReplicas = deployment.spec?.replicas ?? 0
  const deploymentStatus = getDeploymentStatus(deployment)

  return (
    <div className="grid gap-3 md:grid-cols-2 @4xl/deployment-overview:grid-cols-6">
      <WorkloadSummaryCard
        label={t('common.fields.status')}
        value={
          <span className="inline-flex min-w-0 items-center gap-2">
            <DeploymentStatusIcon
              status={deploymentStatus}
              className="size-4 shrink-0"
            />
            <span className="truncate">
              {formatDeploymentStatus(deploymentStatus, t)}
            </span>
          </span>
        }
        detail={deployment.spec?.paused ? t('common.fields.paused') : undefined}
      />
      <WorkloadSummaryCard
        label={t('common.fields.desired')}
        value={desiredReplicas}
        detail={t('common.fields.replicas')}
      />
      <WorkloadSummaryCard
        label={t('common.fields.ready')}
        value={`${status?.readyReplicas || 0}/${desiredReplicas}`}
        detail={t('common.fields.replicas')}
      />
      <WorkloadSummaryCard
        label={t('common.fields.upToDate')}
        value={status?.updatedReplicas || 0}
        detail={t('common.fields.replicas')}
      />
      <WorkloadSummaryCard
        label={t('common.fields.available')}
        value={status?.availableReplicas || 0}
        detail={t('common.fields.replicas')}
      />
      <WorkloadSummaryCard
        label={t('common.fields.created')}
        value={
          deployment.metadata?.creationTimestamp
            ? t('common.messages.timeAgo', {
                time: getAge(deployment.metadata.creationTimestamp),
              })
            : '-'
        }
        detail={
          deployment.metadata?.creationTimestamp
            ? formatDate(deployment.metadata.creationTimestamp)
            : t('common.messages.notCreated')
        }
      />
    </div>
  )
}

function DeploymentInformationCard({ deployment }: { deployment: Deployment }) {
  const { t } = useTranslation()
  const [searchParams] = useSearchParams()
  const ownerInfo = getOwnerInfo(deployment.metadata)
  const selectorEntries = Object.entries(
    deployment.spec?.selector?.matchLabels || {}
  )
  const templateSpec = deployment.spec?.template?.spec
  const templateContainers = [
    ...(templateSpec?.initContainers || []),
    ...(templateSpec?.containers || []),
  ]
  const containersCount = templateContainers.length
  const volumesCount = templateSpec?.volumes?.length || 0
  const strategy = deployment.spec?.strategy
  const rollingUpdate = strategy?.rollingUpdate
  const revision =
    deployment.metadata?.annotations?.['deployment.kubernetes.io/revision']
  const volumeTabSearchParams = new URLSearchParams(searchParams)
  volumeTabSearchParams.set('tab', 'volumes')
  const volumeTabSearch = `?${volumeTabSearchParams.toString()}`

  return (
    <Card className="gap-0 overflow-hidden rounded-lg border-border/70 py-0 shadow-none">
      <CardHeader className="px-3 py-2.5 !pb-2.5">
        <CardTitle className="text-balance text-sm">
          {t('common.fields.information')}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-3 pb-3 pt-1">
        <div className="space-y-3">
          <div className="grid gap-x-6 gap-y-3 md:grid-cols-2">
            <WorkloadInfoBlock
              label={t('common.fields.owner')}
              truncate={!!ownerInfo}
            >
              {ownerInfo ? (
                <Link
                  to={ownerInfo.path}
                  className="app-link inline-block max-w-full truncate"
                >
                  {ownerInfo.kind}/{ownerInfo.name}
                </Link>
              ) : (
                <span className="text-muted-foreground">
                  {t('common.values.none')}
                </span>
              )}
            </WorkloadInfoBlock>
            <WorkloadInfoBlock
              label={t('common.fields.selector')}
              truncate={selectorEntries.length === 0}
            >
              {selectorEntries.length > 0 ? (
                <div className="flex min-w-0 flex-wrap gap-1">
                  {selectorEntries.map(([key, value]) => (
                    <Badge
                      key={key}
                      variant="outline"
                      className="max-w-full truncate font-mono"
                      title={`${key}=${value}`}
                    >
                      {key}={value}
                    </Badge>
                  ))}
                </div>
              ) : (
                <span className="text-muted-foreground">-</span>
              )}
            </WorkloadInfoBlock>
            <WorkloadInfoBlock
              label={t('common.fields.images')}
              truncate={false}
              className="md:col-span-2"
            >
              <ContainerImagesList containers={templateContainers} />
            </WorkloadInfoBlock>
          </div>

          <div className="grid gap-x-8 gap-y-2 border-t border-border/60 pt-3 md:grid-cols-2">
            <WorkloadInfoRow label={t('common.fields.strategy')}>
              {strategy?.type || 'RollingUpdate'}
            </WorkloadInfoRow>
            {revision ? (
              <WorkloadInfoRow label={t('common.fields.revision')}>
                {revision}
              </WorkloadInfoRow>
            ) : null}
            {rollingUpdate?.maxSurge !== undefined ? (
              <WorkloadInfoRow label={t('common.fields.maxSurge')}>
                {String(rollingUpdate.maxSurge)}
              </WorkloadInfoRow>
            ) : null}
            {rollingUpdate?.maxUnavailable !== undefined ? (
              <WorkloadInfoRow label={t('common.fields.maxUnavailable')}>
                {String(rollingUpdate.maxUnavailable)}
              </WorkloadInfoRow>
            ) : null}
            <WorkloadInfoRow label={t('common.fields.serviceAccount')} mono>
              {templateSpec?.serviceAccountName || 'default'}
            </WorkloadInfoRow>
            <WorkloadInfoRow label={t('common.fields.containers')}>
              {containersCount}
            </WorkloadInfoRow>
            <WorkloadInfoRow label={t('common.fields.volumes')}>
              {volumesCount > 0 ? (
                <Link to={volumeTabSearch} className="app-link">
                  {volumesCount}
                </Link>
              ) : (
                0
              )}
            </WorkloadInfoRow>
            <WorkloadInfoRow label={t('common.fields.minReadySeconds')}>
              {deployment.spec?.minReadySeconds ?? 0}s
            </WorkloadInfoRow>
            <WorkloadInfoRow label={t('common.fields.progressDeadline')}>
              {deployment.spec?.progressDeadlineSeconds !== undefined
                ? `${deployment.spec.progressDeadlineSeconds}s`
                : '-'}
            </WorkloadInfoRow>
            {deployment.spec?.paused ? (
              <WorkloadInfoRow label={t('common.fields.paused')}>
                {t('common.values.yes')}
              </WorkloadInfoRow>
            ) : null}
          </div>

          <div className="border-t border-border/60 pt-2">
            <WorkloadInfoRow label="UID" mono truncate={false} compact>
              <span className="break-all">
                {deployment.metadata?.uid || '-'}
              </span>
            </WorkloadInfoRow>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function formatDeploymentStatus(value: string, t: TranslationFn) {
  const key = value
    .replace(/\s+(\w)/g, (_, letter: string) => letter.toUpperCase())
    .replace(/^./, (letter) => letter.toLowerCase())
  return t(`status.${key}`, { defaultValue: value })
}
