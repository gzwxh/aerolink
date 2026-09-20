import { isClusterScopedResource } from '@/lib/resource-catalog'

/**
 * 与 pkg/rbac/rbac.go 中授权规则对应的客户端镜像。它用于
 * 隐藏后端本会拒绝的界面入口；后端始终是
 * 事实来源。
 */

export interface CanAccessOptions {
  cluster?: string | null
  namespace?: string
  /** 当前账号是否管理员（镜像后端 rbac.IsAdministrator，见 roleCanAccess）。 */
  isAdmin?: boolean
}

/**
 * 用于保护系统设置与权限管理页面的合成资源。
 * 它背后没有 Kubernetes API，也不绑定到集群或
 * 命名空间。对应 pkg/common/rbac.go 中的 common.SystemSettingsResource。
 */
export const SYSTEM_SETTINGS_RESOURCE = 'settings'

/** 修改系统设置与权限所需的 verb。 */
export const SYSTEM_SETTINGS_VERB = 'update'

/** 额外授予设置页面只读访问的 verb。 */
export const SYSTEM_SETTINGS_VIEW_VERB = 'get'

/**
 * 各分区设置资源的前缀：`settings.<section>`。
 * 对应 pkg/common/rbac.go 中的 common.SettingsSectionResourcePrefix。
 */
export const SETTINGS_SECTION_PREFIX = `${SYSTEM_SETTINGS_RESOURCE}.`

/**
 * 控制台设置章节，顺序与后端 common.SettingsSections 一致。
 * 章节名只用于拼资源名（settings.<section>），与界面 URL 上的 section value 可能不同
 * （例如界面 URL 是 /settings/security?tab=authProviders，对应资源 settings.authentication）。
 */
export const SETTINGS_SECTIONS = [
  'general',
  'clusters',
  'notification',
  'templates',
  'apikeys',
  'authentication',
  'users',
  'rbac',
  'security',
  'audit',
] as const

/**
 * 三员互斥（职责分离）：同一组内的角色不得由同一账号兼任。
 * 对应 pkg/model/rbac.go 中的 model.MutuallyExclusiveRoleGroups。
 */
export const MUTUALLY_EXCLUSIVE_ROLE_GROUPS: string[][] = [
  ['admin', 'security-admin', 'auditor'],
]

/** 返回某个控制台设置分区的资源名。 */
export function settingsSectionResource(section: string): string {
  return section
    ? `${SETTINGS_SECTION_PREFIX}${section}`
    : SYSTEM_SETTINGS_RESOURCE
}

/** 对应 pkg/common/rbac.go 中的 common.IsSettingsResource。 */
export function isSettingsResource(resource: string): boolean {
  return (
    resource === SYSTEM_SETTINGS_RESOURCE ||
    resource.startsWith(SETTINGS_SECTION_PREFIX)
  )
}

/** 一条「资源 → 操作」授权（新版角色的判定依据）。 */
export interface AccessGrant {
  resource: string
  verbs: string[]
}

/** 这些校验所需的最小角色结构（与 AuthRole 一致）。 */
export interface AccessRole {
  name: string
  clusters?: string[]
  resources?: string[]
  namespaces?: string[]
  verbs?: string[]
  grants?: AccessGrant[]
}

const REGEX_PATTERN_CHARS = /[\\^$*+?()[\]{}|]/

/**
 * 后端用于集群级请求的命名空间哨兵值，包括
 * "namespaces" 资源本身（见 pkg/rbac/rbac.go 中的 namespaceUnconstrained）。
 */
const ALL_NAMESPACES = '_all'

// 对应 pkg/rbac/rbac.go 中的后端匹配器：普通值是字面量，
// "*" 匹配任意内容，"!" 前缀的模式表示拒绝，而任何包含
// 正则元字符的值会被当作锚定正则表达式处理。
function matchesPattern(pattern: string, value: string): boolean {
  if (pattern === '*' || pattern === value) {
    return true
  }
  if (!REGEX_PATTERN_CHARS.test(pattern)) {
    return false
  }
  try {
    return new RegExp(`^(?:${pattern})$`).test(value)
  } catch {
    return false
  }
}

