/**
 * Shared definition of the node permission surface.
 *
 * The dedicated node permission tab and the generic role editor (when a role
 * only grants `nodes`) both present permissions as node operations instead of
 * raw verbs, so the mapping lives here.
 */

import { isClusterScopedResource } from '@/lib/resource-catalog'

/** Resource whose permissions are presented as node operations. */
export const NODE_RESOURCE = 'nodes'

/** Role-name prefix applied to roles created from the node permission tab. */
export const NODE_ROLE_NAME_PREFIX = 'node-'

export interface PermissionPreset {
  /** Backend verb this item maps to. */
  verb: string
  label: string
  description?: string
}

/** Minimal shape of i18next's `t` used by the preset builders. */
type TranslateFn = (key: string, defaultValue: string) => string

/**
 * True when every granted resource is cluster-scoped, meaning the role has no
 * namespace scope at all (e.g. a role that only grants `nodes`). A wildcard
 * grant is never treated as cluster-scoped-only.
 */
export function isClusterScopedOnly(resources: string[]): boolean {
  return (
    resources.length > 0 &&
    resources.every(
      (resource) => resource !== '*' && isClusterScopedResource(resource)
    )
  )
}

/** True when a role grants `nodes` and nothing else. */
export function isNodeOnlyRole(resources: string[]): boolean {
  return (
    isClusterScopedOnly(resources) &&
    resources.length === 1 &&
    resources[0] === NODE_RESOURCE
  )
}

/** Action-oriented permission items shown for node roles. */
export function nodePermissionPresets(t: TranslateFn): PermissionPreset[] {
  return [
    {
      verb: 'get',
      label: t('rbac.nodePermissions.view', 'View nodes'),
      description: t(
        'rbac.nodePermissions.viewHint',
        'View the node list and details, describe nodes, download YAML.'
      ),
    },
    {
      verb: 'create',
      label: t('rbac.nodePermissions.create', 'Clone nodes'),
      description: t(
        'rbac.nodePermissions.createHint',
        'Clone an existing node.'
      ),
    },
    {
      verb: 'update',
      label: t('rbac.nodePermissions.update', 'Node operations'),
      description: t(
        'rbac.nodePermissions.updateHint',
        'Edit, taint, drain, cordon and uncordon nodes.'
      ),
    },
    {
      verb: 'delete',
      label: t('rbac.nodePermissions.delete', 'Delete nodes'),
      description: t('rbac.nodePermissions.deleteHint', 'Delete nodes.'),
    },
    {
      verb: 'exec',
      label: t('rbac.nodePermissions.exec', 'Node terminal'),
      description: t(
        'rbac.nodePermissions.execHint',
        'Open a terminal session on a node.'
      ),
    },
  ]
}
