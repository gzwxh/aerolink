/* eslint-disable react-refresh/only-export-components */
import React, {
  createContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Cluster } from '@/types/api'
import { useCurrentClusterList } from '@/lib/api/cluster'
import {
  swapClusterSlug,
  useClusterLocation,
  useClusterNavigate,
  useCurrentClusterSlug,
  useRawNavigate,
} from '@/lib/cluster-path'
import {
  clearCurrentCluster,
  getCurrentCluster,
  setCurrentCluster as persistCurrentCluster,
} from '@/lib/current-cluster'
import {
  getResourceCatalogEntry,
  isClusterScopedResource,
} from '@/lib/resource-catalog'
import { discardUnsavedEdits, hasUnsavedEdits } from '@/lib/unsaved-edits'
import { setClusterConfirmPolicies } from '@/lib/write-confirm'
import { ClusterSwitchConfirmDialog } from '@/components/cluster-switch-confirm-dialog'

interface ClusterContextType {
  clusters: Cluster[]
  currentCluster: string | null
  setCurrentCluster: (clusterName: string) => void
  isLoading: boolean
  isSwitching?: boolean
  error: Error | null
  /** URL 里的集群段解析失败（无权限 / 集群不存在），由 ClusterGate 渲染错误页。 */
  slugError: boolean
}

export const ClusterContext = createContext<ClusterContextType | undefined>(
  undefined
)

/**
 * 切换集群后应回退到的列表页：创建页与详情页的 URL 携带的是上一个集群的上下文
 * （命名空间 / 资源名在新集群可能不存在），停留在上面只会看到错位的数据。
 * 返回 null 表示无需跳转：顶层列表、按命名空间过滤的列表，以及
 * 设置 / 账号等非资源页。
 */
function clusterSwitchFallback(pathname: string): string | null {
  const segments = pathname.split('/').filter(Boolean)
  const [root, second] = segments
  if (!root || segments.length <= 1) {
    return null
  }
  if (root === 'crds') {
    // /crds/<crd> 本身就是该 CRD 的列表页；CR 详情回退到它。
    return segments.length >= 3 ? `/crds/${second}` : null
  }
  if (root === 'charts') {
    return '/charts'
  }
  // 只处理资源目录认得的路径根，避免把未知页面也重定向。
  if (!getResourceCatalogEntry(root)) {
    return null
  }
  if (second === 'create' || segments.length >= 3) {
    return `/${root}`
  }
  // 集群级资源两段即详情（/nodes/node-1）；命名空间级两段是按命名空间过滤的列表，保留。
  if (isClusterScopedResource(root)) {
    return `/${root}`
  }
  return null
}

