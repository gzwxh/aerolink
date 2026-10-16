import { useEffect, useMemo, useState } from 'react'
import { IconEdit } from '@tabler/icons-react'
import * as yaml from 'js-yaml'
import { Secret } from 'kubernetes-types/core/v1'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { updateResource, useResource } from '@/lib/api'
import {
  decodeBase64Utf8,
  encodeBase64Map,
  encodeBase64Utf8,
} from '@/lib/base64'
import { useClusterNavigate } from '@/lib/cluster-path'
import { useCan } from '@/hooks/use-can'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EventTable } from '@/components/event-table'
import { KeyValueDataViewer } from '@/components/key-value-data-viewer'
import { RelatedResourcesTable } from '@/components/related-resource-table'
import { ResourceHistoryTable } from '@/components/resource-history-table'
import { ResourceOverview } from '@/components/resource-overview'

import {
  ResourceDetailShell,
  type ResourceDetailShellTab,
} from './resource-detail-shell'

function getDecodedYamlContent(secret: Secret, showDecodedYaml: boolean) {
  const showSecret = { ...secret } as Secret
  if (showDecodedYaml) {
    if (showSecret.data) {
      const decodedData: Record<string, string> = {}
      Object.entries(showSecret.data).forEach(([key, value]) => {
        decodedData[key] = decodeBase64Utf8(value)
      })
      showSecret.stringData = decodedData
      showSecret.data = undefined
    }
  } else if (showSecret.stringData) {
    const data: Record<string, string> = {}
    Object.entries(showSecret.stringData).forEach(([key, value]) => {
      data[key] = encodeBase64Utf8(value)
    })
    showSecret.data = data
    showSecret.stringData = undefined
  }

  return yaml.dump(showSecret, { indent: 2 })
}

function SecretYamlToolbar({
  setYamlContent,
  secret,
  showDecodedYaml,
  onToggle,
}: {
  setYamlContent: (value: string) => void
  secret: Secret
  showDecodedYaml: boolean
  onToggle: (next: boolean) => void
}) {
  const { t } = useTranslation()

  useEffect(() => {
    setYamlContent(getDecodedYamlContent(secret, showDecodedYaml))
  }, [secret, setYamlContent, showDecodedYaml])

  if (!secret.data || Object.keys(secret.data).length === 0) {
    return null
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => onToggle(!showDecodedYaml)}
    >
      {showDecodedYaml
        ? t('secretDetail.showBase64', '显示 Base64')
        : t('secretDetail.decodeValues', '解码明文')}
    </Button>
  )
}

export function SecretDetail(props: { namespace: string; name: string }) {
  const { namespace, name } = props
  const { t } = useTranslation()
  const navigate = useClusterNavigate()
  const can = useCan()
  const [showDecodedYaml, setShowDecodedYaml] = useState(false)
  // 数据条目的增删改属于写操作，没有 update 权限时只读展示。
  const canUpdate = can('secrets', 'update', { namespace })

  const { data, isLoading, isError, error, refetch } = useResource(
    'secrets',
    name,
    namespace
  )
  const dataCount = data ? Object.keys(data.data || {}).length : 0
  const dataSize = data
    ? Object.values(data.data || {}).reduce(
        (total, value) => total + value.length,
        0
      )
    : 0

  const handleSaveYaml = async (content: Secret) => {
    await updateResource('secrets', name, namespace, content)
    toast.success(t('common.messages.yamlSaved'))
    await refetch()
  }

  const tabs = useMemo<ResourceDetailShellTab<Secret>[]>(
    () => [
      {
        value: 'data',
        label: (
          <>
            {t('common.fields.data')}
            {data && <Badge variant="secondary">{dataCount}</Badge>}
          </>
        ),
        content: data ? (
          <KeyValueDataViewer
            entries={data.data || {}}
            sensitive
            base64Encoded
            emptyMessage={t('keyValueDataViewer.noDataEntries', '暂无数据条目')}
            canEdit={canUpdate}
            onSave={async (entries) => {
              // 组件回传的是解码后的明文，写回 k8s 需要重新 base64 编码。
              await updateResource('secrets', name, namespace, {
                ...data,
                data: encodeBase64Map(entries),
              })
              toast.success(t('secretDetail.dataSaved', 'Secret 数据已保存'))
              await refetch()
            }}
          />
        ) : null,
      },
      {
        value: 'related',
        label: t('common.tabs.related'),
        content: (
          <RelatedResourcesTable
            resource="secrets"
            name={name}
            namespace={namespace}
          />
        ),
      },
      {
        value: 'events',
        label: t('common.tabs.events'),
        content: (
          <EventTable resource="secrets" name={name} namespace={namespace} />
        ),
      },
      {
        value: 'history',
        label: t('common.tabs.history'),
        content: data ? (
          <ResourceHistoryTable
            resourceType="secrets"
            name={name}
            namespace={namespace}
            currentResource={data}
          />
        ) : null,
      },
    ],
    [canUpdate, data, dataCount, name, namespace, refetch, t]
  )

  return (
    <ResourceDetailShell
      resourceType="secrets"
      resourceLabel="Secret"
      name={name}
      namespace={namespace}
      clonePath={`/secrets/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/clone`}
      data={data}
      isLoading={isLoading}
      error={isError ? error : null}
      onRefresh={refetch}
      onSaveYaml={handleSaveYaml}
      headerActions={
        canUpdate ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(`/secrets/${namespace}/${name}/edit`)}
          >
            <IconEdit className="w-4 h-4" />
            {t('common.actions.edit')}
          </Button>
        ) : null
      }
      yamlToolbar={(context) => (
        <SecretYamlToolbar
          setYamlContent={context.setYamlContent}
          secret={data as Secret}
          showDecodedYaml={showDecodedYaml}
          onToggle={setShowDecodedYaml}
        />
      )}
      overview={
        data ? (
          <ResourceOverview
            resourceType="secrets"
            name={name}
            namespace={namespace}
            metadata={data.metadata}
            fields={[
              {
                label: t('common.fields.type'),
                value: <Badge variant="outline">{data.type || 'Opaque'}</Badge>,
              },
              {
                label: t('common.fields.keys'),
                value: dataCount,
              },
              {
                label: t('common.fields.size'),
                value: `${dataSize} ${t('common.fields.bytes')}`,
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
      preYamlTabs={tabs.slice(0, 1)}
      extraTabs={tabs.slice(1)}
    />
  )
}
