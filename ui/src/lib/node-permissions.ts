/**
 * 资源专属权限面板的共享定义。
 *
 * 有些资源以"操作"（其页面上的按钮）而不是原始 verb 的形式呈现。
 * 角色编辑器会为每个已授权资源列出一组这样的操作，
 * 因此映射关系放在这里。
 */

import {
  SYSTEM_SETTINGS_RESOURCE,
  SYSTEM_SETTINGS_VERB,
} from '@/lib/rbac-permissions'
import { isClusterScopedResource } from '@/lib/resource-catalog'

/** 权限以节点操作呈现的资源。 */
export const NODE_RESOURCE = 'nodes'

/**
 * 权限以命名空间操作呈现的资源。它的「创建」不由角色授权：命名空间统一由管理员创建，
 * 再由权限绑定组分配给用户使用，因此这里刻意不列出 create（见 pkg/rbac/rbac.go 中
 * CanAccess 的分支）。列出会变成「勾了不生效」的空开关。
 */
export const NAMESPACES_RESOURCE = 'namespaces'

/** 权限以 pod 操作呈现的资源。 */
export const POD_RESOURCE = 'pods'

/** 节点权限标签页创建的角色所使用的角色名前缀。 */
export const NODE_ROLE_NAME_PREFIX = 'node-'

// 为没有面向操作预设的资源提供的 verb。
// 只列后端真正会校验的通用动词（见 pkg/middleware/rbac.go 的 method2verb 与各资源 handler）：
// log 只对 pods 生效，exec 只对 pods（Pod 终端 / 调试容器）和 nodes（节点终端）生效，
// 容器文件动词只对 pods 生效。这些资源都有各自的预设（见下方 RESOURCE_PRESET_BUILDERS），
// 所以基础列表里不再堆入 log / exec，避免给 deployments、configmaps 之类的资源
// 勾出永远不会被检查的“执行权限”。
export const BASE_VERBS = ['get', 'create', 'update', 'delete']

export interface PermissionPreset {
  /** 该项映射到的后端 verb。 */
  verb: string
  label: string
  description?: string
}

/** 预设构造器使用的 i18next `t` 的最小结构。 */
type TranslateFn = (key: string, defaultValue: string) => string

/**
 * 当所有已授权资源都是集群级时为 true，意味着该角色完全没有
 * 命名空间范围（例如只授予 `nodes` 的角色）。通配
 * 授权永远不被视为"仅集群级"。
 */
export function isClusterScopedOnly(resources: string[]): boolean {
  return (
    resources.length > 0 &&
    resources.every(
      (resource) => resource !== '*' && isClusterScopedResource(resource)
    )
  )
}

/** 当角色只授予 `nodes`、别无其它时为 true。 */
export function isNodeOnlyRole(resources: string[]): boolean {
  return (
    isClusterScopedOnly(resources) &&
    resources.length === 1 &&
    resources[0] === NODE_RESOURCE
  )
}

/** 节点角色展示的面向操作的权限项。 */
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

/** 命名空间角色展示的面向操作的权限项：没有「创建」（那是管理员专属动作）。 */
export function namespacePermissionPresets(t: TranslateFn): PermissionPreset[] {
  return ['get', 'update', 'delete'].map((verb) => ({
    verb,
    label: t(`rbac.verb.${verb}`, verb),
  }))
}

/** pod 角色展示的面向操作的权限项。 */
export function podPermissionPresets(t: TranslateFn): PermissionPreset[] {
  return [
    {
      verb: 'get',
      label: t('rbac.podPermissions.view', 'View pods'),
      description: t(
        'rbac.podPermissions.viewHint',
        'View the pod list and details, describe pods, download YAML.'
      ),
    },
    {
      verb: 'create',
      label: t('rbac.podPermissions.create', 'Create pods'),
      description: t('rbac.podPermissions.createHint', 'Create pods.'),
    },
    {
      verb: 'update',
      label: t('rbac.podPermissions.update', 'Edit pods'),
      description: t(
        'rbac.podPermissions.updateHint',
        'Edit pods, adjust resources, attach debug containers.'
      ),
    },
    {
      verb: 'delete',
      label: t('rbac.podPermissions.delete', 'Delete pods'),
      description: t('rbac.podPermissions.deleteHint', 'Delete pods.'),
    },
    {
      verb: 'log',
      label: t('rbac.verb.log', 'View logs'),
      description: t('rbac.podPermissions.logHint', 'View pod logs.'),
    },
    {
      verb: 'exec',
      label: t('rbac.podPermissions.exec', 'Pod terminal'),
      description: t(
        'rbac.podPermissions.execHint',
        'Open a terminal session in a pod (also requires View pods).'
      ),
    },
    {
      verb: 'view-file',
      label: t('rbac.verb.view-file', 'View files'),
      description: t(
        'rbac.podPermissions.viewFileHint',
        'Browse files in a pod.'
      ),
    },
    {
      verb: 'download-file',
      label: t('rbac.verb.download-file', 'Download files'),
      description: t(
        'rbac.podPermissions.downloadFileHint',
        'Download files from a pod.'
      ),
    },
    {
      verb: 'upload-file',
      label: t('rbac.verb.upload-file', 'Upload files'),
      description: t(
        'rbac.podPermissions.uploadFileHint',
        'Upload files to a pod.'
      ),
    },
  ]
}

