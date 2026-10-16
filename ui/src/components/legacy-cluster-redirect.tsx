import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Cluster } from '@/types/api'
import { useCurrentClusterList } from '@/lib/api/cluster'
import {
  useRawLocation,
  useRawNavigate,
  withClusterPath,
} from '@/lib/cluster-path'
import { decodeClusterName, getCurrentCluster } from '@/lib/current-cluster'
import { Button } from '@/components/ui/button'

/**
 * 旧路径兼容跳转：`/deployments/...`、`/`（含 `/_clusters` 不带 slug）这类
 * 无集群段的地址，按「上次使用的集群（session→local）→ 默认集群 → 列表首个」
 * 补上 `/_clusters/<slug>` 后 replace 进去。
 * 集群必须登录后才能拉列表，所以只 ProtectedRoute 内使用。
 */
export function LegacyClusterRedirect() {
  const location = useRawLocation()
  const navigate = useRawNavigate()
  const { t } = useTranslation()
  const { data: clusters, isFetching } = useCurrentClusterList({
    enabled: true,
  })
  const [gaveUp, setGaveUp] = useState(false)

  useEffect(() => {
    // 用 isFetching 而不是 isLoading：挂载时缓存里可能还有「导入集群之前」的
    // 旧空列表（如初始化导入后跳回首页），此时 isLoading 为 false 但后台正在
    // 重新拉取——不能拿旧数据就宣布没有可用集群。
    if (isFetching || !clusters) {
      return
    }
    const slug = resolveRedirectSlug(clusters)
    if (!slug) {
      setGaveUp(true)
      return
    }
    const stripped = stripForRedirect(location.pathname)
    navigate(
      `${withClusterPath(stripped === '/' ? '' : stripped, slug)}${location.search}${location.hash}`,
      { replace: true }
    )
  }, [clusters, isFetching, location, navigate])

  if (gaveUp) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-lg font-semibold">
          {t('cluster.unavailable.title')}
        </p>
        <p className="text-sm text-muted-foreground">
          {t('cluster.unavailable.noCluster')}
        </p>
        <Button
          variant="outline"
          onClick={() => window.location.assign('/login')}
        >
          {t('session.signInAgain')}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex min-h-svh items-center justify-center gap-2 text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      <span className="text-sm">{t('cluster.unavailable.redirecting')}</span>
    </div>
  )
}

/** 旧地址里可能残留 `/_clusters`（不带 slug 或只是根路径），剥掉后再补。 */
function stripForRedirect(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean)
  if (segments[0] === '_clusters') {
    return `/${segments.slice(1).join('/')}`
  }
  return pathname
}

function resolveRedirectSlug(clusters: Cluster[]): string | null {
  const lastUsed = decodeClusterName(getCurrentCluster())
  const byLastUsed = lastUsed
    ? clusters.find((cluster) => cluster.name === lastUsed)
    : undefined
  const target = byLastUsed ?? clusters.find((c) => c.isDefault) ?? clusters[0]
  return target?.slug ?? null
}
