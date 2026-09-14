import type { ComponentType, ReactNode } from 'react'
import {
  IconAdjustments,
  IconApi,
  IconHistory,
  IconKey,
  IconServer,
  IconShieldCheck,
  IconShieldLock,
  IconTemplate,
  IconUser,
  IconUsers,
} from '@tabler/icons-react'
import type { TFunction } from 'i18next'

import { APIKeyManagement } from './apikey-management'
import { AuditLog } from './audit-log'
import { AuthenticationManagement } from './authentication-management'
import { ClusterManagement } from './cluster-management'
import { GeneralManagement } from './general-management'
import { RBACView } from './rbac-view'
import { SecurityManagement } from './security-management'
import { TemplateManagement } from './template-management'
import { UserGroupsTab } from './user-groups-tab'
import { UserManagement } from './user-management'

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
    value: 'users',
    labelKey: 'settings.tabs.users',
    defaultLabel: 'User',
    icon: IconUser,
    render: () => <UserManagement />,
  },
  {
    value: 'group',
    labelKey: 'settings.tabs.group',
    defaultLabel: 'User Groups',
    icon: IconUsers,
    render: () => <UserGroupsTab />,
  },
  {
    value: 'rbac',
    labelKey: 'nav.rbac',
    defaultLabel: 'RBAC',
    icon: IconShieldCheck,
    render: () => <RBACView />,
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
]

export function getSettingsSections(t: TFunction) {
  return settingsSectionRegistry.map((section) => ({
    ...section,
    label: t(section.labelKey, section.defaultLabel),
  }))
}
