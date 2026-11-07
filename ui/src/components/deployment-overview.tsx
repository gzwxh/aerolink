import { useMemo } from 'react'
import { IconCopy, IconInfoCircle, IconNetwork } from '@tabler/icons-react'
import { Deployment } from 'kubernetes-types/apps/v1'
import type { Service } from 'kubernetes-types/core/v1'
import { Event as KubernetesEvent, Pod } from 'kubernetes-types/core/v1'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

import { useRelatedResources, useResourceLastUpdates } from '@/lib/api'
import { copyToClipboard } from '@/lib/clipboard'
import {
  getDeploymentRolloutTime,
  getDeploymentStatus,
  getEventTime,
  getOwnerInfo,
} from '@/lib/k8s'
import { formatDate, getAge } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ClusterLink } from '@/components/cluster-link'
import { DeploymentStatusIcon } from '@/components/deployment-status-icon'
import {
  ContainerImagesList,
  SelectorBadges,
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

export type ServiceEndpointEntry = {
  key: string
  name: string
  namespace: string
  protocol: string
  port: number
  access: string
  /** 集群内可解析的 FQDN；NodePort 是给集群外用的，没有内网域名。 */
  dns: string | null
}

/** 入口地址里用到的文案，由调用方从 i18n 取，避免把中文写死在逻辑里。 */
export type ServiceEndpointLabels = {
  lbPending: string
  anyNode: string
  headless: string
}

/**
 * 网络入口条目：每个 Service 的每个端口一条。
 *
 * NodePort 入口保留（集群外要用），但这类服务的内网域名对使用者没意义，
 * 因此 dns 返回 null，不展示「内网域名」那一行。
 */
export function serviceEndpointEntries(
  services: Service[],
  labels: ServiceEndpointLabels
): ServiceEndpointEntry[] {
  const result: ServiceEndpointEntry[] = []
  for (const svc of services) {
    const svcName = svc.metadata?.name || ''
    const svcNamespace = svc.metadata?.namespace || ''
    const type = svc.spec?.type || 'ClusterIP'
    const clusterIP = svc.spec?.clusterIP
    const lbIngress = svc.status?.loadBalancer?.ingress || []
    for (const p of svc.spec?.ports || []) {
      const port = p.port
      if (!port) continue
      const protocol = p.protocol || 'TCP'
      let access: string
      if (type === 'NodePort' && p.nodePort) {
        access = `${labels.anyNode}:${p.nodePort}`
      } else if (type === 'LoadBalancer') {
        if (lbIngress.length > 0) {
          access = lbIngress
            .map((ing) => `${ing.ip || ing.hostname || ''}:${port}`)
            .join(', ')
        } else {
          access = labels.lbPending
        }
      } else if (clusterIP === 'None') {
        access = `${labels.headless} (${svcName})`
      } else {
        access = `${clusterIP || svcName}:${port}`
      }
      result.push({
        key: `${svcName}-${protocol}-${port}-${access}`,
        name: svcName,
        namespace: svcNamespace,
        protocol,
        port,
        access,
        // 集群内可直接解析的 FQDN（kubelet 默认 cluster domain）。
        // 末尾的点表示绝对域名：跳过 resolv.conf 的 search 域展开（ndots:5 时
        // 不加点会先试 3 个搜索域再查绝对名），少几次无谓查询。
        dns:
          type === 'NodePort'
            ? null
            : `${svcName}.${svcNamespace}.svc.cluster.local.:${port}`,
      })
    }
  }
  return result
}

/** 网络入口: how to reach the workload from outside/inside the cluster. */
function ServiceEndpointsCard({ services }: { services: Service[] }) {
  const { t } = useTranslation()

  const lbPendingText = t('deploymentOverview.lbPending', '外部 IP 待分配')
  const anyNodeText = t('deploymentOverview.anyNode', '任意节点')
  const headlessText = t('deploymentOverview.headless', 'Headless')
  const entries = useMemo(
    () =>
      serviceEndpointEntries(services, {
        lbPending: lbPendingText,
        anyNode: anyNodeText,
        headless: headlessText,
      }),
    [services, lbPendingText, anyNodeText, headlessText]
  )

  if (entries.length === 0) return null

  const copy = async (value: string) => {
    if (await copyToClipboard(value)) {
      toast.success(t('deploymentOverview.copied', '已复制'))
    } else {
      toast.error(
        t('common.messages.copyFailed', '复制失败，请手动选择文本后复制')
      )
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
                {/* 名称直接链到服务页面（带 search，只显示这一个）：关联关系在那边维护。 */}
                <ClusterLink
                  to={`/services/${encodeURIComponent(entry.namespace)}?search=${encodeURIComponent(entry.name)}`}
                  className="app-link"
                >
                  {entry.name}
                </ClusterLink>
                <span className="ml-1">
                  /{entry.protocol}:{entry.port}
                </span>
              </p>
              <p className="truncate font-mono text-sm font-medium">
                {entry.access}
              </p>
              {entry.dns !== null && (
                <p className="group/dns flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                  <span className="shrink-0">
                    {t('deploymentOverview.serviceDns', '内网域名')}
                  </span>
                  <span className="truncate font-mono" title={entry.dns}>
                    {entry.dns}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5 shrink-0 opacity-0 transition-opacity group-hover/dns:opacity-100"
                    aria-label={t('deploymentOverview.copyDns', '复制内网域名')}
                    onClick={() => void copy(entry.dns as string)}
                  >
                    <IconCopy className="size-3" />
                  </Button>
                </p>
              )}
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

/**
 * 更新时间卡：值给相对时间、detail 给完整时间，口径说明挂在标签上。
 *
 * 两个口径都不是「对象一定被改过」：平台时间只统计通过 AeroLink 的写入，
 * 发布时间取 Deployment 的 Progressing 条件。拿不到时显示「无」并在
 * tooltip 里说清原因，不能让人读成「这个部署从未更新」。
 */
function UpdateSummaryCard({
  label,
  hint,
  value,
}: {
  label: string
  hint: string
  value?: string
}) {
  const { t } = useTranslation()

  return (
    <WorkloadSummaryCard
      label={
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex cursor-default items-center gap-1">
              {label}
              <IconInfoCircle className="size-3" />
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs text-xs">{hint}</TooltipContent>
        </Tooltip>
      }
      value={
        value
          ? t('common.messages.timeAgo', { time: getAge(value) })
          : t('common.values.none')
      }
      detail={value ? formatDate(value) : t('common.values.none')}
    />
  )
}

function DeploymentSummaryGrid({ deployment }: { deployment: Deployment }) {
  const { t } = useTranslation()
  const status = deployment.status
  const desiredReplicas = deployment.spec?.replicas ?? 0
  const deploymentStatus = getDeploymentStatus(deployment)
  const namespace = deployment.metadata?.namespace
  const name = deployment.metadata?.name
  // 平台操作时间走列表同一个批量接口，保证详情页与列表上读到同一个时点。
  const { data: lastUpdates } = useResourceLastUpdates(
    'deployments',
    namespace ? [namespace] : []
  )
  const platformUpdatedAt =
    namespace && name ? lastUpdates?.[`${namespace}/${name}`] : undefined
  const rolloutUpdatedAt = getDeploymentRolloutTime(deployment)

  return (
    <div className="grid gap-3 md:grid-cols-2 @4xl/deployment-overview:grid-cols-4">
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
      <UpdateSummaryCard
        label={t('common.fields.platformUpdated')}
        hint={t('common.messages.platformUpdatedHint')}
        value={platformUpdatedAt}
      />
      <UpdateSummaryCard
        label={t('common.fields.rolloutUpdated')}
        hint={t('common.messages.rolloutUpdatedHint')}
        value={rolloutUpdatedAt}
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
                <ClusterLink
                  to={ownerInfo.path}
                  className="app-link inline-block max-w-full truncate"
                >
                  {ownerInfo.kind}/{ownerInfo.name}
                </ClusterLink>
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
              <SelectorBadges entries={selectorEntries} />
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
                <ClusterLink to={volumeTabSearch} className="app-link">
                  {volumesCount}
                </ClusterLink>
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
