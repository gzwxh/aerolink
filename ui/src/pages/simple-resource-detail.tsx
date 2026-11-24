import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ResourceType, ResourceTypeMap } from '@/types/api'
import { updateResource, useResource } from '@/lib/api'
import { getResourceFormEditPath } from '@/lib/resource-catalog'
import { EventTable } from '@/components/event-table'
import { RelatedResourcesTable } from '@/components/related-resource-table'
import { ResourceHistoryTable } from '@/components/resource-history-table'
import { ResourceOverview } from '@/components/resource-overview'

import { getResourceLabel } from './resource-definitions'
import {
  ResourceDetailShell,
  type ResourceDetailShellTab,
} from './resource-detail-shell'

export function SimpleResourceDetail<T extends ResourceType>(props: {
  resourceType: T
  name: string
  namespace?: string
}) {
  const { namespace, name, resourceType } = props
  const { t } = useTranslation()

  const { data, isLoading, error, refetch } = useResource(
    resourceType,
    name,
    namespace
  )

  const resourceLabel = getResourceLabel(resourceType)

  const handleSaveYaml = async (content: ResourceTypeMap[T]) => {
    await updateResource(resourceType, name, namespace, content)
    await refetch()
    // 成功反馈不能只有专用详情页有：Ingress / PDB / HPA / CRD 实例这类
    // 只有通用详情页的资源，保存后原先什么都不提，用户无法判断是否落库（D-86）。
    toast.success(t('common.messages.yamlSaved'))
  }

  const tabs = useMemo<ResourceDetailShellTab<ResourceTypeMap[T]>[]>(
    () => [
      {
        value: 'related',
        label: t('common.tabs.related'),
        content: (
          <RelatedResourcesTable
            resource={resourceType}
            name={name}
            namespace={namespace}
          />
        ),
      },
      {
        value: 'events',
        label: t('common.tabs.events'),
        content: (
          <EventTable
            resource={resourceType}
            namespace={namespace}
            name={name}
          />
        ),
      },
      {
        value: 'history',
        label: t('common.tabs.history'),
        content: data ? (
          <ResourceHistoryTable
            resourceType={resourceType}
            name={name}
            namespace={namespace}
            currentResource={data}
          />
        ) : null,
      },
    ],
    [data, name, namespace, resourceType, t]
  )

  return (
    <ResourceDetailShell
      resourceType={resourceType}
      resourceLabel={resourceLabel}
      name={name}
      namespace={namespace}
      data={data}
      isLoading={isLoading}
      error={error}
      onRefresh={refetch}
      onSaveYaml={handleSaveYaml}
      // 这些资源都还只有通用详情页（没有专用的 detailPage），编辑入口就靠这个路径。
      editPath={getResourceFormEditPath(resourceType, name, namespace)}
      overview={
        // 传整个对象：详情页要呈现它的状态条件（验收台账 D-175）。
        data ? (
          <ResourceOverview
            resourceType={resourceType}
            name={name}
            namespace={namespace}
            metadata={data.metadata}
            resource={data}
            fields={[
              {
                label: t('common.fields.resourceVersion'),
                value: data.metadata?.resourceVersion || '-',
                mono: true,
              },
            ]}
          />
        ) : null
      }
      extraTabs={tabs}
    />
  )
}
