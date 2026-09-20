import { useQuery } from '@tanstack/react-query'

import {
  APIKey,
  AuditLogResponse,
  AuditSetting,
  AuditSettingResponse,
  Cluster,
  FetchUserListResponse,
  LoginLogResponse,
  OAuthProvider,
  PasswordChangeLogResponse,
  Role,
  UserItem,
} from '@/types/api'

import { apiClient } from '../api-client'
import { downloadFile, fetchAPI } from './shared'

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

// 获取用于管理的集群列表
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

// 创建集群
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

// 更新集群
export const updateCluster = async (
  id: number,
  clusterData: ClusterUpdateRequest
): Promise<{ message: string }> => {
  return await apiClient.put<{ message: string }>(
    `/admin/clusters/${id}`,
    clusterData
  )
}

// 删除集群
// 集群是权限隔离的第一层：删除时需选择是否一并删除该集群的权限绑定，
// 默认保留（detached），保留的权限绑定不再参与授权，可在权限管理页重新绑定。
export const deleteCluster = async (
  id: number,
  options?: { deleteBindingGroups?: boolean }
): Promise<{
  message: string
  bindingGroupTotal?: number
  bindingGroupsDeleted?: number
  bindingGroupsRetained?: number
}> => {
  const mode = options?.deleteBindingGroups ? 'delete' : 'keep'
  return await apiClient.delete(`/admin/clusters/${id}?bindingGroups=${mode}`)
}

// OAuth 提供方管理
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

// 获取用于管理的 OAuth 提供方列表
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

// 创建 OAuth 提供方
export const createOAuthProvider = async (
  providerData: OAuthProviderCreateRequest
): Promise<{ provider: OAuthProvider }> => {
  return await apiClient.post<{ provider: OAuthProvider }>(
    '/admin/oauth-providers/',
    providerData
  )
}

// 更新 OAuth 提供方
export const updateOAuthProvider = async (
  id: number,
  providerData: OAuthProviderUpdateRequest
): Promise<{ provider: OAuthProvider }> => {
  return await apiClient.put<{ provider: OAuthProvider }>(
    `/admin/oauth-providers/${id}`,
    providerData
  )
}

// 删除 OAuth 提供方
export const deleteOAuthProvider = async (
  id: number
): Promise<{ success: boolean; message: string }> => {
  return await apiClient.delete<{ success: boolean; message: string }>(
    `/admin/oauth-providers/${id}`
  )
}

// 获取单个 OAuth 提供方
export const fetchOAuthProvider = async (
  id: number
): Promise<OAuthProvider> => {
  return fetchAPI<{ provider: OAuthProvider }>(
    `/admin/oauth-providers/${id}`
  ).then((response) => response.provider)
}

// RBAC 接口
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

/**
 * 清除某个账号的动态码绑定，让本人在下次登录时重新绑定。
 * 「强制 MFA」策略的安全阀：身份验证器丢失时只能靠它重新绑定。
 */
export const resetUserMFA = async (id: number) => {
  return await apiClient.post<{ success: boolean }>(
    `/admin/users/${id}/reset_mfa`,
    {}
  )
}

/** 一个职责分离冲突的账号：它同时持有互斥的管理员角色。 */
export interface RoleConflictSubject {
  username: string
  name?: string
  enabled: boolean
  /** 冲突的角色名（至少两个，均为内置三员角色）。 */
  roles: string[]
}

/**
 * 列出同时持有互斥管理员角色的账号（职责分离巡检）。后端只做读取，不会自动
 * 改正——需要安全管理员解绑其中一个角色。
 */
export const fetchRoleConflicts = async (): Promise<RoleConflictSubject[]> => {
  const response = await fetchAPI<{ conflicts: RoleConflictSubject[] }>(
    '/admin/role-conflicts'
  )
  return response.conflicts ?? []
}

export const useRoleConflicts = () => {
  return useQuery<RoleConflictSubject[], Error>({
    queryKey: ['role-conflicts'],
    queryFn: fetchRoleConflicts,
    staleTime: 30000,
  })
}

