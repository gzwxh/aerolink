import { useTranslation } from 'react-i18next'

import { useClusterLocation } from '@/lib/cluster-path'
import { getResourceCatalogEntry } from '@/lib/resource-catalog'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { ClusterLink } from '@/components/cluster-link'

interface BreadcrumbSegment {
  label: string
  href?: string
}

export function DynamicBreadcrumb() {
  const location = useClusterLocation()
  const { t } = useTranslation()

  const generateBreadcrumbs = (): BreadcrumbSegment[] => {
    const pathSegments = location.pathname.split('/').filter(Boolean)
    const breadcrumbs: BreadcrumbSegment[] = []

    if (pathSegments.length === 0) {
      return breadcrumbs
    }

    // 创建面包屑项的辅助函数
    const createResourceBreadcrumb = (
      label: string,
      href?: string
    ): BreadcrumbSegment => {
      if (label === 'pvcs') {
        return { label: t('sidebar.short.pvcs'), href }
      }

      if (label === 'settings') {
        return { label: t('settings.title', 'System Settings'), href }
      }

      if (label === 'about') {
        return { label: t('about.pageTitle'), href }
      }

      const resource = getResourceCatalogEntry(label)
      if (!resource) {
        return { label, href }
      }

      const titleKey = 'titleKey' in resource ? resource.titleKey : undefined
      const shortLabel =
        'shortLabel' in resource ? resource.shortLabel : undefined

      return {
        label: titleKey
          ? t(titleKey, {
              defaultValue: shortLabel || resource.pluralLabel,
            })
          : shortLabel || resource.pluralLabel,
        href,
      }
    }

    // 为各路径段获取安全链接的辅助函数
    const getSafeLink = (index: number): string | undefined => {
      const isLastSegment = index === pathSegments.length - 1
      if (isLastSegment) return undefined

      // 处理不同的路径模式
      if (pathSegments[0] === 'crds') {
        if (index === 0) return '/crds'
        if (index === 1) return `/crds/${pathSegments[1]}`
        if (index === 2) return `/crds/${pathSegments[1]}` // namespace links back to CRD list
        return undefined
      } else {
        // 普通资源：命名空间应链接回资源列表
        const isNamespace = pathSegments.length === 3 && index === 1
        if (isNamespace) return `/${pathSegments[0]}`
        return `/${pathSegments.slice(0, index + 1).join('/')}`
      }
    }

    const shouldHideLastSegment =
      pathSegments[0] === 'crds'
        ? pathSegments.length >= 3
        : pathSegments.length >= 2
    const visibleSegments = shouldHideLastSegment
      ? pathSegments.slice(0, -1)
      : pathSegments

    // 为每个可见的路径段生成面包屑
    visibleSegments.forEach((segment, index) => {
      const href = getSafeLink(index)
      breadcrumbs.push(
        index === 0
          ? createResourceBreadcrumb(segment, href)
          : { label: segment, href }
      )
    })

    return breadcrumbs
  }

  const breadcrumbs = generateBreadcrumbs()

  // 顶栏空间被右侧那组元素（公告栏、集群徽章、搜索）挤窄时，面包屑**不能逐字换行**：
  // 中文没有分词点，会被拆成「系 / 统 / 设 / 置」竖着排（真机上就是这个样子）。
  // 空间不够时宁可裁掉一部分，也不要拆成竖排；`min-w-0` 让它能收缩，
  // `truncate` 是溢出时的兜底。
  return (
    <Breadcrumb className="hidden min-w-0 truncate md:block">
      <BreadcrumbList>
        {breadcrumbs.map((crumb, index) => (
          <div key={index} className="flex items-center">
            {index > 0 && <BreadcrumbSeparator />}
            <BreadcrumbItem>
              {crumb.href && index < breadcrumbs.length - 1 ? (
                <BreadcrumbLink asChild>
                  <ClusterLink to={crumb.href}>{crumb.label}</ClusterLink>
                </BreadcrumbLink>
              ) : (
                <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
              )}
            </BreadcrumbItem>
          </div>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  )
}
