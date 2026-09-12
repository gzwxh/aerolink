/**
 * Role names can be scoped with a fixed prefix, e.g. every role created from the
 * node permission tab starts with "node-". The two helpers below keep the
 * displayed value, the live editing behaviour and the submitted payload in
 * sync so the prefix is never missing and never doubled.
 */

/**
 * Full normalization of a role name: guarantees the configured prefix, treats a
 * partially deleted prefix ("", "no", "node") as "prefix only", and leaves a
 * name that already carries the prefix untouched. Used on load, on blur and on
 * submit.
 */
export function normalizeRoleName(name: string, prefix?: string): string {
  if (!prefix) return name
  const trimmed = name.trim()
  if (!trimmed || prefix.startsWith(trimmed)) return prefix
  return trimmed.startsWith(prefix) ? trimmed : prefix + trimmed
}

/**
 * Live variant used while typing: keeps a partially deleted prefix as-is
 * instead of re-adding it, so backspacing does not fight the user. A value that
 * already carries the prefix is returned unchanged.
 */
export function applyRoleNamePrefix(value: string, prefix?: string): string {
  if (!prefix) return value
  if (value.startsWith(prefix) || prefix.startsWith(value)) return value
  return prefix + value
}
