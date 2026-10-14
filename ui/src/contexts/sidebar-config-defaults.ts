import type { ComponentType } from 'react'
import { IconBox, type Icon, type IconProps } from '@tabler/icons-react'

import {
  DefaultMenus,
  SidebarConfig,
  SidebarGroup,
  SidebarItem,
} from '@/types/sidebar'
import {
  getResourceIconComponent,
  resourceCatalog,
  resourceIconMap,
  sidebarGroupOrder,
} from '@/lib/resource-catalog'

const sidebarIconMap = resourceIconMap
type CatalogResource = (typeof resourceCatalog)[number]
type StoredSidebarItem = {
  id: string
  titleKey: string
  url?: string
  icon: string
  visible: boolean
  pinned: boolean
  order: number
  type?: SidebarItem['type']
  apiGroup?: string
  crdGroup?: string
}
type StoredSidebarConfig = Omit<SidebarConfig, 'groups'> & {
  groups: Array<Omit<SidebarGroup, 'items'> & { items: StoredSidebarItem[] }>
}
type SidebarResource = CatalogResource & {
  sidebar: {
    groupKey: (typeof sidebarGroupOrder)[number]
    order: number
    titleKey?: string
    defaultHidden?: boolean
  }
}

function hasSidebar(resource: CatalogResource): resource is SidebarResource {
  return 'sidebar' in resource
}

const defaultMenus: DefaultMenus = Object.fromEntries(
  sidebarGroupOrder.map((groupKey) => [groupKey, []])
) as DefaultMenus

resourceCatalog
  .filter(hasSidebar)
  .slice()
  .sort((a, b) => a.sidebar.order - b.sidebar.order)
  .forEach((resource) => {
    const sidebar = resource.sidebar
    defaultMenus[sidebar.groupKey].push({
      titleKey:
        sidebar.titleKey ||
        ('titleKey' in resource ? resource.titleKey : undefined) ||
        resource.pluralLabel,
      url: `/${resource.type}`,
      icon: getResourceIconComponent(resource.icon),
      defaultHidden: sidebar.defaultHidden,
    })
  })

defaultMenus['sidebar.groups.application'].push({
  titleKey: 'nav.helmCharts',
  url: '/charts',
  icon: getResourceIconComponent('IconPackage'),
})

export const SIDEBAR_CONFIG_VERSION = 8

/** 「集群」分组（节点 / 命名空间 / 事件）：分组 id 由分组 key 推导而来（`.` → `-`）。 */
export const SIDEBAR_CLUSTER_GROUP_KEY = 'sidebar.groups.cluster'
export const SIDEBAR_CLUSTER_GROUP_ID = 'sidebar-groups-cluster'
const APPLICATION_GROUP_ID = 'sidebar-groups-application'

function getIconName(iconComponent: ComponentType<{ className?: string }>) {
  const entry = Object.entries(sidebarIconMap).find(
    ([, component]) => component === iconComponent
  )
  return entry ? entry[0] : 'IconBox'
}

export function getSidebarIconComponent(
  iconName: string
):
  | React.ForwardRefExoticComponent<IconProps & React.RefAttributes<Icon>>
  | React.ElementType {
  return sidebarIconMap[iconName as keyof typeof sidebarIconMap] || IconBox
}

export function buildDefaultSidebarConfig(): SidebarConfig {
  const groups: SidebarGroup[] = []
  const hiddenItems: string[] = []
  let groupOrder = 0

  Object.entries(defaultMenus).forEach(([groupKey, items]) => {
    const groupId = groupKey
      .toLowerCase()
      .replace(/\./g, '-')
      .replace(/\s+/g, '-')
    const sidebarItems: SidebarItem[] = items.map((item, index) => {
      const id = `${groupId}-${item.url.replace(/[^a-zA-Z0-9]/g, '-')}`
      if (item.defaultHidden) {
        hiddenItems.push(id)
      }
      return {
        id,
        type: 'link',
        titleKey: item.titleKey,
        url: item.url,
        icon: getIconName(item.icon),
        visible: true,
        pinned: false,
        order: index,
      }
    })

    groups.push({
      id: groupId,
      nameKey: groupKey,
      items: sidebarItems,
      visible: true,
      collapsed: false,
      order: groupOrder++,
    })
  })

  return {
    version: SIDEBAR_CONFIG_VERSION,
    groups,
    hiddenItems,
    pinnedItems: [],
    groupOrder: groups.map((g) => g.id),
    lastUpdated: Date.now(),
  }
}