/**
 * 把内置系统角色恢复成代码里的默认定义（等保三级三权分立的三员权限集）。
 * 只对 isSystem 角色有效：自定义角色的规则不会被覆盖。
 */
export const restoreRoleDefaults = async (id: number) => {
  return await apiClient.post<{ role: Role }>(
    `/admin/roles/${id}/restore_defaults`,
    {}
  )
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

// ---------- 权限绑定（项目组）：命名空间 + 用户/用户组 + 角色 ----------

export interface BindingGroup {
  id: number
  cluster: string
  name: string
  description?: string
  // 所属集群已删除、配置被保留的权限绑定：不参与授权，等待重新绑定。
  detached?: boolean
  // 全局作用域：成员绑定的角色对所有集群、所有命名空间与集群级资源生效。
  global?: boolean
  // 初始化播种的超级管理员组：不可删除。
  protected?: boolean
  namespaces?: { id: number; namespace: string }[]
  members?: BindingGroupMember[]
  createdAt: string
  updatedAt: string
}

export interface BindingGroupMember {
  id: number
  subjectType: 'user' | 'group'
  subject: string
  // 角色绑定的生效命名空间；空字符串表示组内全部命名空间。
  namespace: string
  roleId: number
  // 受保护成员（如初始化创建的超级管理员）：不能被全量设置接口移除。
  protected?: boolean
  role?: Role
}

export const createBindingGroup = async (data: {
  cluster: string
  name: string
  description?: string
  global?: boolean
}) => {
  return await apiClient.post<{ bindingGroup: BindingGroup }>(
    '/admin/binding-groups',
    data
  )
}

// 当前登录用户可见的权限绑定（含命名空间，供导航分组）
export const fetchUserBindingGroups = async () => {
  const result = await apiClient.get<{ bindingGroups: BindingGroup[] }>(
    '/projects'
  )
  return result.bindingGroups
}

// 列出权限绑定；options.detached 为 true 时只返回所属集群已删除、被保留的组。
export const fetchBindingGroups = async (
  cluster?: string,
  options?: { detached?: boolean }
) => {
  const params = new URLSearchParams()
  if (cluster) params.set('cluster', cluster)
  if (options?.detached) params.set('detached', 'true')
  const query = params.toString()
  const result = await apiClient.get<{ bindingGroups: BindingGroup[] }>(
    `/admin/binding-groups${query ? `?${query}` : ''}`
  )
  return result.bindingGroups
}

// 把保留（所属集群已删除）的权限绑定重新绑定到集群，绑定后恢复授权。
export const bindBindingGroup = async (id: number, cluster: string) => {
  return await apiClient.post<{ bindingGroup: BindingGroup }>(
    `/admin/binding-groups/${id}/bind`,
    { cluster }
  )
}

export const updateBindingGroup = async (
  id: number,
  data: { name?: string; description?: string; global?: boolean }
) => {
  return await apiClient.put<{ bindingGroup: BindingGroup }>(
    `/admin/binding-groups/${id}`,
    data
  )
}

export const deleteBindingGroup = async (id: number) => {
  return await apiClient.delete<{ success: boolean }>(
    `/admin/binding-groups/${id}`
  )
}

export const setBindingGroupNamespaces = async (
  id: number,
  namespaces: string[]
) => {
  return await apiClient.put<{ success: boolean }>(
    `/admin/binding-groups/${id}/namespaces`,
    { namespaces }
  )
}

// 在权限绑定所属集群内创建命名空间并归属到该组
export const createBindingGroupNamespace = async (
  id: number,
  namespace: string
) => {
  return await apiClient.post<{ namespace: string; cluster: string }>(
    `/admin/binding-groups/${id}/namespaces/create`,
    { namespace }
  )
}

export const setBindingGroupMembers = async (
  id: number,
  members: {
    subjectType: 'user' | 'group'
    subject: string
    // 空字符串 = 组内全部命名空间。
    namespace?: string
    roleIds: number[]
  }[]
) => {
  return await apiClient.put<{ success: boolean }>(
    `/admin/binding-groups/${id}/members`,
    { members }
  )
}

export const fetchNodePortRange = async (
  clusterName: string
): Promise<{ min: number; max: number; source: string }> => {
  return await apiClient.get(
    `/admin/clusters/${encodeURIComponent(clusterName)}/nodeport-range`
  )
}

export const createGroup = async (name: string, description?: string) => {
  return await apiClient.post<{ name: string }>('/admin/groups', {
    name,
    description: description ?? '',
  })
}

export const updateGroupDescription = async (
  name: string,
  description: string
) => {
  return await apiClient.put<{ name: string; description: string }>(
    `/admin/groups/${encodeURIComponent(name)}/description`,
    { description }
  )
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

// 组成员的一条记录。source 决定这条成员关系由谁维护：
// local = 在控制台加的（可在这里移除）；ldap / oidc = 目录同步带来的（只能在目录里改）。
export interface GroupMemberItem {
  username: string
  name?: string
  provider: string
  source: string
}

export const fetchGroupMembers = async (
  name: string
): Promise<GroupMemberItem[]> => {
  const result = await apiClient.get<{ members: GroupMemberItem[] }>(
    `/admin/groups/${encodeURIComponent(name)}/members`
  )
  return result.members ?? []
}

// 添加成员对**任意来源**的账号都有效：目录账号（LDAP / OIDC）会被记为本地附加成员关系，
// 目录同步不会把它移除。
export const addGroupMember = async (name: string, username: string) => {
  return await apiClient.post<{ success: boolean }>(
    `/admin/groups/${encodeURIComponent(name)}/members`,
    { username }
  )
}

// 只移除本地附加的成员关系；目录带来的成员关系会返回 409（code:
// group_member_directory_managed），调用方据此提示用户去目录里改。
export const removeGroupMember = async (name: string, username: string) => {
  return await apiClient.delete<{ success: boolean }>(
    `/admin/groups/${encodeURIComponent(name)}/members/${encodeURIComponent(
      username
    )}`
  )
}

export const fetchUserList = async (
  page = 1,
  size = 20,
  search = '',
  sortBy = '',
  sortOrder = '',
  role = '',
  enabled = '',
  provider = '',
  group = ''
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
  // enabled 取 'true' / 'false'；provider 是认证方式，group 是 LDAP / OIDC 用户组。
  if (enabled) {
    params.set('enabled', enabled)
  }
  if (provider) {
    params.set('provider', provider)
  }
  if (group) {
    params.set('group', group)
  }
  return fetchAPI<FetchUserListResponse>(`/admin/users/?${params.toString()}`)
}

export const updateUser = async (
  id: number,
  // 请求字段是 groups（用户列表返回里才叫 oidc_groups）。
  data: Partial<UserItem> & { groups?: string[] }
): Promise<UserItem> => {
  // 后端直接返回更新后的用户对象（没有 { user } 包装）。
  return apiClient.put<UserItem>(`/admin/users/${id}`, data)
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
  email?: string
  phone?: string
  remark?: string
  enabled?: boolean
  // ISO 时间戳；省略表示"永不过期"。
  expiresAt?: string
  // 创建时用户加入的本地组。
  groups?: string[]
  // true = 该账号不受全局 MFA 策略强制。
  mfaDisabled?: boolean
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

// 面板里的「立即检查」：按当前策略立刻跑一轮不活跃禁用，返回本次禁用的账号数。
// 每日任务每小时才调度一次，没有这个入口就只能干等（或去通知管理页触发）。
export const checkInactiveUsers = async () => {
  return apiClient.post<{ disabled: number }>('/admin/users/disabled/check', {})
}

// 批量解禁面板里列出的自动禁用账号（整组/勾选共用）；不在列表中的 id 会被跳过。
export const restoreDisabledUsers = async (ids: number[]) => {
  return apiClient.post<{ restored: number; skipped: number }>(
    '/admin/users/disabled/restore',
    { ids }
  )
}

export const useUserList = (
  page = 1,
  size = 20,
  search = '',
  sortBy = '',
  sortOrder = '',
  role = '',
  enabled = '',
  provider = '',
  group = ''
) => {
  return useQuery<FetchUserListResponse, Error>({
    queryKey: [
      'user-list',
      page,
      size,
      search,
      sortBy,
      sortOrder,
      role,
      enabled,
      provider,
      group,
    ],
    queryFn: () =>
      fetchUserList(
        page,
        size,
        search,
        sortBy,
        sortOrder,
        role,
        enabled,
        provider,
        group
      ),
    staleTime: 20000,
  })
}

// 审计日志的时间范围筛选（等保三级：按时间段核查与导出审计记录）。
// 传 `YYYY-MM-DD` 时，`to` 含当天（后端按次日 0 点做开区间）。
export interface AuditTimeRange {
  from?: string
  to?: string
}

function appendTimeRange(params: URLSearchParams, range: AuditTimeRange = {}) {
  if (range.from) {
    params.set('from', range.from)
  }
  if (range.to) {
    params.set('to', range.to)
  }
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
  namespace?: string,
  // 需要限定多个操作类型时使用（如容器文件的上传/下载/查看）。
  operations?: string[],
  range: AuditTimeRange = {}
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
  if (operations?.length) {
    params.set('operations', operations.join(','))
  }
  appendTimeRange(params, range)
  return fetchAPI<AuditLogResponse>(`/admin/audit-logs?${params.toString()}`)
}

// 导出与列表共用同一套筛选条件，所以「页面上看到的」和「导出的」永远一致。
export const exportAuditLogs = (
  operatorId?: number,
  search?: string,
  operation?: string,
  cluster?: string,
  resourceType?: string,
  resourceName?: string,
  namespace?: string,
  operations?: string[],
  range: AuditTimeRange = {}
) => {
  const params = new URLSearchParams()
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
  if (operations?.length) {
    params.set('operations', operations.join(','))
  }
  appendTimeRange(params, range)
  return downloadFile(
    `/admin/audit-logs/export?${params.toString()}`,
    'kite-audit-logs.csv'
  )
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
  namespace?: string,
  operations?: string[],
  range: AuditTimeRange = {}
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
      operations,
      range.from,
      range.to,
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
        namespace,
        operations,
        range
      ),
    staleTime: 20000,
  })
}

