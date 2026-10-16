import { useEffect, useMemo, useState } from 'react'
import { IconEdit } from '@tabler/icons-react'
import * as yaml from 'js-yaml'
import { ConfigMap } from 'kubernetes-types/core/v1'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { updateResource, useResource } from '@/lib/api'
import { decodeBase64Utf8 } from '@/lib/base64'
import { useClusterNavigate } from '@/lib/cluster-path'
import { buildDecodedConfigMap, restoreBinaryData } from '@/lib/configmap-yaml'
import { useCan } from '@/hooks/use-can'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { KeyValueDataViewer } from '@/components/key-value-data-viewer'
import { ResourceOverview } from '@/components/resource-overview'

import {
  ResourceDetailShell,
  type ResourceDetailShellTab,
} from './resource-detail-shell'

/**
 * YAML 标签页的工具栏：binaryData 是 base64，按「解码明文」查看更直观。
 *
 * 只有能无损解成 UTF-8 文本的值才会被解码（见 buildDecodedConfigMap），
 * 真二进制保持 base64 原样；保存时把解码过的键重新编码回去。
 */
function ConfigMapYamlToolbar({
  setYamlContent,
  configMap,
  showDecoded,
  hasBinaryData,
  onToggle,
}: {
  setYamlContent: (value: string) => void
  configMap: ConfigMap
  showDecoded: boolean
  hasBinaryData: boolean
  onToggle: (next: boolean) => void
}) {
  const { t } = useTranslation()

  useEffect(() => {
    setYamlContent(yaml.dump(configMap, { indent: 2 }))
  }, [configMap, setYamlContent])

  if (!hasBinaryData) {
    return null
  }

  return (
    <Button variant="outline" size="sm" onClick={() => onToggle(!showDecoded)}>
      {showDecoded
        ? t('configMapDetail.showBase64', '显示 Base64')
        : t('configMapDetail.decodeBinaryData', '解码明文')}
    </Button>
  )
}

export function ConfigMapDetail(props: { namespace: string; name: string }) {
  const { namespace, name } = props
  const { t } = useTranslation()
  const navigate = useClusterNavigate()
  const can = useCan()
  // 增删键值属于写操作，没有 update 权限时只读展示。
  const canUpdate = can('configmaps', 'update', { namespace })

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

  const [showDecodedYaml, setShowDecodedYaml] = useState(false)
  const { yamlObject, decodedKeys } = useMemo(
    () => buildDecodedConfigMap(data, showDecodedYaml),
    [data, showDecodedYaml]
  )

  const handleSaveYaml = async (content: ConfigMap) => {
    // 解码视图里被解成明文的键，写回 API 前要重新 base64 编码，
    // 否则 k8s 会因为 binaryData 不是合法 base64 而拒绝。
    const payload = showDecodedYaml
      ? restoreBinaryData(content, decodedKeys)
      : content
    await updateResource('configmaps', name, namespace, payload)
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
            {/* 没有 data 时也渲染：空态里同样可以新增键值 */}
            <KeyValueDataViewer
              entries={data.data || {}}
              emptyMessage={t(
                'keyValueDataViewer.noDataEntries',
                '暂无数据条目'
              )}
              canEdit={canUpdate}
              onSave={async (entries) => {
                // 只替换 data，binaryData 等字段原样保留。
                await updateResource('configmaps', name, namespace, {
                  ...data,
                  data: entries,
                })
                toast.success(
                  t('configMapDetail.dataSaved', 'ConfigMap 数据已保存')
                )
                await refetch()
              }}
            />
            {binaryDataCount > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t('common.fields.binaryData')}
                </p>
                <KeyValueDataViewer
                  entries={Object.fromEntries(
                    Object.entries(data.binaryData || {}).map(
                      ([key, value]) => [key, decodeBase64Utf8(value)]
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
    [binaryDataCount, canUpdate, data, name, namespace, refetch, t, totalCount]
  )

  // 只有存在保存处理器时外壳才渲染 YAML 标签页，因此
  // 它总是被传入；yamlEditable 决定是否允许保存。
  return (
    <ResourceDetailShell
      resourceType="configmaps"
      resourceLabel="ConfigMap"
      name={name}
      namespace={namespace}
      clonePath={`/configmaps/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/clone`}
      data={data}
      isLoading={isLoading}
      error={isError ? error : null}
      onRefresh={refetch}
      onSaveYaml={handleSaveYaml}
      yamlToolbar={(context) =>
        data ? (
          <ConfigMapYamlToolbar
            setYamlContent={context.setYamlContent}
            configMap={(yamlObject ?? data) as ConfigMap}
            showDecoded={showDecodedYaml}
            hasBinaryData={binaryDataCount > 0}
            onToggle={setShowDecodedYaml}
          />
        ) : null
      }
      headerActions={
        canUpdate ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(`/configmaps/${namespace}/${name}/edit`)}
          >
            <IconEdit className="w-4 h-4" />
            {t('common.actions.edit')}
          </Button>
        ) : null
      }
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