/**
 * v6 起「集群」自成一个分组（节点 / 命名空间 / 事件），「应用」挪到最后。
 * 老配置（含管理员已发布的全局布局）在这里就地重组，避免升级后少一组或顺序错位；
 * 已经是新布局的配置原样返回，所以本函数可以重复执行。
 */
function applyClusterGroupLayout(config: SidebarConfig): SidebarConfig {
  if (config.groups.some((group) => group.id === SIDEBAR_CLUSTER_GROUP_ID)) {
    return config
  }

  const clusterMenus = defaultMenus[SIDEBAR_CLUSTER_GROUP_KEY]
  const clusterURLs = new Set(clusterMenus.map((menu) => menu.url))
  const movedItems: SidebarItem[] = []

  const remainingGroups = config.groups.map((group) => {
    const items = group.items.filter((item) => {
      // 只搬目录里的链接条目：用户自己加的 CRD / API 分组不受影响。
      if (item.type !== 'link' || !item.url || !clusterURLs.has(item.url)) {
        return true
      }
      movedItems.push(item)
      return false
    })

    if (items.length === group.items.length) {
      return group
    }
    return {
      ...group,
      items: items.map((item, index) => ({ ...item, order: index })),
    }
  })

  const clusterItems = clusterMenus
    .flatMap((menu) => {
      const found = movedItems.filter(
        (item) => item.type === 'link' && item.url === menu.url
      )
      if (found.length > 0) {
        return found
      }
      // 老配置里已经没有这个条目（例如更早的版本还没有它）：按目录补一条。
      return [
        {
          id: `${SIDEBAR_CLUSTER_GROUP_ID}-${menu.url.replace(/[^a-zA-Z0-9]/g, '-')}`,
          type: 'link' as const,
          titleKey: menu.titleKey,
          url: menu.url,
          icon: getIconName(menu.icon),
          visible: true,
          pinned: false,
          order: 0,
        },
      ]
    })
    .map((item, index) => ({ ...item, order: index }))

  const groups = [
    {
      id: SIDEBAR_CLUSTER_GROUP_ID,
      nameKey: SIDEBAR_CLUSTER_GROUP_KEY,
      items: clusterItems,
      visible: true,
      collapsed: false,
      order: 0,
    },
    // 「应用」排到最后，其余分组保持老配置里的相对顺序。
    ...remainingGroups.filter((group) => group.id !== APPLICATION_GROUP_ID),
    ...remainingGroups.filter((group) => group.id === APPLICATION_GROUP_ID),
  ].map((group, index) => ({ ...group, order: index }))

  return { ...config, groups, groupOrder: groups.map((group) => group.id) }
}

/**
 * v8 移除「资源关系图」：把老配置里已存在的、目录中已不存在的 link 条目
 * （含其隐藏/置顶状态）清掉，避免残留指向已删除页面的入口。只清理目录
 * 生成的 link，用户自己加的 CRD / API 分组条目不受影响。
 */
