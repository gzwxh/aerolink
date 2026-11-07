/// <reference types="@testing-library/jest-dom" />
import type { ReactNode } from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { SidebarConfig, SidebarItem } from '@/types/sidebar'

import { AppSidebar } from './app-sidebar'
import { SidebarProvider } from './ui/sidebar'

let mockConfig: SidebarConfig

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: unknown) =>
      typeof options === 'string'
        ? options
        : ((options as { defaultValue?: string })?.defaultValue ?? key),
  }),
}))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({
    user: { isAdmin: () => false, canViewSettingsSection: () => false },
  }),
}))

vi.mock('@/contexts/branding-context', () => ({
  useBranding: () => ({
    logoUrl: '/logo.svg',
    siteName: 'AeroLink',
    isCustomBranding: true,
  }),
}))

vi.mock('@/contexts/sidebar-config-context', () => ({
  useSidebarConfig: () => ({
    config: mockConfig,
    isLoading: false,
    getIconComponent: () => () => null,
  }),
}))

vi.mock('@/lib/api', () => ({
  useResources: () => ({ data: undefined }),
}))

vi.mock('@/lib/cluster-path', () => ({
  useClusterLocation: () => ({ pathname: '/', search: '', hash: '' }),
}))

vi.mock('@/components/cluster-link', () => ({
  ClusterLink: ({
    to,
    children,
  }: {
    to: string
    children: ReactNode
  }) => <a href={to}>{children}</a>,
}))

vi.mock('./cluster-selector', () => ({
  ClusterSelector: () => <span>cluster-selector</span>,
}))

vi.mock('./version-info', () => ({
  VersionInfo: () => null,
}))

vi.mock('@/components/settings/settings-sections', () => ({
  settingsSubTabs: {},
  getSettingsSections: () => [],
}))

function item(id: string, titleKey: string, order: number): SidebarItem {
  return {
    id,
    type: 'link',
    titleKey,
    url: `/${id}`,
    icon: 'IconBox',
    visible: true,
    pinned: false,
    order,
  }
}

function buildConfig(overrides: Partial<SidebarConfig> = {}): SidebarConfig {
  return {
    version: 1,
    lastUpdated: 0,
    hiddenItems: [],
    pinnedItems: ['workloads-pods', 'cluster-nodes'],
    groupOrder: ['workloads', 'cluster'],
    groups: [
      {
        id: 'workloads',
        nameKey: 'Workloads',
        items: [
          item('workloads-pods', 'Pods', 0),
          item('workloads-deployments', 'Deployments', 1),
        ],
        visible: true,
        collapsed: false,
        order: 0,
      },
      {
        id: 'cluster',
        nameKey: 'Cluster',
        items: [
          item('cluster-nodes', 'Nodes', 0),
          item('cluster-namespaces', 'Namespaces', 1),
        ],
        visible: true,
        collapsed: false,
        order: 1,
      },
    ],
    ...overrides,
  }
}

function renderSidebar(overrides: Partial<SidebarConfig> = {}) {
  mockConfig = buildConfig(overrides)
  const { container } = render(
    <SidebarProvider>
      <AppSidebar />
    </SidebarProvider>
  )
  const content = container.querySelector('[data-slot="sidebar-content"]')
  expect(content).not.toBeNull()
  return content as HTMLElement
}

function indexOfText(content: HTMLElement, text: string) {
  const index = content.textContent?.indexOf(text) ?? -1
  expect(index).toBeGreaterThanOrEqual(0)
  return index
}

describe('AppSidebar 置顶项位置', () => {
  it('置顶分组排在概览之后、所有业务分组之前', () => {
    const content = renderSidebar()

    const pinned = indexOfText(content, 'Pinned')
    expect(indexOfText(content, 'Nodes')).toBeGreaterThan(pinned)
    expect(indexOfText(content, 'Pods')).toBeGreaterThan(pinned)
    // 置顶项整体上移：分组标签与内容都排在第一个业务分组之后不再成立。
    expect(pinned).toBeLessThan(indexOfText(content, 'Workloads'))
    expect(indexOfText(content, 'Nodes')).toBeLessThan(
      indexOfText(content, 'Workloads')
    )
    expect(indexOfText(content, 'Deployments')).toBeGreaterThan(
      indexOfText(content, 'Workloads')
    )
  })

  it('隐藏置顶项所在分组后，置顶分组仍然显示', () => {
    const content = renderSidebar({
      groups: buildConfig().groups.map((group) =>
        group.id === 'cluster' ? { ...group, visible: false } : group
      ),
    })

    expect(indexOfText(content, 'Pinned')).toBeLessThan(
      indexOfText(content, 'Nodes')
    )
    // 分组被隐藏后其未置顶条目照常不显示。
    expect(content.textContent).not.toContain('Namespaces')
  })
})
