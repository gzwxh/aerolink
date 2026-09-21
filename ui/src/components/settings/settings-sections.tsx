import type { ComponentType, ReactNode } from 'react'
import {
  IconAdjustments,
  IconApi,
  IconBell,
  IconHistory,
  IconLayoutSidebar,
  IconServer,
  IconShieldCheck,
  IconShieldLock,
  IconTemplate,
  IconUser,
} from '@tabler/icons-react'
import type { TFunction } from 'i18next'

import { APIKeyManagement } from './apikey-management'
import { AuditLog } from './audit-log'
import { SystemLogSetting } from './audit-setting'
import { ClusterManagement } from './cluster-management'
import { GeneralManagement } from './general-management'
import { NavigationManagement } from './navigation-management'
import { NotificationManagement } from './notification-management'
import { RBACView } from './rbac-view'
import { SecurityManagement } from './security-management'
import { TemplateManagement } from './template-management'
import { UserManagementTabs } from './user-management-tabs'

export interface SettingsSectionDefinition {
  /** URL slug：/settings/<value> */
  value: string
  labelKey: string
  defaultLabel: string
  /** 该分区管理什么的一行说明（展示在标题下方）。 */
  descriptionKey: string
  defaultDescription: string
  icon: ComponentType<{ className?: string }>
  render: () => ReactNode
  /**
   * 打开本章节所需的控制台设置章节名（对应\u540e\u7aef settings.<section>）。
   * 每个章节都必须声明：章节级授权是等保三级三权分立的基础，
   * 界面可见性必须与接口门禁（middleware.RequireSettingsSection）一致。
   * 取值以 rbac-permissions.ts 的 SETTINGS_SECTIONS 为准。
   */
  section: string
  /**
   * 页面里还承载了别的章节的内容时，把这些章节列在这里：持有其中任一章节的读权限就能
   * 打开该页面，页面内各页签再按自己的章节单独把关。目前只有「安全管理」用到——认证源
   * 配置（LDAP / OAuth）从独立的 /settings/oauth 页面搬了进来，接口门禁仍是
   * settings.authentication。
   */
  extraSections?: string[]
}

