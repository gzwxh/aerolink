import { useQuery } from '@tanstack/react-query'

import {
  APIKey,
  AuditLogResponse,
  Cluster,
  FetchUserListResponse,
  LoginLogResponse,
  OAuthProvider,
  PasswordChangeLogResponse,
  Role,
  UserItem,
} from '@/types/api'

import { apiClient } from '../api-client'
import { fetchAPI } from './shared'

export interface ClusterCreateRequest {
  name: string
  description?: string
  config?: string
  prometheusURL?: string
  inCluster?: boolean
  clusterAgent?: boolean
  isDefault?: boolean
}

export interface ClusterUpdateRequest extends ClusterCreateRequest {
  enabled?: boolean
}

// Get cluster list for management
export const fetchClusterList = (): Promise<Cluster[]> => {
  return fetchAPI<Cluster[]>('/admin/clusters/')
}

export const useClusterList = (options?: {
  staleTime?: number
  refetchInterval?: number | false
}) => {
  return useQuery({
    queryKey: ['cluster-list'],
    queryFn: fetchClusterList,
    staleTime: options?.staleTime ?? 30000, // 30 seconds cache
    refetchInterval: options?.refetchInterval,
  })
}

// Create cluster
export const createCluster = async (
  clusterData: ClusterCreateRequest
): Promise<{
  id: number
  message: string
  clusterAgentServer?: string
  clusterAgentToken?: string
  clusterAgentPublicKey?: string
  clusterAgentManifestURL?: string
}> => {
  return await apiClient.post<{
    id: number
    message: string
    clusterAgentServer?: string
    clusterAgentToken?: string
    clusterAgentPublicKey?: string
    clusterAgentManifestURL?: string
  }>('/admin/clusters/', clusterData)
}

// Update cluster
export const updateCluster = async (
  id: number,
  clusterData: ClusterUpdateRequest
): Promise<{ message: string }> => {
  return await apiClient.put<{ message: string }>(
    `/admin/clusters/${id}`,
    clusterData
  )
}

// Delete cluster
export const deleteCluster = async (
  id: number
): Promise<{ message: string }> => {
  return await apiClient.delete<{ message: string }>(`/admin/clusters/${id}`)
}

// OAuth Provider Management
export interface OAuthProviderCreateRequest {
  name: string
  clientId: string
  clientSecret: string
  authUrl?: string
  tokenUrl?: string
  userInfoUrl?: string
  scopes?: string
  issuer?: string
  usernameClaim?: string
  groupsClaim?: string
  allowedGroups?: string
  enabled?: boolean
}

export interface OAuthProviderUpdateRequest extends Omit<
  OAuthProviderCreateRequest,
  'clientSecret'
> {
  clientSecret?: string // Optional when updating
}

// Get OAuth provider list for management
export const fetchOAuthProviderList = (): Promise<OAuthProvider[]> => {
  return fetchAPI<{ providers: OAuthProvider[] }>(
    '/admin/oauth-providers/'
  ).then((response) => response.providers)
}

export const useOAuthProviderList = (options?: { staleTime?: number }) => {
  return useQuery({
    queryKey: ['oauth-provider-list'],
    queryFn: fetchOAuthProviderList,
    staleTime: options?.staleTime || 30000, // 30 seconds cache
  })
}

// Create OAuth provider
export const createOAuthProvider = async (
  providerData: OAuthProviderCreateRequest
): Promise<{ provider: OAuthProvider }> => {
  return await apiClient.post<{ provider: OAuthProvider }>(
    '/admin/oauth-providers/',
    providerData
  )
}

// Update OAuth provider
export const updateOAuthProvider = async (
  id: number,
  providerData: OAuthProviderUpdateRequest
): Promise<{ provider: OAuthProvider }> => {
  return await apiClient.put<{ provider: OAuthProvider }>(
    `/admin/oauth-providers/${id}`,
    providerData
  )
}

// Delete OAuth provider
export const deleteOAuthProvider = async (
  id: number
): Promise<{ success: boolean; message: string }> => {
  return await apiClient.delete<{ success: boolean; message: string }>(
    `/admin/oauth-providers/${id}`
  )
}

