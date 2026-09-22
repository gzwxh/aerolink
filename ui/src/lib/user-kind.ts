import type { UserItem } from '@/types/api'

/**
 * 本地密码账号（Provider 为空或 "password"）：昵称与用户组由控制台管辖。
 * 目录账号（LDAP / OIDC）的这些字段由源系统维护，控制台只允许改头像。
 */
export function isNativeUser(user?: UserItem | null): boolean {
  return !user?.provider || user.provider === 'password'
}

/**
 * 能否在 AeroLink 里删除该账号：本地账号与 LDAP 账号可以（LDAP 只删本地记录，目录里的
 * 用户不受影响）；OIDC 账号由身份源管辖，内置超级管理员永远不可删。
 */
export function isDeletableUser(user?: UserItem | null): boolean {
  if (user?.isSuperAdmin) return false
  return isNativeUser(user) || user?.provider === 'ldap'
}