export const settingsSectionRegistry: SettingsSectionDefinition[] = [
  {
    value: 'general',
    labelKey: 'settings.tabs.general',
    defaultLabel: 'General',
    descriptionKey: 'settings.descriptions.general',
    defaultDescription:
      'Manage the console-wide switches: AI assistant, kubectl and node terminal, cluster agent and runtime settings.',
    icon: IconAdjustments,
    render: () => <GeneralManagement />,
    section: 'general',
  },
  {
    value: 'navigation',
    labelKey: 'settings.tabs.navigation',
    defaultLabel: 'Sidebar Navigation',
    descriptionKey: 'settings.descriptions.navigation',
    defaultDescription:
      'Configure the left navigation: which groups and items are shown, their order, and the layout published to users without a personal configuration.',
    icon: IconLayoutSidebar,
    render: () => <NavigationManagement />,
    // 全局侧边栏偏好的接口门禁是 settings.general（见 routes.go 的 sidebarPreferenceAPI），
    // 章节授权与接口保持同一把锁。
    section: 'general',
  },
  {
    value: 'clusters',
    labelKey: 'settings.tabs.clusters',
    defaultLabel: 'Cluster',
    descriptionKey: 'settings.descriptions.clusters',
    defaultDescription:
      'Import Kubernetes clusters, enable or disable them, and remove the ones no longer in use.',
    icon: IconServer,
    render: () => <ClusterManagement />,
    section: 'clusters',
  },
  {
    value: 'apikeys',
    labelKey: 'settings.tabs.apikeys',
    defaultLabel: 'API Keys',
    descriptionKey: 'settings.descriptions.apikeys',
    defaultDescription:
      'Create and revoke the API keys used to call the Kite API.',
    icon: IconApi,
    render: () => <APIKeyManagement />,
    section: 'apikeys',
  },
  {
    value: 'templates',
    labelKey: 'settings.tabs.templates',
    defaultLabel: 'Templates',
    descriptionKey: 'settings.descriptions.templates',
    defaultDescription:
      'Maintain the templates offered when creating resources.',
    icon: IconTemplate,
    render: () => <TemplateManagement />,
    section: 'templates',
  },
  {
    value: 'user',
    labelKey: 'settings.tabs.user',
    defaultLabel: 'User Management',
    descriptionKey: 'settings.descriptions.user',
    defaultDescription:
      'Manage console users and user groups: add or edit accounts, enable or disable sign-in, reset passwords, assign roles and maintain group membership.',
    icon: IconUser,
    render: () => <UserManagementTabs />,
    section: 'users',
  },
  {
    value: 'rbac',
    labelKey: 'nav.rbac',
    defaultLabel: 'RBAC',
    descriptionKey: 'settings.descriptions.rbac',
    defaultDescription:
      'Define roles (clusters, resources, actions) and permission binding groups that bind users or groups to those roles.',
    icon: IconShieldCheck,
    render: () => <RBACView />,
    section: 'rbac',
  },
  {
    value: 'audit',
    labelKey: 'settings.tabs.audit',
    defaultLabel: 'Audit Management',
    descriptionKey: 'settings.descriptions.audit',
    defaultDescription:
      'Review audit logs: sign-ins, console operations and resource changes.',
    icon: IconHistory,
    render: () => <AuditLog />,
    section: 'audit',
  },
  {
    value: 'security',
    labelKey: 'settings.tabs.security',
    defaultLabel: 'Security Management',
    descriptionKey: 'settings.descriptions.security',
    defaultDescription:
      'Harden sign-in and manage the authentication sources: LDAP, OAuth / OIDC providers, password policy, login limits, MFA policy and session settings.',
    icon: IconShieldLock,
    render: () => <SecurityManagement />,
    section: 'security',
    // 认证源（OAuth / LDAP）属于主体身份管理，归安全管理员；它的接口门禁仍是
    // settings.authentication，所以作为额外章节一并列出。
    extraSections: ['authentication'],
  },
  {
    value: 'notification',
    labelKey: 'settings.tabs.notification',
    defaultLabel: 'Notification Management',
    descriptionKey: 'settings.descriptions.notification',
    defaultDescription:
      'Configure notification channels, event subscriptions and test delivery.',
    icon: IconBell,
    render: () => <NotificationManagement />,
    section: 'notification',
  },
  {
    value: 'systemLog',
    labelKey: 'settings.tabs.systemLog',
    defaultLabel: 'System Logs',
    descriptionKey: 'audit.systemLog.description',
    defaultDescription:
      'Archive and format the access log (HTTP request log): retention, batch thresholds and output format.',
    icon: IconServer,
    render: () => <SystemLogSetting />,
    // 访问日志归档本来就在 settings.audit 那份配置（audit_settings.archive.accessLog）里，
    // 拆成独立导航项只是换个入口、不新增授权章节——门禁与接口保持同一把锁。
    section: 'audit',
  },
]

/**
 * 各章节的子页签：左侧子导航与页面标题（系统设置 / 章节 / 子页签）共用同一份定义。
 * 键为章节的 value,param 是该章节在 URL 上使用的查询参数。
 */
export interface SettingsSubTab {
  value: string
  labelKey: string
  defaultLabel: string
  /**
   * 该页签内容所属的设置章节；缺省时与所在章节相同。用于「一个页面里承载了另一个章节
   * 的内容」的场景（安全管理的「认证配置」页签 = settings.authentication）：没有该章节
   * 读权限的用户不显示这个页签，否则点进去只会看到 403。
   */
  section?: string
  /**
   * 该页签可以打开某条具体记录时使用的查询参数：设置页会把它当作面包屑的最后一段
   * （例如 /settings/user?tab=group&group=<组名> 显示为「… / 用户组 / <组名>」）。
   */
  detailParam?: string
}

export interface SettingsSubTabs {
  param: string
  tabs: SettingsSubTab[]
}