// Get single OAuth provider
export const fetchOAuthProvider = async (
  id: number
): Promise<OAuthProvider> => {
  return fetchAPI<{ provider: OAuthProvider }>(
    `/admin/oauth-providers/${id}`
  ).then((response) => response.provider)
}

// RBAC API
export const fetchRoleList = async (): Promise<Role[]> => {
  return fetchAPI<{ roles: Role[] }>(`/admin/roles/`).then((resp) => resp.roles)
}

export const useRoleList = (options?: { staleTime?: number }) => {
  return useQuery({
    queryKey: ['role-list'],
    queryFn: fetchRoleList,
    staleTime: options?.staleTime || 30000,
  })
}

export const createRole = async (data: Partial<Role>) => {
  return await apiClient.post<{ role: Role }>(`/admin/roles/`, data)
}

export const updateRole = async (id: number, data: Partial<Role>) => {
  return await apiClient.put<{ role: Role }>(`/admin/roles/${id}`, data)
}

export const deleteRole = async (id: number) => {
  return await apiClient.delete<{ success: boolean }>(`/admin/roles/${id}`)
}

export const assignRole = async (
  id: number,
  data: { subjectType: 'user' | 'group' | 'apikey'; subject: string }
) => {
  return await apiClient.post(`/admin/roles/${id}/assign`, data)
}

export const unassignRole = async (
  id: number,
  subjectType: 'user' | 'group',
  subject: string
) => {
  const params = new URLSearchParams({ subjectType, subject })
  return await apiClient.delete(
    `/admin/roles/${id}/assign?${params.toString()}`
  )
}

export const fetchNodePortRange = async (
  clusterName: string
): Promise<{ min: number; max: number; source: string }> => {
  return await apiClient.get(
    `/admin/clusters/${encodeURIComponent(clusterName)}/nodeport-range`
  )
}

export const createGroup = async (name: string) => {
  return await apiClient.post<{ name: string }>('/admin/groups', { name })
}

export const renameGroup = async (oldName: string, newName: string) => {
  return await apiClient.put<{ name: string }>(
    `/admin/groups/${encodeURIComponent(oldName)}`,
    { name: newName }
  )
}

export const deleteGroup = async (name: string) => {
  return await apiClient.delete<{ success: boolean }>(
    `/admin/groups/${encodeURIComponent(name)}`
  )
}

export const fetchUserList = async (
  page = 1,
  size = 20,
  search = '',
  sortBy = '',
  sortOrder = '',
  role = ''
): Promise<FetchUserListResponse> => {
  const params = new URLSearchParams({
    page: String(page),
    size: String(size),
  })
  if (search) {
    params.set('search', search)
  }
  if (sortBy) {
    params.set('sortBy', sortBy)
  }
  if (sortOrder) {
    params.set('sortOrder', sortOrder)
  }
  if (role) {
    params.set('role', role)
  }
  return fetchAPI<FetchUserListResponse>(`/admin/users/?${params.toString()}`)
}

export const updateUser = async (
  id: number,
  // 请求字段是 groups（用户列表返回里才叫 oidc_groups）。
  data: Partial<UserItem> & { groups?: string[] }
) => {
  return apiClient.put<{ user: UserItem }>(`/admin/users/${id}`, data)
}

export const deleteUser = async (id: number) => {
  return apiClient.delete<{ success: boolean; deferredDeletion?: boolean }>(
    `/admin/users/${id}`
  )
}

export const createPasswordUser = async (data: {
  username: string
  name?: string
  password: string
}) => {
  return apiClient.post<{ user: UserItem }>(`/admin/users/`, data)
}

export const resetUserPassword = async (id: number, password: string) => {
  return apiClient.post<{ success: boolean }>(
    `/admin/users/${id}/reset_password`,
    { password }
  )
}

export const setUserEnabled = async (id: number, enabled: boolean) => {
  return apiClient.post<{ success: boolean }>(`/admin/users/${id}/enable`, {
    enabled,
  })
}

