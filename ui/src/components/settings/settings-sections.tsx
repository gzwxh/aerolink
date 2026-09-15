import type { ComponentType, ReactNode } from 'react'
import {
  IconAdjustments,
  IconApi,
  IconBell,
  IconHistory,
  IconKey,
  IconServer,
  IconShieldCheck,
  IconShieldLock,
  IconTemplate,
  IconUser,
} from '@tabler/icons-react'
import type { TFunction } from 'i18next'

import { APIKeyManagement } from './apikey-management'
import { AuditLog } from './audit-log'
import { AuthenticationManagement } from './authentication-management'
import { ClusterManagement } from './cluster-management'
import { GeneralManagement } from './general-management'
import { NotificationManagement } from './notification-management'
import { RBACView } from './rbac-view'
import { SecurityManagement } from './security-management'
import { TemplateManagement } from './template-management'
import { UserManagementTabs } from './user-management-tabs'

export interface SettingsSectionDefinition {
  /** URL slug: /settings/<value> */
  value: string
  labelKey: string
  defaultLabel: string
  icon: ComponentType<{ className?: string }>
  render: () => ReactNode
}

export const settingsSectionRegistry: SettingsSectionDefinition[] = [
  {
    value: 'general',
    labelKey: 'settings.tabs.general',
    defaultLabel: 'General',
    icon: IconAdjustments,
    render: () => <GeneralManagement />,
  },
  {
    value: 'clusters',
    labelKey: 'settings.tabs.clusters',
    defaultLabel: 'Cluster',
    icon: IconServer,
    render: () => <ClusterManagement />,
  },
  {
    value: 'oauth',
    labelKey: 'settings.tabs.oauth',
    defaultLabel: 'Authentication',
    icon: IconKey,
    render: () => <AuthenticationManagement />,
  },
  {
    value: 'apikeys',
    labelKey: 'settings.tabs.apikeys',
    defaultLabel: 'API Keys',
    icon: IconApi,
    render: () => <APIKeyManagement />,
  },
  {
    value: 'templates',
    labelKey: 'settings.tabs.templates',
    defaultLabel: 'Templates',
    icon: IconTemplate,
    render: () => <TemplateManagement />,
  },
  {
    value: 'user',
    labelKey: 'settings.tabs.user',
    defaultLabel: 'Users & Groups',
    icon: IconUser,
    render: () => <UserManagementTabs />,
  },
  {
    value: 'rbac',
    labelKey: 'nav.rbac',
    defaultLabel: 'RBAC',
    icon: IconShieldCheck,
    render: () => <RBACView />,
  },
  {
    value: 'audit',
    labelKey: 'settings.tabs.audit',
    defaultLabel: 'Audit',
    icon: IconHistory,
    render: () => <AuditLog />,
  },
  {
    value: 'security',
    labelKey: 'settings.tabs.security',
    defaultLabel: 'Security',
    icon: IconShieldLock,
    render: () => <SecurityManagement />,
  },
  {
    value: 'notification',
    labelKey: 'settings.tabs.notification',
    defaultLabel: 'Notification',
    icon: IconBell,
    render: () => <NotificationManagement />,
  },
]

export function getSettingsSections(t: TFunction) {
  return settingsSectionRegistry.map((section) => ({
    ...section,
    label: t(section.labelKey, section.defaultLabel),
  }))
}
