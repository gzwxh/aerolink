import { useMemo } from 'react'
import { IconLoader } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router-dom'

import { RelatedResources, ResourceType } from '@/types/api'
import { useRelatedResources } from '@/lib/api'
import { getCRDResourcePath, isStandardK8sResource } from '@/lib/k8s'
import {
  getResourceDetailPath,
  getResourceMetadata,
} from '@/lib/resource-catalog'

import { Column, SimpleTable } from './simple-table'
import { Badge } from './ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'

export function RelatedResourcesTable(props: {
  resource: ResourceType
  name: string
  namespace?: string
}) {
  const { t } = useTranslation()
  const { resource, name, namespace } = props

  const { data: relatedResources, isLoading } = useRelatedResources(
    resource,
    name,
    namespace
  )

  const relatedColumns = useMemo(
    (): Column<RelatedResources>[] => [
      {
        header: t('common.fields.type', '类型'),
        accessor: (rs: RelatedResources) => rs.type,
        align: 'left',
        cell: (value: unknown) => (
          <Badge className="capitalize">{value as string}</Badge>
        ),
      },
      {
        header: t('common.fields.name', '名称'),
        accessor: (rs: RelatedResources) => rs,
        cell: (value: unknown) => {
          const rs = value as RelatedResources
          return <RelatedResourceCell rs={rs} />
        },
      },
    ],
    [t]
  )

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <IconLoader className="animate-spin mr-2" />
        {t('common.messages.loading', '加载中...')}
      </div>
    )
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('common.tabs.related', '相关资源')}</CardTitle>
      </CardHeader>
      <CardContent>
        <SimpleTable
          data={relatedResources || []}
          columns={relatedColumns}
          storageKey="aerolink-related-resources-columnSizing"
          emptyMessage={t('common.messages.noData', '暂无数据')}
        />
      </CardContent>
    </Card>
  )
}

function RelatedResourceCell({ rs }: { rs: RelatedResources }) {
  const [searchParams] = useSearchParams()
  const metadata = getResourceMetadata(rs.type)
  const isIframe = searchParams.get('iframe') === 'true'

  const path = useMemo(() => {
    if (isStandardK8sResource(rs.type)) {
      return getResourceDetailPath(
        metadata?.type || rs.type,
        rs.name,
        rs.namespace
      )
    }
    return getCRDResourcePath(rs.type, rs.apiVersion!, rs.namespace, rs.name)
  }, [metadata?.type, rs])

  // 一律**跳转**，不再弹窗：相关资源就是「去那条资源上看一眼」，套一层弹窗时地址栏与
  // 面包屑都不变，既没法在新标签页打开，也没法分享或后退，反而更容易迷失。
  // iframe 模式（详情页本身被嵌在别的页面里）继续带 `iframe=true` 保持一致。
  return (
    <Link
      to={isIframe ? `${path}?iframe=true` : path}
      className="font-medium app-link cursor-pointer"
    >
      {rs.name}
    </Link>
  )
}