export const useUserList = (
  page = 1,
  size = 20,
  search = '',
  sortBy = '',
  sortOrder = '',
  role = ''
) => {
  return useQuery<FetchUserListResponse, Error>({
    queryKey: ['user-list', page, size, search, sortBy, sortOrder, role],
    queryFn: () => fetchUserList(page, size, search, sortBy, sortOrder, role),
    staleTime: 20000,
  })
}

export const fetchAuditLogs = async (
  page = 1,
  size = 20,
  operatorId?: number,
  search?: string,
  operation?: string,
  cluster?: string,
  resourceType?: string,
  resourceName?: string,
  namespace?: string
): Promise<AuditLogResponse> => {
  const params = new URLSearchParams({
    page: String(page),
    size: String(size),
  })
  if (operatorId) {
    params.set('operatorId', String(operatorId))
  }
  if (search) {
    params.set('search', search)
  }
  if (operation) {
    params.set('operation', operation)
  }
  if (cluster) {
    params.set('cluster', cluster)
  }
  if (resourceType) {
    params.set('resourceType', resourceType)
  }
  if (resourceName) {
    params.set('resourceName', resourceName)
  }
  if (namespace) {
    params.set('namespace', namespace)
  }
  return fetchAPI<AuditLogResponse>(`/admin/audit-logs?${params.toString()}`)
}

export const useAuditLogs = (
  page = 1,
  size = 20,
  operatorId?: number,
  search?: string,
  operation?: string,
  cluster?: string,
  resourceType?: string,
  resourceName?: string,
  namespace?: string
) => {
  return useQuery<AuditLogResponse, Error>({
    queryKey: [
      'audit-logs',
      page,
      size,
      operatorId,
      search,
      operation,
      cluster,
      resourceType,
      resourceName,
      namespace,
    ],
    queryFn: () =>
      fetchAuditLogs(
        page,
        size,
        operatorId,
        search,
        operation,
        cluster,
        resourceType,
        resourceName,
        namespace
      ),
    staleTime: 20000,
  })
}

export const fetchLoginLogs = async (
  page = 1,
  size = 20,
  userId?: number,
  search?: string
): Promise<LoginLogResponse> => {
  const params = new URLSearchParams({
    page: String(page),
    size: String(size),
  })
  if (userId) {
    params.set('userId', String(userId))
  }
  if (search) {
    params.set('search', search)
  }
  return fetchAPI<LoginLogResponse>(`/admin/login-logs?${params.toString()}`)
}

export const useLoginLogs = (
  page = 1,
  size = 20,
  userId?: number,
  search?: string
) => {
  return useQuery<LoginLogResponse, Error>({
    queryKey: ['login-logs', page, size, userId, search],
    queryFn: () => fetchLoginLogs(page, size, userId, search),
    staleTime: 20000,
  })
}

export const fetchPasswordChangeLogs = async (
  page = 1,
  size = 20,
  userId?: number,
  search?: string
): Promise<PasswordChangeLogResponse> => {
  const params = new URLSearchParams({
    page: String(page),
    size: String(size),
  })
  if (userId) {
    params.set('userId', String(userId))
  }
  if (search) {
    params.set('search', search)
  }
  return fetchAPI<PasswordChangeLogResponse>(
    `/admin/password-change-logs?${params.toString()}`
  )
}

export const usePasswordChangeLogs = (
  page = 1,
  size = 20,
  userId?: number,
  search?: string
) => {
  return useQuery<PasswordChangeLogResponse, Error>({
    queryKey: ['password-change-logs', page, size, userId, search],
    queryFn: () => fetchPasswordChangeLogs(page, size, userId, search),
    staleTime: 20000,
  })
}

// API Key Management
export interface APIKeyCreateRequest {
  name: string
}

export interface GeneralSetting {
  aiAgentEnabled: boolean
  aiProvider: 'openai' | 'anthropic'
  aiModel: string
  aiApiKey: string
  aiApiKeyConfigured: boolean
  aiBaseUrl: string
  aiMaxTokens: number
  kubectlEnabled: boolean
  kubectlImage: string
  nodeTerminalImage: string
  clusterAgentImage: string
  enableAnalytics: boolean
  enableVersionCheck: boolean
  passwordLoginDisabled: boolean
  enableMFA: boolean
  loginPrompt: string
}