export const ClusterProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [clusters, setClusters] = useState<Cluster[]>([])
  const [currentCluster, setCurrentClusterState] = useState<string | null>(
    getCurrentCluster()
  )
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [slugError, setSlugError] = useState(false)
  const [isSwitching, setIsSwitching] = useState(false)
  // 有未保存草稿时挂起的目标集群 slug：确认弹窗点了「切换集群」才真正执行。
  const [pendingSlug, setPendingSlug] = useState<string | null>(null)
  const { t } = useTranslation()
  // fallback 跳转走包装导航（自动补前缀）；切换集群算出完整目标地址后走原始导航。
  const navigate = useClusterNavigate()
  const rawNavigate = useRawNavigate()
  // URL 是集群上下文的唯一事实源。
  const clusterSlug = useCurrentClusterSlug()
  // 剥掉集群前缀的业务路径：fallback 判定与切集群换段都以它为准。
  const { pathname } = useClusterLocation()
  const queryClient = useQueryClient()
  const { refetch: refetchClusters } = useCurrentClusterList({
    enabled: false,
  })

  const clusterBySlug = useMemo(
    () =>
      clusterSlug
        ? (clusters.find((cluster) => cluster.slug === clusterSlug) ?? null)
        : null,
    [clusterSlug, clusters]
  )

  useEffect(() => {
    if (currentCluster) {
      persistCurrentCluster(currentCluster)
      return
    }
    clearCurrentCluster()
  }, [currentCluster])

  useEffect(() => {
    let cancelled = false

    const bootstrap = async () => {
      setIsLoading(true)
      const result = await refetchClusters()
      if (cancelled) {
        return
      }

      if (result.data) {
        setClusters(result.data)
        setError(null)
      } else {
        setClusters([])
        setError(result.error instanceof Error ? result.error : null)
      }
      setIsLoading(false)
    }

    void bootstrap()

    return () => {
      cancelled = true
    }
  }, [refetchClusters])

  // 上一轮 invalidate/导航期间的切换标记收尾。
  const resolvingRef = useRef(false)

  // 集群解析：URL slug → 集群对象 → 当前集群。一切集群上下文都从这里出来。
  //
  // 必须是 useLayoutEffect：isLoading 变 false 的那一次提交里，子组件会同时挂载，
  // 而 React 的 effect 顺序是「子先父后」——用 useEffect 的话，子组件（react-query）
  // 的订阅与首请求会先跑，此时持久化还没发生，首个集群作用域请求就会漏掉
  // `x-cluster-name`（后端按默认集群处理，深链到非默认集群时看到的是别人的数据）。
  // 布局 effect 在同一提交内、早于任何 passive effect 执行，因此能兑现 I1 约束：
  // 子组件发请求前，存储里已经是 URL 里的那个集群。
  useLayoutEffect(() => {
    if (isLoading) {
      return
    }
    if (error) {
      // 集群列表都拉不到：维持原有 error 展示路径，不做 slug 判定。
      return
    }

    if (clusterSlug) {
      if (!clusterBySlug) {
        // 深链一个无权限 / 不存在的集群：fail-closed，交给 ClusterGate 错误页。
        setSlugError(true)
        setIsSwitching(false)
        return
      }
      setSlugError(false)
      if (resolvingRef.current) {
        resolvingRef.current = false
        setIsSwitching(false)
      }
      if (clusterBySlug.name !== currentCluster) {
        // 换集群（首次进入 / 切换导航）：
        // 1. 必须先固化存储再让子组件发请求（子组件在 isLoading 结束前不会挂载，
        //    而这里同步完成持久化，见方案 §4 的 I1 约束）。
        setCurrentClusterState(clusterBySlug.name)
        persistCurrentCluster(clusterBySlug.name)
        void queryClient.invalidateQueries({
          predicate: (query) => {
            const key = query.queryKey[0] as string
            return !['user', 'auth', 'clusters'].includes(key)
          },
        })
        toast.success(
          t('cluster.switched', {
            name: clusterBySlug.name,
            defaultValue: '已切换到集群：{{name}}',
          }),
          { id: 'cluster-switch' }
        )
        // 创建/详情 URL 携带的是上一个集群的上下文，停留在上面只会显示错位的
        // 数据：切换成功后退回对应资源的列表页（列表/设置等页面不受影响）。
        const fallback = clusterSwitchFallback(pathname)
        if (fallback) {
          navigate(fallback, { replace: true })
        }
      }
      return
    }

    // 无前缀页面（理论上是兜底路由的瞬间状态）：维持旧行为——
    // 无集群选择则挑默认；记录的集群不在可见列表里则清掉。
    if (clusters.length > 0 && !currentCluster) {
      const defaultCluster = clusters.find((cluster) => cluster.isDefault)
      const nextCluster = defaultCluster
        ? defaultCluster.name
        : clusters[0].name
      setCurrentClusterState(nextCluster)
      persistCurrentCluster(nextCluster)
    }

    if (
      currentCluster &&
      clusters.length > 0 &&
      !clusters.some((cluster) => cluster.name === currentCluster)
    ) {
      setCurrentClusterState(null)
      clearCurrentCluster()
    }
  }, [
    clusterBySlug,
    clusterSlug,
    clusters,
    currentCluster,
    error,
    isLoading,
    navigate,
    pathname,
    queryClient,
    t,
  ])

  // 把集群的写操作确认开关同步给模块级缓存：拦截发生在 api-client（非 React 模块）里，
  // 读不到这里的 state（见 lib/write-confirm.ts）。
  useEffect(() => {
    setClusterConfirmPolicies(clusters)
  }, [clusters])

  const setCurrentCluster = (clusterName: string) => {
    if (isSwitching) {
      return
    }
    const target = clusters.find((cluster) => cluster.name === clusterName)
    const targetSlug = target?.slug
    if (!targetSlug || targetSlug === clusterSlug) {
      return
    }

    // 创建表单 / YAML 编辑里有未保存草稿时，先弹确认（见下方的确认弹窗），
    // 确认后才执行切换。
    if (hasUnsavedEdits()) {
      setPendingSlug(targetSlug)
      return
    }
    performSwitch(targetSlug)
  }

  const performSwitch = (targetSlug: string) => {
    setIsSwitching(true)
    resolvingRef.current = true
    setPendingSlug(null)
    // 真正的上下文固化、缓存失效与 fallback 跳转都由 URL slug 变化触发
    // （上面的解析 effect）：这里只负责导航，避免双份状态。
    rawNavigate(swapClusterSlug(pathname, targetSlug))
  }

  const value: ClusterContextType = {
    clusters,
    currentCluster,
    setCurrentCluster,
    isLoading,
    isSwitching,
    error,
    slugError,
  }

  return (
    <ClusterContext.Provider value={value}>
      {children}
      {/* 确认弹窗挂在 Provider 上：切换成功后路由会跳回列表页，
          弹窗不能跟着被卸载的页面一起消失。 */}
      <ClusterSwitchConfirmDialog
        open={pendingSlug !== null}
        isSwitching={isSwitching}
        onCancel={() => setPendingSlug(null)}
        onConfirm={() => {
          if (pendingSlug) {
            // 确认丢弃后先让各编辑入口收回草稿：弹窗类会把弹窗关掉
            // （留在列表页时不会跳转，不关就会带着上一个集群的草稿）。
            discardUnsavedEdits()
            performSwitch(pendingSlug)
          }
        }}
      />
    </ClusterContext.Provider>
  )
}