function removeStaleEntries(config: SidebarConfig): SidebarConfig {
  const knownURLs = new Set(
    Object.values(defaultMenus)
      .flat()
      .map((menu) => menu.url)
  )
  const staleIds = new Set<string>()

  const groups = config.groups
    .map((group) => {
      const items = group.items.filter((item) => {
        if (item.type === 'link' && item.url && !knownURLs.has(item.url)) {
          staleIds.add(item.id)
          return false
        }
        return true
      })
      if (items.length === group.items.length) {
        return group
      }
      return {
        ...group,
        items: items.map((item, index) => ({ ...item, order: index })),
      }
    })
    // 目录分组清空后整组移除（ensureDefaultEntries 会按目录重建）；自定义分组保留
    .filter((group) => group.isCustom || group.items.length > 0)

  if (staleIds.size === 0) {
    return config
  }

  return {
    ...config,
    groups,
    hiddenItems: config.hiddenItems.filter((id) => !staleIds.has(id)),
    pinnedItems: config.pinnedItems.filter((id) => !staleIds.has(id)),
  }
}

/**
 * v7 起新增的默认条目（cert-manager 资源面）就地补进老配置：
 * 缺失的分组整组创建，已有分组里缺失的链接条目追加；defaultHidden 照常进
 * hiddenItems。按 url 判断，幂等；代价是用户手动删过的目录链接会在升级时
 * 被补回来（目录链接的常规移除方式是隐藏，可接受）。
 */
function ensureDefaultEntries(config: SidebarConfig): SidebarConfig {
  let hiddenItems = config.hiddenItems
  const groups = [...config.groups]
  const groupOrder = [...config.groupOrder]

  Object.entries(defaultMenus).forEach(([groupKey, items]) => {
    const groupId = groupKey
      .toLowerCase()
      .replace(/\./g, '-')
      .replace(/\s+/g, '-')
    const index = groups.findIndex((group) => group.id === groupId)

    if (index === -1) {
      const sidebarItems: SidebarItem[] = items.map((item, order) => {
        const id = `${groupId}-${item.url?.replace(/[^a-zA-Z0-9]/g, '-')}`
        if (item.defaultHidden) {
          hiddenItems = [...hiddenItems, id]
        }
        return {
          id,
          type: 'link',
          titleKey: item.titleKey,
          url: item.url!,
          icon: getIconName(item.icon),
          visible: true,
          pinned: false,
          order,
        }
      })
      groups.push({
        id: groupId,
        nameKey: groupKey,
        items: sidebarItems,
        visible: true,
        collapsed: false,
        order: groups.length,
      })
      groupOrder.push(groupId)
      return
    }

    const group = groups[index]
    const added = items
      .filter(
        (menu) =>
          !group.items.some(
            (item) => item.type === 'link' && item.url === menu.url
          )
      )
      .map((menu, offset) => {
        const id = `${groupId}-${menu.url?.replace(/[^a-zA-Z0-9]/g, '-')}`
        if (menu.defaultHidden) {
          hiddenItems = [...hiddenItems, id]
        }
        return {
          id,
          type: 'link' as const,
          titleKey: menu.titleKey,
          url: menu.url!,
          icon: getIconName(menu.icon),
          visible: true,
          pinned: false,
          order: group.items.length + offset,
        }
      })

    if (added.length > 0) {
      groups[index] = { ...group, items: [...group.items, ...added] }
    }
  })

  return { ...config, groups, groupOrder, hiddenItems }
}

export function migrateSidebarConfig(
  storedConfig: StoredSidebarConfig
): SidebarConfig {
  return ensureDefaultEntries(
    removeStaleEntries(
      applyClusterGroupLayout({
        ...storedConfig,
        version: SIDEBAR_CONFIG_VERSION,
        groups: storedConfig.groups.map((group) => ({
      ...group,
      items: group.items.map((item): SidebarItem => {
        const apiGroup = item.apiGroup || item.crdGroup
        const baseItem = {
          id: item.id,
          titleKey: item.titleKey,
          icon: item.icon,
          visible: item.visible,
          pinned: item.pinned,
          order: item.order,
        }

        if (apiGroup) {
          return {
            ...baseItem,
            type: 'apiGroup',
            apiGroup,
          }
        }

        return {
          ...baseItem,
          type:
            item.type === 'customResource' ||
            (!item.type && item.url?.startsWith('/crds/'))
              ? 'customResource'
              : 'link',
          url: item.url!,
        }
      }),
    })),
      })
    )
  )
}