export interface GeneralSettingUpdateRequest {
  aiAgentEnabled?: boolean
  aiProvider?: 'openai' | 'anthropic'
  aiModel?: string
  aiApiKey?: string
  aiBaseUrl?: string
  aiMaxTokens?: number
  kubectlEnabled?: boolean
  kubectlImage?: string
  nodeTerminalImage?: string
  clusterAgentImage?: string
  enableAnalytics?: boolean
  enableVersionCheck?: boolean
  passwordLoginDisabled?: boolean
  enableMFA?: boolean
  loginPrompt?: string
}

export interface LDAPSetting {
  enabled: boolean
  serverUrl: string
  useStartTLS: boolean
  bindDn: string
  bindPassword: string
  bindPasswordConfigured: boolean
  userBaseDn: string
  userFilter: string
  usernameAttribute: string
  displayNameAttribute: string
  groupBaseDn: string
  groupFilter: string
  groupNameAttribute: string
  autoSync: boolean
  syncIntervalMinutes: number
}

export interface LDAPSettingUpdateRequest {
  enabled: boolean
  serverUrl: string
  useStartTLS: boolean
  bindDn: string
  bindPassword?: string
  userBaseDn: string
  userFilter: string
  usernameAttribute: string
  displayNameAttribute: string
  groupBaseDn: string
  groupFilter: string
  groupNameAttribute: string
  autoSync: boolean
  syncIntervalMinutes: number
}

export const fetchGeneralSetting = async (): Promise<GeneralSetting> => {
  return fetchAPI<GeneralSetting>('/admin/general-setting/')
}

export const useGeneralSetting = (options?: {
  staleTime?: number
  enabled?: boolean
}) => {
  return useQuery({
    queryKey: ['general-setting'],
    queryFn: fetchGeneralSetting,
    enabled: options?.enabled ?? true,
    staleTime: options?.staleTime || 30000,
  })
}

export const updateGeneralSetting = async (
  data: GeneralSettingUpdateRequest
): Promise<GeneralSetting> => {
  return await apiClient.put<GeneralSetting>('/admin/general-setting/', data)
}

export type MFAPolicy = 'disabled' | 'all' | 'admin'

export interface SecuritySetting {
  loginCaptchaEnabled: boolean
  inactiveUserDisableDays: number
  defaultUserEnabled: boolean
  defaultUserExpireDays: number
  remoteLoginNoticeEnabled: boolean
  mfaPolicy: MFAPolicy
  mfaThirdPartyEnabled: boolean
  mfaStepUpEnabled: boolean
  mfaVerifyTtlSeconds: number
  otpIssuerName: string
  otpVerifyWindow: number
  userLoginFailLimit: number
  userLoginBlockMinutes: number
  ipLoginFailLimit: number
  ipLoginBlockMinutes: number
  ipWhitelist: string[]
  ipBlacklist: string[]
  singleDeviceLogin: boolean
  existingUserOnly: boolean
  loginSourceRestricted: boolean
  passwordExpireDays: number
  passwordHistoryCount: number
  passwordMinLength: number
  adminPasswordMinLength: number
  passwordMinClasses: number
  passwordRequireUppercase: boolean
  passwordRequireLowercase: boolean
  passwordRequireDigit: boolean
  passwordRequireSpecial: boolean
  sessionExpireOnBrowserClose: boolean
  sessionMaxIdleMinutes: number
  sessionMaxHours: number
}

export const fetchSecuritySetting = async (): Promise<SecuritySetting> => {
  return fetchAPI<SecuritySetting>('/admin/security-setting/')
}

export const useSecuritySetting = () => {
  return useQuery({
    queryKey: ['security-setting'],
    queryFn: fetchSecuritySetting,
    staleTime: 30000,
  })
}

export const updateSecuritySetting = async (
  data: Partial<SecuritySetting>
): Promise<SecuritySetting> => {
  return await apiClient.put<SecuritySetting>('/admin/security-setting/', data)
}

export interface BlockedLoginIP {
  ip: string
  blockedUntil: string
  failures: number
}

export const fetchLockedLoginIPs = async (): Promise<{
  items: BlockedLoginIP[]
}> => {
  return fetchAPI<{ items: BlockedLoginIP[] }>(
    '/admin/security-setting/locked-ips'
  )
}

