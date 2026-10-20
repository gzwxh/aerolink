import { useQuery } from '@tanstack/react-query'

import { apiClient, authApiClient } from '../api-client'
import { encryptSecrets } from '../credential-cipher'
import { encryptRequestBody } from '../transport-envelope'
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

// 版本信息（只有本地构建信息，不含「是否有新版本」：本分支不查询上游发布）
export interface VersionInfo {
  version: string
  buildDate: string
  commitId: string
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
  const { password, ...rest } = userData
  const encrypted = await encryptSecrets({ password })
  await authApiClient.post('/auth/setup/create_super_user', {
    ...rest,
    ...encrypted,
  })
}

// 首次安装时的集群导入
export interface ImportClustersRequest {
  config: string
  inCluster?: boolean
  /** 按 context 名逐行指定 URL 短名；未指定的 context 由后端自动生成。 */
  slugs?: Record<string, string>
}

export const importClusters = async (
  request: ImportClustersRequest
): Promise<{ message: string; importedCount: number }> => {
  // 一次导入多份 kubeconfig，同样走信封加密。
  return await apiClient.post(
    '/admin/clusters/import',
    await encryptRequestBody(request)
  )
}
