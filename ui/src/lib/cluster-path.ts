import { useCallback } from 'react'
import {
  Location,
  NavigateOptions,
  To,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom'

/**
 * 集群信息进入浏览器地址栏：URL 前缀 `/_clusters/<slug>` 的唯一操作入口。
 *
 * 注意与 API 路径的区分：`lib/current-cluster.ts` 的 `withCurrentClusterPath()`
 * 产出的是**后端 API** 路径 `/_clusters/<编码后的集群名>/...`（选集群的请求头/
 * 路径参数口径）；本文件产出的是**前端导航**路径 `/_clusters/<slug>/...`。
 * 两者文本同形、内容不同源，绝不能混用
 * （见 docs/dev/plans/2026-10-15-集群信息进入浏览器地址栏.md §3.1/§3.4）。
 *
 * 全站禁止直接从 react-router-dom 引入 Link / Navigate / useNavigate /
 * useLocation（ESLint no-restricted-imports 护栏），一律走这里的包装：
 * `<ClusterLink>`、`<ClusterNavigate>`（@/components/cluster-link）、
 * `useClusterNavigate()`、`useClusterLocation()`。
 * 组件内部继续写**不带前缀的绝对业务路径**（/deployments/...），包装层统一补前缀。
 */
export const CLUSTER_PATH_SEGMENT = '_clusters'

/** 取路径里的集群 slug；路径不带前缀（/login、/setup 等）时返回 null。 */
export function getClusterSlugFromPath(pathname: string): string | null {
  const segments = pathname.split('/').filter(Boolean)
  if (segments[0] !== CLUSTER_PATH_SEGMENT || segments.length < 2) {
    return null
  }
  return segments[1]
}

/**
 * 剥掉 `/_clusters/<slug>` 前缀，返回业务路径。
 * 无前缀时原样返回；前缀后无内容时返回 '/'。
 */
export function stripClusterPrefix(pathname: string): string {
  if (getClusterSlugFromPath(pathname) === null) {
    return pathname
  }
  const segments = pathname.split('/').filter(Boolean)
  return `/${segments.slice(2).join('/')}`
}

/**
 * 给业务路径补 `/_clusters/<slug>` 前缀。
 * slug 缺省时需要调用方显式传入（纯函数不读上下文）；路径已带前缀时原样返回。
 */
export function withClusterPath(path: string, slug?: string | null): string {
  const normalized = path.startsWith('/') ? path : `/${path}`
  if (getClusterSlugFromPath(normalized) !== null) {
    return normalized
  }
  if (!slug) {
    return normalized
  }
  return `/${CLUSTER_PATH_SEGMENT}/${slug}${normalized === '/' ? '' : normalized}`
}

/** 把路径里的集群 slug 换成新的（保留当前页面）；无前缀路径直接落到新集群首页。 */
export function swapClusterSlug(pathname: string, newSlug: string): string {
  const stripped = stripClusterPrefix(pathname)
  return withClusterPath(stripped === '/' ? '' : stripped, newSlug)
}

/** 当前路由的集群 slug（App 挂在 /_clusters/:clusterSlug 下，拿不到说明不在集群页）。 */
export function useCurrentClusterSlug(): string | null {
  const params = useParams()
  return params.clusterSlug ?? null
}

/**
 * pathname 已剥掉集群前缀的 useLocation。
 * 组件里的「当前页是 /settings 还是 /deployments」判断都按剥前缀后的值来。
 */
export function useClusterLocation(): Location {
  const location = useLocation()
  return { ...location, pathname: stripClusterPrefix(location.pathname) }
}

/**
 * 自动补集群前缀的 useNavigate。数字 delta（navigate(-1)）原样透传；
 * 字符串/对象目标补前缀。需要**不补前缀**的原始导航（应用内历史栈回放完整
 * pathname、跳登录页等）用 useRawNavigate，仅限集群路径工具内部使用。
 */
export function useClusterNavigate() {
  const navigate = useNavigate()
  const slug = useCurrentClusterSlug()
  return useCallback(
    (to: To | number, options?: NavigateOptions) => {
      // 不把 undefined 的第二参传下去：调用方对 navigate(path) 的断言（如测试）
      // 会因为多出的 undefined 而失败。
      if (typeof to === 'number') {
        navigate(to)
        return
      }
      if (typeof to === 'string') {
        const target = withClusterPath(to, slug)
        if (options) {
          navigate(target, options)
        } else {
          navigate(target)
        }
        return
      }
      const target = {
        ...to,
        pathname: withClusterPath(to.pathname ?? '/', slug),
      }
      if (options) {
        navigate(target, options)
      } else {
        navigate(target)
      }
    },
    [navigate, slug]
  )
}

/** 原始 useNavigate：只给需要操作完整路由地址的场景（历史栈、无前缀页面）使用。 */
export function useRawNavigate() {
  return useNavigate()
}

/** 原始 useLocation：只给需要完整路由地址的场景（登录回跳、历史栈）使用。 */
export function useRawLocation() {
  return useLocation()
}