function matchesAny(patterns: string[] | undefined, value: string): boolean {
  const list = patterns || []
  for (const pattern of list) {
    if (
      pattern.length > 1 &&
      pattern.startsWith('!') &&
      matchesPattern(pattern.slice(1), value)
    ) {
      return false
    }
  }
  for (const pattern of list) {
    if (pattern.startsWith('!')) {
      continue
    }
    if (matchesPattern(pattern, value)) {
      return true
    }
  }
  return false
}

// 对应 pkg/rbac/rbac.go 中的 namespaceRestricted：一个列出了具体
// 命名空间、但并未授予全部命名空间的角色。
function isNamespaceRestricted(namespaces: string[] | undefined): boolean {
  const list = namespaces || []
  if (list.length === 0) {
    return false
  }
  return !list.includes('*') && !list.includes('_all')
}

/** 后端在集群级请求上使用的哨兵资源名。 */
const NAMESPACES_RESOURCE = 'namespaces'

/**
 * 是否是「创建命名空间」。对应 pkg/rbac/rbac.go 中 CanAccess 的分支：这个动作只认
 * 管理员，不通过角色 / 权限绑定组下发（命名空间由管理员创建后再授权给用户使用）。
 */
function isNamespaceCreate(resource: string, verb: string): boolean {
  return resource === NAMESPACES_RESOURCE && verb === 'create'
}

// 对应 pkg/rbac/rbac.go 中的 namespaceUnconstrained：namespaces 资源
// 并不属于"不受约束"——角色的命名空间列表会与被操作的
// 命名空间逐一匹配，和命名空间级资源完全一样。
function namespaceUnconstrained(resource: string): boolean {
  return resource !== 'namespaces' && isClusterScopedResource(resource)
}

// 对应 pkg/rbac/rbac.go 中的 matchExplicit：裸 "*" 通配会被忽略，
// 因此它不能冒充显式的集群级授权。
function matchesAnyExplicit(
  patterns: string[] | undefined,
  value: string
): boolean {
  const list = patterns || []
  if (!list.includes('*')) {
    return matchesAny(list, value)
  }
  return matchesAny(
    list.filter((pattern) => pattern !== '*'),
    value
  )
}

/**
 * 对应 pkg/rbac/rbac.go 中的 roleAllows：带资源授权的角色按资源
 * 逐条校验（同一个角色可以对不同资源授予不同的操作），
 * 而没有 Grants 的旧式角色沿用 Resources × Verbs
 * 的叉乘语义。
 *
 * 设置族资源（settings / settings.<章节>）单独处理：它们必须显式授权，通配 * 不覆盖
 * —— 否则一个含 * 的普通角色就能把「系统配置 / 安全授权 / 审计」三员的权限并回一人。
 */
function roleAllows(role: AccessRole, resource: string, verb: string): boolean {
  if (isSettingsResource(resource)) {
    return settingsRoleAllows(role, resource, verb)
  }
  if (roleDenies(role, resource)) {
    return false
  }
  const grants = role.grants || []
  if (grants.length > 0) {
    return grants.some(
      (grant) =>
        matchesAny([grant.resource], resource) && matchesAny(grant.verbs, verb)
    )
  }
  return matchesAny(role.resources, resource) && matchesAny(role.verbs, verb)
}

/** 对应 pkg/rbac/rbac.go 中的 roleDenies。 */
function roleDenies(role: AccessRole, resource: string): boolean {
  for (const pattern of role.resources || []) {
    if (pattern.length > 1 && pattern.startsWith('!')) {
      if (matchesPattern(pattern.slice(1), resource)) {
        return true
      }
    }
  }
  return false
}

/** 对应 pkg/rbac/rbac.go 中的 settingsRoleAllows。 */
function settingsRoleAllows(
  role: AccessRole,
  resource: string,
  verb: string
): boolean {
  const grants = role.grants || []
  if (grants.length > 0) {
    return grants.some(
      (grant) =>
        settingsRuleCovers(grant.resource, resource) &&
        matchesAny(grant.verbs, verb)
    )
  }
  return (role.resources || []).some(
    (pattern) =>
      !pattern.startsWith('!') &&
      settingsRuleCovers(pattern, resource) &&
      matchesAny(role.verbs, verb)
  )
}

/** 对应 pkg/rbac/rbac.go 中的 settingsRuleCovers。 */
function settingsRuleCovers(pattern: string, resource: string): boolean {
  if (pattern === resource) {
    return true
  }
  if (resource === SYSTEM_SETTINGS_RESOURCE) {
    // 章节规则不反向覆盖父级：父级语义是「全部章节」。
    return false
  }
  return pattern === SYSTEM_SETTINGS_RESOURCE
}

