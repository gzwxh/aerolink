import type { TFunction } from 'i18next'

interface SystemRoleLike {
  name: string
  isSystem?: boolean
  /** 自定义的展示名；为空表示未自定义，回落到内置名 / 角色 ID。 */
  displayName?: string
  /** 后端存储的描述；内置角色存的是英文默认文本，界面按语言另取文案。 */
  description?: string
}

/**
 * 受保护的内置角色（与后端 model.ProtectedRoleNames 一致）：系统管理员、安全
 * 管理员（授权）、审计管理员（审计）与只读管理员。
 *
 * 三员角色的定义就是“分立”本身；只读管理员虽不参与职责分离，但其规则由代码
 * 维护、不应被误改误删。因此界面上只提供查看，不提供编辑与删除。
 */
export const PROTECTED_ROLE_NAMES = [
  'admin',
  'security-admin',
  'auditor',
  'viewer',
] as const

/** 是否为受保护的内置角色（不可修改、不可删除）。 */
export function isProtectedRole(role: SystemRoleLike): boolean {
  return (PROTECTED_ROLE_NAMES as readonly string[]).includes(role.name)
}

/**
 * 受保护的内置角色的排序权重：按 PROTECTED_ROLE_NAMES 的顺序从 0 开始。其余角色
 * 一律得到同一个大值（排在最后），因此直接按权重排序就能把这四个钉在列表最前面，
 * 同时靠稳定排序保留它们之间的原有顺序。
 */
export function protectedRoleRank(role: SystemRoleLike): number {
  const index = (PROTECTED_ROLE_NAMES as readonly string[]).indexOf(role.name)
  return index === -1 ? Number.MAX_SAFE_INTEGER : index
}

/** 是否为只读管理员：不参与职责分离，但同样受保护。 */
export function isViewerRole(role: SystemRoleLike): boolean {
  return role.name === 'viewer'
}

/**
 * 是否为最高权限角色（系统管理员）。代次 3 起内置超级角色已并入它，因此它的受保护
 * 原因与安全 / 审计管理员不同：它不是职责分离的支点，而是“最高权限”本身。
 */
export function isTopRole(role: SystemRoleLike): boolean {
  return role.name === 'admin'
}

/**
 * 未自定义时内置角色在界面上的默认名：存储的名称（admin / auditor / security-admin /
 * viewer）是权限判定依据，必须保持不变；界面按当前语言展示，未收录的名称原样返回。
 */
export function systemRoleDefaultLabel(
  t: TFunction,
  role: SystemRoleLike
): string {
  if (!role.isSystem) return role.name
  return t(`rbac.systemRoles.${role.name}`, { defaultValue: role.name })
}

/**
 * 描述在界面上的文本：内置角色的描述由代码维护（后端存的是英文默认描述），按当前
 * 语言取内置文案；未收录的内置角色与自定义角色一律用角色自己的描述。
 */
export function systemRoleDescription(
  t: TFunction,
  role: SystemRoleLike
): string {
  const stored = role.description?.trim() ?? ''
  if (!role.isSystem) return stored
  return t(`rbac.systemRoleDescriptions.${role.name}`, {
    defaultValue: stored,
  })
}

/**
 * 界面展示名：优先用自定义的「名称」（displayName）；未自定义时内置角色显示内置名
 * （随语言切换），自定义角色就是角色 ID 本身。
 */
export function systemRoleLabel(t: TFunction, role: SystemRoleLike): string {
  return role.displayName?.trim() || systemRoleDefaultLabel(t, role)
}
