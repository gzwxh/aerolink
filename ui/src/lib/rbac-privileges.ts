/**
 * 控制台支持的「权限」定义：角色编辑器与「权限一览」页共用同一份，保证两处列出的权限、
 * 名称、来源、范围徽标完全一致。
 *
 * 一条权限 = 一个资源上的一个操作，权限串是 <来源>:<资源>:<操作>（例如 k8s:pods:get、
 * aerolink:settings:update），ALL 表示该资源上的全部操作。来源在后端也是分开判定的：设置族
 * （settings / settings.<章节>）必须显式授权，通配 * 不覆盖它（见 pkg/rbac/rbac.go 的
 * roleAllows 与 settingsRoleAllows）。
 */

import { resourcePermissionItems } from '@/lib/node-permissions'
import {
  isSettingsResource,
  SETTINGS_SECTION_PREFIX,
  SETTINGS_SECTIONS,
  settingsSectionResource,
  SYSTEM_SETTINGS_RESOURCE,
} from '@/lib/rbac-permissions'
import {
  getResourceMetadata,
  isClusterScopedResource,
  resourceCatalog,
} from '@/lib/resource-catalog'

/** 权限来源：Kubernetes API 资源用 k8s，控制台自身（设置族）用 aerolink。 */
export type PermissionSource = 'k8s' | 'aerolink'

/** 资源范围：决定条目行尾的徽标。 */
export type PermissionScope = 'wildcard' | 'settings' | 'cluster' | 'namespaced'

/** 范围徽标的文案 key（两处共用，同一个资源在哪儿都显示同一个徽标）。 */
export const SCOPE_LABEL_KEYS: Record<PermissionScope, string> = {
  wildcard: 'rbac.badgeWildcard',
  settings: 'rbac.badgeSettings',
  cluster: 'rbac.badgeCluster',
  namespaced: 'rbac.badgeNamespaced',
}

/** 可授权资源清单：通配 *、设置族、资源目录（CRD 不预设，由 URL 输入的 CRD 名表示）。 */
export const CANDIDATE_RESOURCES = [
  '*',
  SYSTEM_SETTINGS_RESOURCE,
  ...SETTINGS_SECTIONS.map((section) => settingsSectionResource(section)),
  ...resourceCatalog
    .filter((resource) => resource.type !== 'crs')
    .map((resource) => resource.type),
]

/** i18next 的最小形态：动态键用 defaultValue 兜底，避免缺翻译时显示成 key。 */
export type TranslateFn = (key: string, defaultValue: string) => string

/** 一条权限：权限一览页的一行，也是角色编辑器里的一个条目。 */
export interface Privilege {
  /** 权限 ID：<来源>:<资源>:<操作小写>，例如 k8s:pods:all。 */
  id: string
  /** 权限串：<来源>:<资源>:<操作大写>，ALL 表示全部操作。 */
  permission: string
  /** 名称：「资源 · 操作」的本地化展示。 */
  name: string
  source: PermissionSource
  scope: PermissionScope
  /** 授权时写回角色的资源名。 */
  resource: string
  /** 授权时写回角色的动词；* 表示该资源上的全部操作。 */
  verb: string
}

export function permissionScopeOf(resource: string): PermissionScope {
  if (resource === '*') return 'wildcard'
  if (isSettingsResource(resource)) return 'settings'
  return isClusterScopedResource(resource) ? 'cluster' : 'namespaced'
}

/** 资源归属：设置族归控制台自身（aerolink），其余（含通配 *）都是 Kubernetes API 资源。 */
export function permissionSourceOf(resource: string): PermissionSource {
  return isSettingsResource(resource) ? 'aerolink' : 'k8s'
}

/** 资源的展示名：设置族用章节名，其余用资源目录里的标题。 */
export function privilegeResourceLabel(
  resource: string,
  t: TranslateFn
): string {
  if (resource === '*') {
    return t('rbac.allResourcesWildcard', 'All resources (*)')
  }
  if (resource === SYSTEM_SETTINGS_RESOURCE) {
    return t('rbac.settingsResources.all', 'All settings sections')
  }
  if (resource.startsWith(SETTINGS_SECTION_PREFIX)) {
    const section = resource.slice(SETTINGS_SECTION_PREFIX.length)
    return t(`rbac.settingsSections.${section}`, resource)
  }
  const metadata = getResourceMetadata(resource)
  if (!metadata) {
    return resource
  }
  return metadata.titleKey
    ? t(metadata.titleKey, metadata.pluralLabel)
    : metadata.pluralLabel
}

/** 操作的展示名：优先用该资源的语义化操作名（查看节点、Pod 终端……）。 */
export function privilegeVerbLabel(
  resource: string,
  verb: string,
  t: TranslateFn
): string {
  if (verb === '*') {
    return t('rbac.privilegeAllVerbs', 'All verbs')
  }
  const preset = resourcePermissionItems(resource, t).find(
    (item) => item.verb === verb
  )
  return preset?.label ?? t(`rbac.verb.${verb}`, verb)
}

/** 构造一条权限；动词 * 表示「全部操作」。 */
export function privilegeOf(
  resource: string,
  verb: string,
  t: TranslateFn
): Privilege {
  const source = permissionSourceOf(resource)
  // ID 与权限串同构，只把操作换成小写，这样 K8s 资源与控制台设置族的命名方式一致，
  // 资源名里的点也原样保留。
  return {
    id: `${source}:${resource}:${verb.toLowerCase()}`,
    permission: `${source}:${resource}:${verb.toUpperCase()}`,
    name: `${privilegeResourceLabel(resource, t)} · ${privilegeVerbLabel(resource, verb, t)}`,
    source,
    scope: permissionScopeOf(resource),
    resource,
    verb,
  }
}

/** 一个资源上的全部权限：先「全部操作（*）」，再该资源的每个操作。 */
export function privilegeResourceItems(
  resource: string,
  t: TranslateFn
): Privilege[] {
  return [
    privilegeOf(resource, '*', t),
    ...resourcePermissionItems(resource, t).map((item) =>
      privilegeOf(resource, item.verb, t)
    ),
  ]
}

/** 全量权限清单（权限一览页）。 */
export function allPrivileges(t: TranslateFn): Privilege[] {
  return CANDIDATE_RESOURCES.flatMap((resource) =>
    privilegeResourceItems(resource, t)
  )
}
