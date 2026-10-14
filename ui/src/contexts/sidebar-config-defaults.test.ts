import { describe, expect, it } from 'vitest'

import { migrateSidebarConfig } from './sidebar-config-defaults'

// v5 老配置：还没有 cert-manager 分组，集群类条目混在工作负载前。
const v5Stored = {
  version: 5,
  lastUpdated: 1,
  hiddenItems: [] as string[],
  pinnedItems: [] as string[],
  groupOrder: ['sidebar-groups-cluster', 'sidebar-groups-workloads'],
  groups: [
    {
      id: 'sidebar-groups-cluster',
      nameKey: 'sidebar.groups.cluster',
      visible: true,
      collapsed: false,
      order: 0,
      items: [
        {
          id: 'sidebar-groups-cluster--nodes',
          titleKey: 'nav.nodes',
          icon: 'IconServer',
          visible: true,
          pinned: false,
          order: 0,
        },
      ],
    },
    {
      id: 'sidebar-groups-workloads',
      nameKey: 'sidebar.groups.workloads',
      visible: true,
      collapsed: false,
      order: 1,
      items: [
        {
          id: 'sidebar-groups-workloads--pods',
          titleKey: 'nav.pods',
          icon: 'IconBox',
          visible: true,
          pinned: false,
          order: 0,
        },
      ],
    },
  ],
}

describe('migrateSidebarConfig', () => {
  it('为老配置补齐新增分组与条目', () => {
    const config = migrateSidebarConfig(v5Stored)

    const certGroup = config.groups.find(
      (group) => group.id === 'sidebar-groups-certmanager'
    )
    expect(certGroup).toBeDefined()
    expect(certGroup!.items.map((item) => item.url)).toEqual(
      expect.arrayContaining(['/certificates', '/issuers', '/clusterissuers'])
    )

    expect(config.hiddenItems).toEqual(
      expect.arrayContaining([
        'sidebar-groups-certmanager--certificaterequests',
        'sidebar-groups-certmanager--orders',
        'sidebar-groups-certmanager--challenges',
      ])
    )

    // 新分组进入 groupOrder，老分组保持不动
    expect(config.groupOrder).toContain('sidebar-groups-certmanager')
    expect(config.groupOrder).toContain('sidebar-groups-cluster')
  })

  it('重复迁移幂等，不产生重复条目', () => {
    const once = migrateSidebarConfig(v5Stored)
    const twice = migrateSidebarConfig(once)

    const certUrls = twice.groups
      .find((group) => group.id === 'sidebar-groups-certmanager')!
      .items.map((item) => item.url)
    expect(new Set(certUrls).size).toBe(certUrls.length)
    const certHidden = twice.hiddenItems.filter((id) =>
      id.startsWith('sidebar-groups-certmanager')
    )
    expect(certHidden.length).toBe(new Set(certHidden).size)
  })

  it('清理目录中已不存在的 link 条目（资源关系图已移除）', () => {
    const withStale = {
      ...v5Stored,
      version: 7,
      hiddenItems: ['sidebar-groups-cluster--resource-map'],
      groups: [
        {
          ...v5Stored.groups[0],
          items: [
        {
          id: 'sidebar-groups-cluster--nodes',
          titleKey: 'nav.nodes',
          icon: 'IconServer',
          url: '/nodes',
          visible: true,
          pinned: false,
          order: 0,
        },
        {
          id: 'sidebar-groups-cluster--resource-map',
          titleKey: 'nav.resourceMap',
          icon: 'IconTopologyBus',
          url: '/resource-map',
          visible: true,
          pinned: true,
          order: 1,
        },
      ],
        },
        v5Stored.groups[1],
      ],
    }

    const config = migrateSidebarConfig(withStale)

    const clusterGroup = config.groups.find(
      (group) => group.id === 'sidebar-groups-cluster'
    )!
    expect(
      clusterGroup.items.some((item) => item.url === '/resource-map')
    ).toBe(false)
    expect(config.hiddenItems).not.toContain(
      'sidebar-groups-cluster--resource-map'
    )
    // 老分组与正常条目保持不动
    expect(config.groupOrder).toContain('sidebar-groups-workloads')
    expect(
      clusterGroup.items.some((item) => item.url === '/nodes')
    ).toBe(true)
  })
})