/** 合成 settings 资源对应的面向操作权限项。 */
export function settingsPermissionPresets(t: TranslateFn): PermissionPreset[] {
  return [
    {
      verb: 'get',
      label: t('rbac.settingsPermissions.view', 'View settings'),
      description: t(
        'rbac.settingsPermissions.viewHint',
        'Read the console system settings and permission configuration.'
      ),
    },
    {
      verb: SYSTEM_SETTINGS_VERB,
      label: t('rbac.settingsPermissions.manage', 'Manage settings'),
      description: t(
        'rbac.settingsPermissions.manageHint',
        'Change the console system settings and permissions.'
      ),
    },
  ]
}

export interface ResourcePermissionPreset {
  /** 用于界面状态的稳定 id；面板标题会被翻译。 */
  id: string
  presets: PermissionPreset[]
  panelTitle: string
  hint?: string
}

/**
 * 面向操作的资源：其预设组支持 i18n 的构造器。
 * 这里的顺序就是多组同时展示时的显示顺序，
 * 因此与资源选择器一致（系统设置、命名空间级、集群级）。
 */
const RESOURCE_PRESET_BUILDERS: {
  resource: string
  build: (t: TranslateFn) => ResourcePermissionPreset
}[] = [
  {
    resource: SYSTEM_SETTINGS_RESOURCE,
    build: (t) => ({
      id: SYSTEM_SETTINGS_RESOURCE,
      presets: settingsPermissionPresets(t),
      panelTitle: t(
        'rbac.settingsPermissions.panelTitle',
        'Settings permissions'
      ),
    }),
  },
  {
    resource: POD_RESOURCE,
    build: (t) => ({
      id: POD_RESOURCE,
      presets: podPermissionPresets(t),
      panelTitle: t('rbac.podPermissions.panelTitle', 'Pod permissions'),
      hint: t(
        'rbac.podPermissionHint',
        'Buttons on the pod pages are shown only when the matching permission is granted.'
      ),
    }),
  },
  {
    resource: NAMESPACES_RESOURCE,
    build: (t) => ({
      id: NAMESPACES_RESOURCE,
      presets: namespacePermissionPresets(t),
      panelTitle: t(
        'rbac.namespacePermissions.panelTitle',
        'Namespace permissions'
      ),
      hint: t(
        'rbac.namespacePermissionHint',
        'Creating namespaces is an administrator action and is not granted by roles: new namespaces are created by an administrator and then assigned to users through permission binding groups.'
      ),
    }),
  },
  {
    resource: NODE_RESOURCE,
    build: (t) => ({
      id: NODE_RESOURCE,
      presets: nodePermissionPresets(t),
      panelTitle: t('rbac.nodePermissions.panelTitle', 'Node permissions'),
      hint: t(
        'rbac.nodePermissionHint',
        'Buttons on the node pages are shown only when the matching permission is granted.'
      ),
    }),
  },
]

/**
 * 单个已授权资源（nodes、pods、合成 settings
 * 资源）的预设组。没有面向操作权限的资源返回 undefined；
 * 角色编辑器随后改为列出它们的普通 verb。
 */
export function resourcePermissionPreset(
  resource: string,
  t: TranslateFn
): ResourcePermissionPreset | undefined {
  const entry = RESOURCE_PRESET_BUILDERS.find(
    (item) => item.resource === resource
  )
  return entry?.build(t)
}

/**
 * 单个资源上可授予的操作条目：有专属分组的资源用它的语义化条目，其余资源用通用动词。
 * 角色编辑器与权限一览表共用，保证两处列出的操作集合一致。
 */
export function resourcePermissionItems(
  resource: string,
  t: TranslateFn
): PermissionPreset[] {
  const preset = resourcePermissionPreset(resource, t)
  if (preset) {
    return preset.presets
  }
  return BASE_VERBS.map((verb) => ({
    verb,
    label: t(`rbac.verb.${verb}`, verb),
  }))
}