export const fetchLoginLogs = async (
  page = 1,
  size = 20,
  userId?: number,
  search?: string,
  outcome?: 'success' | 'failure',
  range: AuditTimeRange = {}
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
  if (outcome) {
    params.set('outcome', outcome)
  }
  appendTimeRange(params, range)
  return fetchAPI<LoginLogResponse>(`/admin/login-logs?${params.toString()}`)
}

export const exportLoginLogs = async (
  userId?: number,
  search?: string,
  outcome?: 'success' | 'failure',
  range: AuditTimeRange = {}
) => {
  const params = new URLSearchParams()
  if (userId) {
    params.set('userId', String(userId))
  }
  if (search) {
    params.set('search', search)
  }
  if (outcome) {
    params.set('outcome', outcome)
  }
  appendTimeRange(params, range)
  return downloadFile(
    `/admin/login-logs/export?${params.toString()}`,
    'kite-login-logs.csv'
  )
}

export const useLoginLogs = (
  page = 1,
  size = 20,
  userId?: number,
  search?: string,
  outcome?: 'success' | 'failure',
  range: AuditTimeRange = {}
) => {
  return useQuery<LoginLogResponse, Error>({
    queryKey: [
      'login-logs',
      page,
      size,
      userId,
      search,
      outcome,
      range.from,
      range.to,
    ],
    queryFn: () => fetchLoginLogs(page, size, userId, search, outcome, range),
    staleTime: 20000,
  })
}