/**
 * 权限判定用的角色集合：直接分配 / 全局绑定组的角色，加上命名空间级权限绑定组带来的
 * 角色（后者携带组内集群与命名空间范围）。
 *
 * 控制台设置章节不在此列：后端对 settings 资源的判定不看权限绑定组
 *（见 rbac.CanManageSettingsSection），前端必须一致。
 */
export function permissionRoles(
  roles?: AccessRole[],
  namespaceScopedRoles?: AccessRole[]
): AccessRole[] {
  return [...(roles || []), ...(namespaceScopedRoles || [])]
}

/**
 * 当角色在集群的*某个*命名空间上授予了对该资源的 verb 时为 true。
 * 列表页用它来渲染不绑定单个命名空间的入口（创建按钮、批量删除）：
 * 只检查某一个任意命名空间，会让授权指向其它命名空间的用户
 * 看不到这些入口。
 */
export function roleCanAccessAnyNamespace(
  roles: AccessRole[] | undefined,
  resource: string,
  verb: string,
  options?: Pick<CanAccessOptions, 'cluster' | 'isAdmin'>
): boolean {
  // 同 roleCanAccess：「创建命名空间」是管理员专属动作，不看角色。
  if (isNamespaceCreate(resource, verb)) {
    return options?.isAdmin === true
  }
  if (!roles || roles.length === 0) {
    return false
  }
  const cluster = options?.cluster ?? undefined
  return roles.some((role) => {
    if (cluster && !matchesAny(role.clusters, cluster)) {
      return false
    }
    if (namespaceUnconstrained(resource)) {
      // 集群级对象会忽略命名空间列表，但
      // 限定命名空间的角色必须显式点名这些资源。
      if (
        isNamespaceRestricted(role.namespaces) &&
        !matchesAnyExplicit(role.resources, resource)
      ) {
        return false
      }
    } else if (resource === NAMESPACES_RESOURCE) {
      // 按哨兵值校验（只有在角色确实列出了命名空间时才会命中，为空表示不受约束）。
      const namespaces = role.namespaces || []
      if (namespaces.length > 0 && !matchesAny(namespaces, ALL_NAMESPACES)) {
        return false
      }
    } else {
      const namespaces = role.namespaces || []
      // 对应 pkg/rbac/rbac.go 中 CanAccess 的命名空间部分：空的
      // 命名空间列表不是约束——角色已不再携带该字段，
      // 命名空间范围来自权限绑定组。非空的
      // 列表仍需要至少一个能指向真实命名空间的正向模式：
      // 只有拒绝项的列表（"!kube-system"）或 "_all" 哨兵
      // （它永远不是命名空间名）不会授予任何权限。
      if (
        namespaces.length > 0 &&
        !namespaces.some(
          (pattern) => !pattern.startsWith('!') && pattern !== ALL_NAMESPACES
        )
      ) {
        return false
      }
    }
    if (!matchesAny(role.resources, resource)) {
      return false
    }
    return roleAllows(role, resource, verb)
  })
}

/**
 * 对应 pkg/rbac/rbac.go 中的 CanManageSystemSettings：合成的 "settings"
 * 资源是控制台的全局状态，因此角色的集群与命名空间范围
 * 不适用——只匹配资源与 verb 模式。裸 "*"
 * 资源授权并不包含它。
 */
export function roleCanManageSystemSettings(
  roles: AccessRole[] | undefined,
  verb: string = SYSTEM_SETTINGS_VERB
): boolean {
  return roleCanManageSettingsSection(roles, '', verb)
}

/** 对应 pkg/rbac/rbac.go 中的 CanManageSettingsSection。 */
export function roleCanManageSettingsSection(
  roles: AccessRole[] | undefined,
  section: string,
  verb: string = SYSTEM_SETTINGS_VERB
): boolean {
  const resource = settingsSectionResource(section)
  return (roles || []).some((role) => roleAllows(role, resource, verb))
}

/** 对应 pkg/rbac/rbac.go 中的 CanViewSettingsSection。 */
export function roleCanViewSettingsSection(
  roles: AccessRole[] | undefined,
  section: string
): boolean {
  return (
    roleCanManageSettingsSection(roles, section, SYSTEM_SETTINGS_VIEW_VERB) ||
    roleCanManageSettingsSection(roles, section)
  )
}

