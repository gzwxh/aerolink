/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

import { Cluster } from '@/types/api'
import { useCurrentClusterList } from '@/lib/api/cluster'
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
import { ClusterSwitchConfirmDialog } from '@/components/cluster-switch-confirm-dialog'

interface ClusterContextType {
  clusters: Cluster[]
  currentCluster: string | null
  setCurrentCluster: (clusterName: string) => void
  isLoading: boolean
  isSwitching?: boolean
  error: Error | null
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
  const [isSwitching, setIsSwitching] = useState(false)
  // 有未保存草稿时挂起的目标集群：确认弹窗点了「切换集群」才真正执行。
  const [pendingCluster, setPendingCluster] = useState<string | null>(null)
  const { t } = useTranslation()
  const navigate = useNavigate()
  // 切换开始时所在的页面路径：用于判断是否需要从创建/详情页退回列表页。
  const { pathname } = useLocation()
  const queryClient = useQueryClient()
  const { refetch: refetchClusters } = useCurrentClusterList({
    enabled: false,
  })

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

  useEffect(() => {
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
  }, [clusters, currentCluster])

  const setCurrentCluster = async (clusterName: string) => {
    if (clusterName === currentCluster || isSwitching) {
      return
    }

    // 创建表单 / YAML 编辑里有未保存草稿时，先弹确认（见下方的确认弹窗
    // 与 performSwitch），确认后才执行切换。
    if (hasUnsavedEdits()) {
      setPendingCluster(clusterName)
      return
    }
    await performSwitch(clusterName)
  }

  const performSwitch = async (clusterName: string) => {
    setIsSwitching(true)
    setCurrentClusterState(clusterName)
    persistCurrentCluster(clusterName)

    try {
      await queryClient.invalidateQueries({
        predicate: (query) => {
          const key = query.queryKey[0] as string
          return !['user', 'auth', 'clusters'].includes(key)
        },
      })
      toast.success(
        t('cluster.switched', {
          name: clusterName,
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
    } catch (switchError) {
      console.error('Failed to switch cluster:', switchError)
    } finally {
      setIsSwitching(false)
    }
    setPendingCluster(null)
  }

  const value: ClusterContextType = {
    clusters,
    currentCluster,
    setCurrentCluster,
    isLoading,
    isSwitching,
    error,
  }

  return (
    <ClusterContext.Provider value={value}>
      {children}
      {/* 确认弹窗挂在 Provider 上：切换成功后路由会跳回列表页，
          弹窗不能跟着被卸载的页面一起消失。 */}
      <ClusterSwitchConfirmDialog
        open={pendingCluster !== null}
        isSwitching={isSwitching}
        onCancel={() => setPendingCluster(null)}
        onConfirm={() => {
          if (pendingCluster) {
            // 确认丢弃后先让各编辑入口收回草稿：弹窗类会把弹窗关掉
            // （留在列表页时不会跳转，不关就会带着上一个集群的草稿）。
            discardUnsavedEdits()
            void performSwitch(pendingCluster)
          }
        }}
      />
    </ClusterContext.Provider>
  )
}