export const settingsSubTabs: Record<string, SettingsSubTabs> = {
  rbac: {
    param: 'rbacTab',
    tabs: [
      {
        value: 'roles',
        labelKey: 'settings.subTabs.rbacRoles',
        defaultLabel: 'Roles',
        detailParam: 'role',
      },
      {
        value: 'privileges',
        labelKey: 'settings.subTabs.rbacPrivileges',
        defaultLabel: 'Privileges',
      },
      {
        value: 'binding-groups',
        labelKey: 'settings.tabs.bindingGroups',
        defaultLabel: 'Permission Binding',
        // 点开某个权限绑定后，面包屑带上它的名字；新增页不写这个参数。
        detailParam: 'bindingGroup',
      },
      {
        value: 'administrators',
        labelKey: 'settings.subTabs.rbacAdministrators',
        defaultLabel: '系统管理员',
      },
      {
        value: 'auditors',
        labelKey: 'settings.subTabs.rbacAuditors',
        defaultLabel: '审计管理员',
      },
      {
        value: 'security-admins',
        labelKey: 'settings.subTabs.rbacSecurityAdmins',
        defaultLabel: '安全管理员',
      },
    ],
  },
  user: {
    param: 'tab',
    tabs: [
      {
        value: 'users',
        labelKey: 'settings.tabs.users',
        defaultLabel: 'Users',
      },
      {
        value: 'group',
        labelKey: 'settings.subTabs.rbacGroups',
        defaultLabel: 'User Groups',
        detailParam: 'group',
      },
    ],
  },
  security: {
    param: 'tab',
    tabs: [
      {
        value: 'authentication',
        labelKey: 'securitySettings.tabs.authentication',
        defaultLabel: 'Authentication',
      },
      {
        value: 'loginPolicy',
        labelKey: 'securitySettings.tabs.loginPolicy',
        defaultLabel: 'Login Policy',
      },
      {
        value: 'password',
        labelKey: 'securitySettings.tabs.password',
        defaultLabel: 'Password',
      },
      {
        value: 'session',
        labelKey: 'securitySettings.tabs.session',
        defaultLabel: 'Session',
      },
      {
        value: 'authProviders',
        labelKey: 'securitySettings.tabs.authProviders',
        defaultLabel: '认证配置',
        // 认证源配置搬进安全管理后接口门禁未变，仍是 settings.authentication。
        section: 'authentication',
      },
    ],
  },
  notification: {
    param: 'tab',
    tabs: [
      {
        value: 'email',
        labelKey: 'notifications.tabs.email',
        defaultLabel: 'Mail',
      },
      {
        value: 'announcements',
        labelKey: 'notifications.tabs.announcements',
        defaultLabel: '通知栏',
      },
      {
        value: 'templates',
        labelKey: 'notifications.tabs.templates',
        defaultLabel: 'Templates',
      },
      {
        value: 'subscriptions',
        labelKey: 'notifications.tabs.subscriptions',
        defaultLabel: 'Subscriptions',
      },
    ],
  },
  audit: {
    param: 'tab',
    tabs: [
      {
        value: 'login',
        labelKey: 'audit.tabs.login',
        defaultLabel: 'Login Logs',
      },
      {
        value: 'operation',
        labelKey: 'audit.tabs.operation',
        defaultLabel: 'Operation Logs',
      },
      {
        value: 'file',
        labelKey: 'audit.tabs.file',
        defaultLabel: 'File Operations',
      },
      {
        value: 'password',
        labelKey: 'audit.tabs.password',
        defaultLabel: 'Password Change Logs',
      },
      {
        value: 'archive',
        labelKey: 'audit.tabs.archive',
        defaultLabel: 'Archive Search',
      },
      {
        value: 'setting',
        labelKey: 'audit.tabs.setting',
        defaultLabel: 'Audit Settings',
      },
    ],
  },
}

/**
 * 用户可以打开的设置分区：每个控制台设置分区一条记录，
 * 并按对应管理 API 所需的分区级授权过滤。这
 * 就是让导航与 API 网关保持同步的机制——用户无法调用的
 * 分区永远不会被渲染。
 */
export function getSettingsSections(
  t: TFunction,
  canViewSection: (section: string) => boolean
) {
  return settingsSectionRegistry
    .filter((section) =>
      [section.section, ...(section.extraSections ?? [])].some(canViewSection)
    )
    .map((section) => ({
      ...section,
      label: t(section.labelKey, section.defaultLabel),
    }))
}
