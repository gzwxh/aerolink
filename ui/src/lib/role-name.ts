/**
 * 角色名可以带固定前缀，例如从节点权限标签页创建的每个角色都以
 * "node-" 开头。下面两个辅助函数让展示值、实时编辑行为与提交的
 * 数据保持一致，使前缀既不会缺失，也不会被重复添加。
 *
 */

/**
 * 角色名的完整规范化：保证带上配置的前缀，把被部分删除的前缀
 * （""、"no"、"node"）视为"只保留前缀"，
 * 而已经带前缀的名称原样返回。用于加载、失焦与
 * 提交时。
 */
export function normalizeRoleName(name: string, prefix?: string): string {
  if (!prefix) return name
  const trimmed = name.trim()
  if (!trimmed || prefix.startsWith(trimmed)) return prefix
  return trimmed.startsWith(prefix) ? trimmed : prefix + trimmed
}

/**
 * 输入过程中使用的实时版本：对已被部分删除的前缀保持原样，
 * 而不是重新补上，这样退格不会与用户较劲。已经带前缀的值
 * 原样返回。
 */
export function applyRoleNamePrefix(value: string, prefix?: string): string {
  if (!prefix) return value
  if (value.startsWith(prefix) || prefix.startsWith(value)) return value
  return prefix + value
}