export const setGlobalSidebarPreference = async (sidebarPreference: string) => {
  return await apiClient.post<{ success: boolean }>(
    '/admin/sidebar_preference/global',
    {
      sidebar_preference: sidebarPreference,
    }
  )
}

export const clearGlobalSidebarPreference = async () => {
  return await apiClient.delete<{ success: boolean }>(
    '/admin/sidebar_preference/global'
  )
}

export const fetchLDAPSetting = async (): Promise<LDAPSetting> => {
  return fetchAPI<LDAPSetting>('/admin/ldap-setting/')
}

export const useLDAPSetting = (options?: {
  staleTime?: number
  enabled?: boolean
}) => {
  return useQuery({
    queryKey: ['ldap-setting'],
    queryFn: fetchLDAPSetting,
    enabled: options?.enabled ?? true,
    staleTime: options?.staleTime || 30000,
  })
}

export const updateLDAPSetting = async (
  data: LDAPSettingUpdateRequest
): Promise<LDAPSetting> => {
  return await apiClient.put<LDAPSetting>('/admin/ldap-setting/', data)
}

export interface LDAPSyncResult {
  startedAt: string
  finishedAt?: string
  totalUsers: number
  created: number
  updated: number
  failed: number
  purged: number
  enableImported: boolean
  error?: string
}

export interface LDAPSyncStatus {
  running: boolean
  enabled: boolean
  autoSync: boolean
  syncIntervalMinutes: number
  lastSyncAt?: string
  lastResult?: LDAPSyncResult
}

export const fetchLDAPSyncStatus = async (): Promise<LDAPSyncStatus> => {
  return fetchAPI<LDAPSyncStatus>('/admin/ldap-setting/sync')
}

export const triggerLDAPSync = async (
  enableImported?: boolean
): Promise<LDAPSyncStatus> => {
  return await apiClient.post<LDAPSyncStatus>('/admin/ldap-setting/sync', {
    enableImported: enableImported ?? false,
  })
}

export interface LDAPImportCandidate {
  username: string
  displayName?: string
  imported: boolean
  conflict: boolean
}

export interface LDAPImportResult {
  created: number
  updated: number
  notFound: number
  conflicted: number
  failed: number
  failedUsers?: string[]
}

export const fetchLDAPImportCandidates = async (): Promise<
  LDAPImportCandidate[]
> => {
  const res = await fetchAPI<{ users: LDAPImportCandidate[]; total: number }>(
    '/admin/ldap-setting/users'
  )
  return res.users
}

export const importLDAPUsers = async (
  usernames: string[],
  enableImported: boolean
): Promise<LDAPImportResult> => {
  return await apiClient.post<LDAPImportResult>(
    '/admin/ldap-setting/users/import',
    {
      usernames,
      enableImported,
    }
  )
}

export const fetchClusterNamespaces = async (
  clusterName: string
): Promise<string[]> => {
  const res = await apiClient.get<{ namespaces: string[] }>(
    `/admin/clusters/${encodeURIComponent(clusterName)}/namespaces`
  )
  return res.namespaces || []
}

export const fetchKnownGroups = async (): Promise<string[]> => {
  const res = await apiClient.get<{ groups: string[] }>('/admin/groups')
  return res.groups || []
}

export const fetchAPIKeyList = async (): Promise<APIKey[]> => {
  return fetchAPI<{ apiKeys: APIKey[] }>('/admin/apikeys/').then(
    (response) => response.apiKeys
  )
}

export const useAPIKeyList = (options?: { staleTime?: number }) => {
  return useQuery({
    queryKey: ['apikey-list'],
    queryFn: fetchAPIKeyList,
    staleTime: options?.staleTime || 30000,
  })
}

export const createAPIKey = async (
  data: APIKeyCreateRequest
): Promise<{ apiKey: APIKey }> => {
  return await apiClient.post<{ apiKey: APIKey }>('/admin/apikeys/', data)
}

export const deleteAPIKey = async (
  id: number
): Promise<{ message: string }> => {
  return await apiClient.delete<{ message: string }>(`/admin/apikeys/${id}`)
}
