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
    expect(clusterGroup.items.some((item) => item.url === '/nodes')).toBe(true)
  })
})
// 回归（缺陷 D-63）：NetworkPolicies 在菜单里出现两处。
// 存量配置把它放在「安全」分组，而目录默认在「网络/流量」；补录只按**本分组**判断
// 是否已存在，于是又往「网络/流量」补了一份 —— 同一个菜单两个入口。
describe('migrateSidebarConfig 不重复补录已归属别处的条目', () => {
  const storedWithItemElsewhere = {
    version: 6,
    lastUpdated: 1,
    hiddenItems: [] as string[],
    pinnedItems: [] as string[],
    groupOrder: ['sidebar-groups-traffic', 'sidebar-groups-security'],
    groups: [
      {
        id: 'sidebar-groups-traffic',
        nameKey: 'sidebar.groups.traffic',
        visible: true,
        collapsed: false,
        order: 0,
        items: [
          {
            id: 'sidebar-groups-traffic--ingresses',
            titleKey: 'nav.ingresses',
            icon: 'IconRouter',
            url: '/ingresses',
            visible: true,
            pinned: false,
            order: 0,
          },
        ],
      },
      {
        id: 'sidebar-groups-security',
        nameKey: 'sidebar.groups.security',
        visible: true,
        collapsed: false,
        order: 1,
        items: [
          {
            // id 前缀来自创建时的默认分组，条目本身被放在「安全」里
            id: 'sidebar-groups-traffic--networkpolicies',
            titleKey: 'nav.networkpolicies',
            icon: 'IconShield',
            url: '/networkpolicies',
            visible: true,
            pinned: false,
            order: 0,
          },
        ],
      },
    ],
  }

  const countByURL = (
    config: { groups: { items: { url?: string }[] }[] },
    url: string
  ) =>
    config.groups.reduce(
      (total, group) =>
        total + group.items.filter((item) => item.url === url).length,
      0
    )

  it('同一个 URL 全局只出现一次，并保持原有归属', () => {
    const config = migrateSidebarConfig(storedWithItemElsewhere)

    expect(countByURL(config, '/networkpolicies')).toBe(1)
    const security = config.groups.find(
      (group) => group.id === 'sidebar-groups-security'
    )!
    expect(security.items.some((item) => item.url === '/networkpolicies')).toBe(
      true
    )
    const traffic = config.groups.find(
      (group) => group.id === 'sidebar-groups-traffic'
    )!
    expect(traffic.items.some((item) => item.url === '/networkpolicies')).toBe(
      false
    )
    // 同一分组内的其它默认条目照常补齐，去重不能把整组补录一起关掉
    expect(traffic.items.some((item) => item.url === '/services')).toBe(true)
  })

  it('重复迁移仍然只有一处', () => {
    const once = migrateSidebarConfig(storedWithItemElsewhere)
    const twice = migrateSidebarConfig(once)

    expect(countByURL(twice, '/networkpolicies')).toBe(1)
  })

  it('默认分组整组缺失时也不补第二份', () => {
    const withoutTraffic = {
      ...storedWithItemElsewhere,
      groupOrder: ['sidebar-groups-security'],
      groups: [storedWithItemElsewhere.groups[1]],
    }

    const config = migrateSidebarConfig(withoutTraffic)

    expect(countByURL(config, '/networkpolicies')).toBe(1)
  })
})
