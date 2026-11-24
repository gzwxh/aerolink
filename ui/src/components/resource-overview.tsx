import { useMemo, type ReactNode } from 'react'
import type { ObjectMeta } from 'kubernetes-types/meta/v1'
import { useTranslation } from 'react-i18next'

import type { ResourceType } from '@/types/api'
import { useRelatedResources, useResourcesEvents } from '@/lib/api'
import { getEventTime, getOwnerInfo } from '@/lib/k8s'
import {
  extractConditions,
  isConditionPassing,
  type ResourceCondition,
} from '@/lib/resource-conditions'
import { formatDate } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ClusterLink } from '@/components/cluster-link'
import {
  WorkloadInfoBlock,
  WorkloadInfoRow,
} from '@/components/workload-overview-parts'

import {
  CompactEventsCard,
  CompactRelatedResourcesCard,
  MetadataListCard,
} from './pod-overview-sidebar'

export interface ResourceOverviewField {
  label: ReactNode
  value: ReactNode
  mono?: boolean
  truncate?: boolean
}

export function ResourceOverview({
  resourceType,
  name,
  namespace,
  metadata,
  resource,
  fields,
  children,
}: {
  resourceType: ResourceType
  name: string
  namespace?: string
  metadata?: ObjectMeta
  /** 对象本身：只为取 status.conditions 等状态条件（验收台账 D-175）。 */
  resource?: unknown
  fields?: ResourceOverviewField[]
  children?: ReactNode
}) {
  const { t } = useTranslation()
  const labels = metadata?.labels || {}
  const annotations = metadata?.annotations || {}
  const conditions = useMemo(() => extractConditions(resource), [resource])
  const { data: events, isLoading: isEventsLoading } = useResourcesEvents(
    resourceType,
    name,
    namespace
  )
  const { data: relatedResources, isLoading: isRelatedLoading } =
    useRelatedResources(resourceType, name, namespace)
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
  const ownerInfo = getOwnerInfo(metadata)

  return (
    <div className="@container/resource-overview">
      <div className="grid gap-3 @4xl/resource-overview:grid-cols-3">
        <div className="space-y-3 @4xl/resource-overview:col-span-2">
          <Card className="gap-0 overflow-hidden rounded-lg border-border/70 py-0 shadow-none">
            <CardHeader className="px-3 py-2.5 !pb-2.5">
              <CardTitle className="text-balance text-sm">
                {t('common.fields.information')}
              </CardTitle>
            </CardHeader>
            <CardContent className="px-3 pb-3 pt-1">
              <div className="space-y-3">
                <div className="grid gap-x-6 gap-y-3 md:grid-cols-2">
                  <WorkloadInfoBlock label={t('common.fields.created')}>
                    {metadata?.creationTimestamp
                      ? formatDate(metadata.creationTimestamp)
                      : '-'}
                  </WorkloadInfoBlock>
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
                </div>

                {fields && fields.length > 0 ? (
                  <div className="grid gap-x-8 gap-y-2 border-t border-border/60 pt-3 md:grid-cols-2">
                    {fields.map((field, index) => (
                      <WorkloadInfoRow
                        key={index}
                        label={field.label}
                        mono={field.mono}
                        truncate={field.truncate}
                      >
                        {field.value}
                      </WorkloadInfoRow>
                    ))}
                  </div>
                ) : null}

                {children ? (
                  <div className="border-t border-border/60 pt-3">
                    {children}
                  </div>
                ) : null}

                <div className="border-t border-border/60 pt-2">
                  <WorkloadInfoRow
                    label={t('common.fields.uid')}
                    mono
                    truncate={false}
                    compact
                  >
                    <span className="break-all">{metadata?.uid || '-'}</span>
                  </WorkloadInfoRow>
                </div>
              </div>
            </CardContent>
          </Card>

          {conditions.length > 0 ? (
            <ConditionsCard conditions={conditions} />
          ) : null}
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

/**
 * 状态条件。Gateway API / cert-manager 这类面除了条件没有别的健康信号，
 * 不呈现就等于「看着列表一切正常，实际路由根本没被接受」（验收台账 D-175）。
 */
function ConditionsCard({ conditions }: { conditions: ResourceCondition[] }) {
  const { t } = useTranslation()

  return (
    <Card className="gap-0 overflow-hidden rounded-lg border-border/70 py-0 shadow-none">
      <CardHeader className="px-3 py-2.5 !pb-2.5">
        <CardTitle className="text-balance text-sm">
          {t('common.fields.conditions', '状态条件')}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-3 pb-3 pt-1">
        <ul className="divide-border/60 space-y-0 divide-y">
          {conditions.map((condition, index) => {
            const passing = isConditionPassing(condition)
            return (
              <li
                key={`${condition.scope ?? ''}/${condition.type}/${index}`}
                className="py-1.5"
              >
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span
                    aria-hidden
                    className={`size-2 shrink-0 rounded-full ${
                      passing ? 'bg-success' : 'bg-destructive'
                    }`}
                  />
                  <span className="font-medium">{condition.type}</span>
                  {condition.scope ? (
                    <span className="text-muted-foreground text-xs">
                      {condition.scope}
                    </span>
                  ) : null}
                  <span
                    className={passing ? 'text-success' : 'text-destructive'}
                  >
                    {condition.status}
                  </span>
                </div>
                {condition.reason || condition.message ? (
                  <p className="text-muted-foreground mt-0.5 pl-4 text-xs">
                    {[condition.reason, condition.message]
                      .filter(Boolean)
                      .join(' — ')}
                  </p>
                ) : null}
              </li>
            )
          })}
        </ul>
      </CardContent>
    </Card>
  )
}