export const fetchPasswordChangeLogs = async (
  page = 1,
  size = 20,
  userId?: number,
  search?: string,
  range: AuditTimeRange = {}
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
  appendTimeRange(params, range)
  return fetchAPI<PasswordChangeLogResponse>(
    `/admin/password-change-logs?${params.toString()}`
  )
}

export const exportPasswordChangeLogs = async (
  userId?: number,
  search?: string,
  range: AuditTimeRange = {}
) => {
  const params = new URLSearchParams()
  if (userId) {
    params.set('userId', String(userId))
  }
  if (search) {
    params.set('search', search)
  }
  appendTimeRange(params, range)
  return downloadFile(
    `/admin/password-change-logs/export?${params.toString()}`,
    'kite-password-change-logs.csv'
  )
}

export const usePasswordChangeLogs = (
  page = 1,
  size = 20,
  userId?: number,
  search?: string,
  range: AuditTimeRange = {}
) => {
  return useQuery<PasswordChangeLogResponse, Error>({
    queryKey: [
      'password-change-logs',
      page,
      size,
      userId,
      search,
      range.from,
      range.to,
    ],
    queryFn: () => fetchPasswordChangeLogs(page, size, userId, search, range),
    staleTime: 20000,
  })
}

// 审计设置（保留策略 + syslog 外发）：审计管理员唯一可写的审计配置。
export const fetchAuditSetting = (): Promise<AuditSettingResponse> =>
  fetchAPI<AuditSettingResponse>('/admin/audit-setting/')

