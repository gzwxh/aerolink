import { useQuery } from '@tanstack/react-query'

import { apiClient, authApiClient } from '../api-client'
import { fetchBootstrap, useBootstrap } from './bootstrap'
import { fetchAPI } from './shared'

// 初始化 API 类型
export interface InitCheckResponse {
  initialized: boolean
  step: number
}

// 初始化 API 函数
export const fetchInitCheck = async (): Promise<InitCheckResponse> => {
  return (await fetchBootstrap()).setup
}

export const useInitCheck = () => {
  const query = useBootstrap({ staleTime: 0 })
  return {
    ...query,
    data: query.data?.setup,
  }
}

// 版本信息
export interface VersionInfo {
  version: string
  buildDate: string
  commitId: string
  hasNewVersion: boolean
  releaseUrl: string
}

export const fetchVersionInfo = (): Promise<VersionInfo> => {
  return fetchAPI<VersionInfo>('/version')
}

export const useVersionInfo = () => {
  return useQuery({
    queryKey: ['version-info'],
    queryFn: fetchVersionInfo,
    staleTime: 1000 * 60 * 60, // 1 hour
    refetchInterval: 0, // No auto-refresh
  })
}

// 首次安装时的用户注册
export interface CreateUserRequest {
  username: string
  password: string
  name?: string
}

export const createSuperUser = async (
  userData: CreateUserRequest
): Promise<void> => {
  await authApiClient.post('/auth/setup/create_super_user', userData)
}

// 首次安装时的集群导入
export interface ImportClustersRequest {
  config: string
  inCluster?: boolean
}

export const importClusters = async (
  request: ImportClustersRequest
): Promise<{ message: string; importedCount: number }> => {
  return await apiClient.post('/admin/clusters/import', request)
}
