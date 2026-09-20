import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { useResources } from '@/lib/api'
import { servicesForWorkload } from '@/lib/k8s'
import { Badge } from '@/components/ui/badge'

/**
 * 「本工作负载关联的 Service」的只读列表。
 *
 * 关联由 Service 自己的选择器决定（它选中本工作负载的 Pod 标签），所以这里只展示
 * Service 名称：创建与修改都在「服务」页面进行，点击名称跳到那里，并用服务页面的搜索
 * 只显示这一个（`/services/<namespace>?search=<name>`）。
 */
export function AssociatedServices({
  namespace,
  workloadName,
  labels,
}: {
  namespace: string
  /** 工作负载名，用于识别同名前缀的 Service。 */
  workloadName?: string
  /** 工作负载 Pod 模板的标签，用于按 selector 判定关联。 */
  labels: Record<string, string>
}) {
  const { t } = useTranslation()
  const { data: services = [] } = useResources<'services'>(
    'services',
    namespace,
    {
      staleTime: 30_000,
    }
  )

  const associated = useMemo(
    () => servicesForWorkload(services, { name: workloadName, labels }),
    [services, workloadName, labels]
  )

  return (
    <div className="space-y-1.5">
      <h4 className="text-base font-medium">
        {t('containerAdv.associatedServices', '关联的 Service')}
      </h4>
      {associated.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'containerAdv.noAssociatedServices',
            '暂无关联的 Service。需要暴露这些端口时，请在「服务」页面创建 Service 并选中本工作负载的 Pod 标签。'
          )}
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {associated.map((service) => {
            const name = service.metadata?.name || ''
            const serviceNamespace = service.metadata?.namespace || namespace
            return (
              <Link
                key={`${serviceNamespace}/${name}`}
                to={`/services/${encodeURIComponent(serviceNamespace)}?search=${encodeURIComponent(name)}`}
                title={t('containerAdv.openService', {
                  name,
                  defaultValue: '在服务页面查看 {{name}}',
                })}
              >
                <Badge variant="outline" className="font-mono hover:bg-accent">
                  {name}
                </Badge>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