export const useAuditSetting = () =>
  useQuery<AuditSettingResponse, Error>({
    queryKey: ['audit-setting'],
    queryFn: fetchAuditSetting,
  })

export const updateAuditSetting = async (
  setting: AuditSetting
): Promise<{ setting: AuditSetting }> =>
  apiClient.put<{ setting: AuditSetting }>('/admin/audit-setting/', setting)

// API Key 管理
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
  /** 普通用户新建命名空间后是否自动纳入其权限范围（优先归属其权限绑定）。 */
  autoBindUserNamespace: boolean
  enableAnalytics: boolean
  enableVersionCheck: boolean
  passwordLoginDisabled: boolean
  enableMFA: boolean
  loginPrompt: string
  /** 自定义 logo（http(s) 或 data: 地址）；为空表示使用内置图标。 */
  logoUrl: string
  /** 控制台展示名称；为空表示使用默认名 Kite。 */
  siteName: string
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
  autoBindUserNamespace?: boolean
  enableAnalytics?: boolean
  enableVersionCheck?: boolean
  passwordLoginDisabled?: boolean
  enableMFA?: boolean
  loginPrompt?: string
  logoUrl?: string
  siteName?: string
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
  rejectUnknownUsers: boolean
  loginSourceEnforced: boolean
  loginSourceAllowlist: string[]
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

// 重新导入集群后创建内置的默认授权配置（超级权限绑定）。
export const ensureBindingGroupDefaults = async (
  cluster: string
): Promise<void> => {
  await apiClient.post('/admin/binding-groups/defaults', { cluster })
}

// 管理员手动拉黑一个 IP（按策略中的 IP 锁定窗口），优先于白名单豁免。
export const blockLoginIP = async (
  ip: string
): Promise<{ success: boolean; ip: string; blockedUntil: string }> => {
  return await apiClient.post('/admin/security-setting/locked-ips', { ip })
}

// 解除某个 IP 的锁定（自动锁定与手动拉黑都会清除）。
export const unblockLoginIP = async (ip: string): Promise<void> => {
  await apiClient.delete(
    `/admin/security-setting/locked-ips/${encodeURIComponent(ip)}`
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

// 用户组来源：local = 控制台创建；ldap / oidc = 目录同步发现。
export type GroupSource = 'local' | 'ldap' | 'oidc'

export interface KnownGroupDetail {
  source: GroupSource
  /** 控制台本地备注（描述），空串表示未填写。 */
  description: string
}

export const fetchKnownGroupDetails = async (): Promise<
  Record<string, KnownGroupDetail>
> => {
  const res = await apiClient.get<{
    groups: string[]
    sources?: Record<string, GroupSource>
    descriptions?: Record<string, string>
  }>('/admin/groups')
  const details: Record<string, KnownGroupDetail> = {}
  for (const name of res.groups || []) {
    details[name] = {
      source: res.sources?.[name] ?? 'local',
      description: res.descriptions?.[name] ?? '',
    }
  }
  return details
}

// 所有用户组及其成员用户名（group -> usernames），用于把「用户组」主体连同
// 它覆盖的用户一起展示。
export const fetchAllGroupMembers = async (): Promise<
  Record<string, string[]>
> => {
  const res = await apiClient.get<{ groups: Record<string, string[]> }>(
    '/admin/group-members'
  )
  return res.groups || {}
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