/**
 * 对应 pkg/rbac/rbac.go 中的 CanAccessAnySettingsSection：只要至少有一个分区
 * 可读，设置区本身（导航、路由守卫）就会显示。
 *
 */
export function roleCanAccessAnySettingsSection(
  roles: AccessRole[] | undefined
): boolean {
  return SETTINGS_SECTIONS.some((section) =>
    roleCanViewSettingsSection(roles, section)
  )
}

/**
 * 对应 pkg/rbac/rbac.go 中的 CanViewSystemSettings：控制台设置页面的
 * 读访问同时接受读 verb 与管理 verb。
 */
export function roleCanViewSystemSettings(
  roles: AccessRole[] | undefined
): boolean {
  return (
    roleCanManageSystemSettings(roles, SYSTEM_SETTINGS_VIEW_VERB) ||
    roleCanManageSystemSettings(roles)
  )
}

/**
 * 对应 pkg/rbac/rbac.go 中的 SeparationOfDutiesConflict：持有互斥组中
 * 多个角色的账号会失去其管理界面，
 * 直到运维移除其中一个角色。
 */
export function separationOfDutiesConflict(roles: AccessRole[] | undefined): {
  conflict: boolean
  roles: string[]
} {
  const held = new Set((roles || []).map((role) => role.name))
  for (const group of MUTUALLY_EXCLUSIVE_ROLE_GROUPS) {
    const matched = group.filter((name) => held.has(name))
    if (matched.length > 1) {
      return { conflict: true, roles: matched }
    }
  }
  return { conflict: false, roles: [] }
}

/**
 * 对应 pkg/rbac/rbac.go 中的 execRequiresGet：pod 终端还额外需要
 * pods 上的 `get`，因为会话必须先选定 pod 与容器。
 */
function requiresGetPrerequisite(resource: string, verb: string): boolean {
  return resource === 'pods' && verb === 'exec'
}

export function roleCanAccess(
  roles: AccessRole[] | undefined,
  resource: string,
  verb: string,
  options?: CanAccessOptions
): boolean {
  // 与后端一致：「创建命名空间」不通过授权配置下发——命名空间由管理员创建，再通过
  // 权限绑定组授权给用户使用。因此这里只认管理员，不看角色 / 绑定组。
  if (isNamespaceCreate(resource, verb)) {
    return options?.isAdmin === true
  }
  if (
    requiresGetPrerequisite(resource, verb) &&
    !roleCanAccessVerb(roles, resource, 'get', options)
  ) {
    return false
  }
  return roleCanAccessVerb(roles, resource, verb, options)
}

function roleCanAccessVerb(
  roles: AccessRole[] | undefined,
  resource: string,
  verb: string,
  options?: CanAccessOptions
): boolean {
  if (!roles || roles.length === 0) {
    return false
  }
  const cluster = options?.cluster ?? undefined
  const namespace = options?.namespace
  // 集群级资源没有命名空间，因此角色的命名空间列表
  // 无法约束它们——但限定命名空间的角色必须显式点名它们，
  // 而不能依赖通配资源授权。namespaces
  // 资源是例外：它按被操作的命名空间（集群级请求为 "_all"）匹配角色。
  // （「创建命名空间」在上层就按管理员判定了，走不到这里。）
  const unconstrained = namespaceUnconstrained(resource)
  return roles.some((role) => {
    if (cluster && !matchesAny(role.clusters, cluster)) {
      return false
    }
    if (unconstrained) {
      if (
        isNamespaceRestricted(role.namespaces) &&
        !matchesAnyExplicit(role.resources, resource)
      ) {
        return false
      }
    } else {
      const target =
        resource === NAMESPACES_RESOURCE
          ? (namespace ?? ALL_NAMESPACES)
          : namespace
      // 空列表 = 不约束：镜像 pkg/rbac/rbac.go 的 CanAccess（角色不再携带命名空间字段，
      // 命名空间范围由权限绑定组圈定），只有显式列了命名空间时才逐条匹配。
      const namespaces = role.namespaces || []
      if (target && namespaces.length > 0 && !matchesAny(namespaces, target)) {
        return false
      }
    }
    if (!matchesAny(role.resources, resource)) {
      return false
    }
    return roleAllows(role, resource, verb)
  })
}
