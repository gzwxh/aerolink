import { useMemo } from 'react'
import { ConfigMap } from 'kubernetes-types/core/v1'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { updateResource, useResource } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { KeyValueDataViewer } from '@/components/key-value-data-viewer'
import { ResourceOverview } from '@/components/resource-overview'

import {
  ResourceDetailShell,
  type ResourceDetailShellTab,
} from './resource-detail-shell'

export function ConfigMapDetail(props: { namespace: string; name: string }) {
  const { namespace, name } = props
  const { t } = useTranslation()

  // 详情外壳用当前用户对 resourceType（configmaps）的权限
  // 对克隆 / 删除 / YAML 操作做门控。

  const { data, isLoading, isError, error, refetch } = useResource(
    'configmaps',
    name,
    namespace
  )
  const dataCount = data ? Object.keys(data.data || {}).length : 0
  const binaryDataCount = data ? Object.keys(data.binaryData || {}).length : 0
  const totalCount = dataCount + binaryDataCount

  const handleSaveYaml = async (content: ConfigMap) => {
    await updateResource('configmaps', name, namespace, content)
    toast.success(t('common.messages.yamlSaved'))
    await refetch()
  }

  const tabs = useMemo<ResourceDetailShellTab<ConfigMap>[]>(
    () => [
      {
        value: 'data',
        label: (
          <>
            {t('common.fields.data')}
            {totalCount > 0 ? (
              <Badge variant="secondary">{totalCount}</Badge>
            ) : null}
          </>
        ),
        content: data ? (
          <div className="space-y-4">
            {dataCount > 0 && (
              <KeyValueDataViewer
                entries={data.data!}
                emptyMessage={t(
                  'keyValueDataViewer.noDataEntries',
                  '暂无数据条目'
                )}
              />
            )}
            {binaryDataCount > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t('common.fields.binaryData')}
                </p>
                <KeyValueDataViewer
                  entries={Object.fromEntries(
                    Object.entries(data.binaryData || {}).map(
                      ([key, value]) => [key, atob(value)]
                    )
                  )}
                  emptyMessage={t(
                    'keyValueDataViewer.noBinaryDataEntries',
                    '暂无二进制数据条目'
                  )}
                />
              </div>
            )}
          </div>
        ) : null,
      },
    ],
    [binaryDataCount, data, dataCount, t, totalCount]
  )

  // 只有存在保存处理器时外壳才渲染 YAML 标签页，因此
  // 它总是被传入；yamlEditable 决定是否允许保存。
  return (
    <ResourceDetailShell
      resourceType="configmaps"
      resourceLabel="ConfigMap"
      name={name}
      namespace={namespace}
      data={data}
      isLoading={isLoading}
      error={isError ? error : null}
      onRefresh={refetch}
      onSaveYaml={handleSaveYaml}
      overview={
        data ? (
          <ResourceOverview
            resourceType="configmaps"
            name={name}
            namespace={namespace}
            metadata={data.metadata}
            fields={[
              {
                label: t('common.fields.keys'),
                value: totalCount,
              },
              {
                label: t('common.fields.data'),
                value: dataCount,
              },
              {
                label: t('common.fields.binaryData'),
                value: binaryDataCount,
              },
              {
                label: t('common.fields.resourceVersion'),
                value: data.metadata?.resourceVersion || '-',
                mono: true,
              },
            ]}
          />
        ) : null
      }
      preYamlTabs={tabs}
    />
  )
}
