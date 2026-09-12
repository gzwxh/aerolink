import { isClusterScopedResource } from '@/lib/resource-catalog'

/**
 * Client-side mirror of the authorization rules in pkg/rbac/rbac.go. It is used
 * to hide UI affordances the backend would reject; the backend remains the
 * source of truth.
 */

export interface CanAccessOptions {
  cluster?: string | null
  namespace?: string
}

/** Minimal role shape needed for the checks (matches AuthRole). */
export interface AccessRole {
  name: string
  clusters?: string[]
  resources?: string[]
  namespaces?: string[]
  verbs?: string[]
}

const REGEX_PATTERN_CHARS = /[\\^$*+?()[\]{}|]/

/**
 * Namespace sentinel the backend uses for cluster-wide requests, including the
 * "namespaces" resource itself (see namespaceUnconstrained in pkg/rbac/rbac.go).
 */
const ALL_NAMESPACES = '_all'

// Mirrors the backend matcher in pkg/rbac/rbac.go: plain values are literals,
// "*" matches anything, "!" prefixed patterns deny, and anything containing
// regex metacharacters is treated as an anchored regular expression.
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

// Mirrors namespaceRestricted in pkg/rbac/rbac.go: a role that lists concrete
// namespaces without granting all of them.
function isNamespaceRestricted(namespaces: string[] | undefined): boolean {
  const list = namespaces || []
  if (list.length === 0) {
    return false
  }
  return !list.includes('*') && !list.includes('_all')
}

// Mirrors namespaceUnconstrained in pkg/rbac/rbac.go: the namespaces resource
// is NOT unconstrained — a role's namespace list is matched against the
// namespace being touched, exactly like a namespaced resource.
function namespaceUnconstrained(resource: string): boolean {
  return resource !== 'namespaces' && isClusterScopedResource(resource)
}

// Mirrors matchExplicit in pkg/rbac/rbac.go: the bare "*" wildcard is ignored,
// so it cannot stand in for an explicit cluster-scoped grant.
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
 * True when the roles grant the verb on the resource in *some* namespace of the
 * cluster. List pages use this for affordances that are not bound to a single
 * namespace (the Create button, bulk delete): checking one arbitrary namespace
 * would hide them from users whose grant targets a different namespace.
 */
export function roleCanAccessAnyNamespace(
  roles: AccessRole[] | undefined,
  resource: string,
  verb: string,
  options?: Pick<CanAccessOptions, 'cluster'>
): boolean {
  if (!roles || roles.length === 0) {
    return false
  }
  const cluster = options?.cluster ?? undefined
  return roles.some((role) => {
    if (cluster && !matchesAny(role.clusters, cluster)) {
      return false
    }
    if (namespaceUnconstrained(resource)) {
      // Cluster-scoped objects ignore the namespace list, but a
      // namespace-restricted role has to name the resource explicitly.
      if (
        isNamespaceRestricted(role.namespaces) &&
        !matchesAnyExplicit(role.resources, resource)
      ) {
        return false
      }
    } else if (resource === 'namespaces') {
      // Cluster-wide namespace operations are checked against the sentinel.
      if (!matchesAny(role.namespaces, ALL_NAMESPACES)) {
        return false
      }
    } else if (
      !(role.namespaces || []).some(
        (pattern) => !pattern.startsWith('!') && pattern !== ALL_NAMESPACES
      )
    ) {
      // A namespaced grant needs at least one positive namespace pattern: an
      // empty list, a deny-only list ("!kube-system") or the "_all" sentinel
      // (never a namespace name) grants nothing.
      return false
    }
    if (!matchesAny(role.resources, resource)) {
      return false
    }
    return matchesAny(role.verbs, verb)
  })
}

export function roleCanAccess(
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
  // Cluster-scoped resources have no namespace, so a role's namespace list
  // cannot constrain them — but a namespace-restricted role must name them
  // explicitly instead of relying on a wildcard resource grant. The namespaces
  // resource is the exception: the backend matches the role against the
  // namespace being touched ("_all" for cluster-wide requests).
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
        resource === 'namespaces' ? (namespace ?? ALL_NAMESPACES) : namespace
      if (target && !matchesAny(role.namespaces, target)) {
        return false
      }
    }
    if (!matchesAny(role.resources, resource)) {
      return false
    }
    return matchesAny(role.verbs, verb)
  })
}
