import { Link, LinkProps, Navigate, NavigateProps } from 'react-router-dom'

import { useCurrentClusterSlug, withClusterPath } from '@/lib/cluster-path'

/**
 * 集群前缀版的 Link / Navigate：`to` 继续写**不带前缀的绝对业务路径**
 * （/deployments/...），这里统一补 `/_clusters/<slug>`。
 * 全站导航必须走这两个包装（见 @/lib/cluster-path 的说明），避免漏带集群段。
 */

function prefixedTo(to: NavigateProps['to'], slug: string | null) {
  if (typeof to === 'string') {
    return withClusterPath(to, slug)
  }
  return { ...to, pathname: withClusterPath(to.pathname ?? '/', slug) }
}

export function ClusterLink({ to, ...props }: LinkProps) {
  const slug = useCurrentClusterSlug()
  return <Link {...props} to={prefixedTo(to, slug)} />
}

export function ClusterNavigate(props: NavigateProps) {
  const slug = useCurrentClusterSlug()
  return <Navigate {...props} to={prefixedTo(props.to, slug)} />
}
