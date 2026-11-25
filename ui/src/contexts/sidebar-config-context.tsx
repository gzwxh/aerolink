/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import * as React from 'react'
import { type Icon, type IconProps } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { SidebarConfig, SidebarGroup, SidebarItem } from '@/types/sidebar'
import { withSubPath } from '@/lib/subpath'

import { useAuth } from './auth-context'
import {
  buildDefaultSidebarConfig,
  getSidebarIconComponent,
  migrateSidebarConfig,
  SIDEBAR_CONFIG_VERSION,
} from './sidebar-config-defaults'

function toggleInArray(arr: string[], item: string): string[] {
  const set = new Set(arr)
  if (set.has(item)) set.delete(item)
  else set.add(item)
  return Array.from(set)
}

function toggleGroupField(
  groups: SidebarGroup[],
  groupId: string,
  field: 'visible' | 'collapsed'
): SidebarGroup[] {
  return groups.map((g) =>
    g.id === groupId ? { ...g, [field]: !g[field] } : g
  )
}

interface SidebarConfigContextType {
  config: SidebarConfig | null
  isLoading: boolean
  hasUpdate: boolean
  updateConfig: (updates: Partial<SidebarConfig>) => void
  toggleItemVisibility: (itemId: string) => void
  toggleGroupVisibility: (groupId: string) => void
  toggleItemPin: (itemId: string) => void
  toggleGroupCollapse: (groupId: string) => void
  resetConfig: () => void
  getIconComponent: (
    iconName: string
  ) =>
    | React.ForwardRefExoticComponent<IconProps & React.RefAttributes<Icon>>
    | React.ElementType
  createCustomGroup: (groupName: string) => void
  addCRDToGroup: (groupId: string, crdName: string, kind: string) => void
  addAPIGroupToGroup: (groupId: string, groupName: string) => void
  removeItemFromGroup: (groupId: string, itemId: string) => void
  removeCustomGroup: (groupId: string) => void
  moveGroup: (groupId: string, direction: 'up' | 'down') => void
  moveItemToGroup: (
    itemId: string,
    targetGroupId: string,
    targetIndex?: number
  ) => void
  movePinnedItem: (itemId: string, targetIndex: number) => void
}

const SidebarConfigContext = createContext<
  SidebarConfigContextType | undefined
>(undefined)

export const useSidebarConfig = () => {
  const context = useContext(SidebarConfigContext)
  if (!context) {
    throw new Error(
      'useSidebarConfig must be used within a SidebarConfigProvider'
    )
  }
  return context
}

interface SidebarConfigProviderProps {
  children: React.ReactNode
}

export const SidebarConfigProvider: React.FC<SidebarConfigProviderProps> = ({
  children,
}) => {
  const [config, setConfig] = useState<SidebarConfig | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [hasUpdate, setHasUpdate] = useState(false)
  const { user } = useAuth()
  const { t } = useTranslation()

  // 事件处理里要拿「最新的」配置：写回是异步的，若等它成功再更新本地状态，
  // 连续两次操作会都基于同一份旧状态计算，前一次改动被后一次覆盖。
  const configRef = useRef<SidebarConfig | null>(null)
  useEffect(() => {
    configRef.current = config
  }, [config])

  const loadConfig = useCallback(async () => {
    if (user && user.sidebar_preference && user.sidebar_preference != '') {
      const storedConfig = JSON.parse(user.sidebar_preference)
      setHasUpdate((storedConfig.version || 0) < SIDEBAR_CONFIG_VERSION)
      const userConfig = migrateSidebarConfig(storedConfig)
      setConfig(userConfig)
      return
    }
    setHasUpdate(false)
    setConfig(buildDefaultSidebarConfig())
  }, [user])

  // 串行化写回：先发出的保存先落库，最后一次改动才是最终状态；
  // 否则两次请求的响应乱序会让服务端停在旧配置上。
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())

  const persistConfig = useCallback(
    (configToSave: SidebarConfig) => {
      if (!user) return
      saveQueueRef.current = saveQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          try {
            const response = await fetch(
              withSubPath('/api/users/sidebar_preference'),
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                credentials: 'include',
                body: JSON.stringify({
                  sidebar_preference: JSON.stringify(configToSave),
                }),
              }
            )
            if (!response.ok) {
              throw new Error(`HTTP ${response.status}`)
            }
          } catch (error) {
            // 之前只写 console：界面既没有提示，用户也无从知道改动没保存。
            console.error('Failed to save sidebar config to server:', error)
            toast.error(
              t('sidebar.saveFailed', {
                defaultValue: '保存侧边栏配置失败，请稍后重试',
              })
            )
          }
        })
    },
    [t, user]
  )

  // 统一的写入路径：先更新本地状态（乐观），再写回服务端。
  const applyConfig = useCallback(
    (next: SidebarConfig) => {
      const stamped = {
        ...next,
        lastUpdated: Date.now(),
        version: SIDEBAR_CONFIG_VERSION,
      }
      configRef.current = stamped
      setConfig(stamped)
      persistConfig(stamped)
    },
    [persistConfig]
  )

  const updateConfig = useCallback(
    (updates: Partial<SidebarConfig>) => {
      const current = configRef.current
      if (!current) return
      applyConfig({ ...current, ...updates })
    },
    [applyConfig]
  )

  const toggleItemVisibility = useCallback(
    (itemId: string) => {
      if (!config) return
      updateConfig({ hiddenItems: toggleInArray(config.hiddenItems, itemId) })
    },
    [config, updateConfig]
  )

  const toggleItemPin = useCallback(
    (itemId: string) => {
      if (!config) return
      updateConfig({ pinnedItems: toggleInArray(config.pinnedItems, itemId) })
    },
    [config, updateConfig]
  )

  const toggleGroupVisibility = useCallback(
    (groupId: string) => {
      if (!config) return
      updateConfig({
        groups: toggleGroupField(config.groups, groupId, 'visible'),
      })
    },
    [config, updateConfig]
  )

  const toggleGroupCollapse = useCallback(
    (groupId: string) => {
      if (!config) return
      updateConfig({
        groups: toggleGroupField(config.groups, groupId, 'collapsed'),
      })
    },
    [config, updateConfig]
  )

  const moveGroup = useCallback(
    (groupId: string, direction: 'up' | 'down') => {
      if (!config) return

      const sortedGroups = [...config.groups].sort((a, b) => a.order - b.order)
      const currentIndex = sortedGroups.findIndex(
        (group) => group.id === groupId
      )
      if (currentIndex === -1) return

      const targetIndex =
        direction === 'up' ? currentIndex - 1 : currentIndex + 1

      if (targetIndex < 0 || targetIndex >= sortedGroups.length) {
        return
      }

      const reordered = [...sortedGroups]
      const [movedGroup] = reordered.splice(currentIndex, 1)
      reordered.splice(targetIndex, 0, movedGroup)

      const groups = reordered.map((group, index) => ({
        ...group,
        order: index,
      }))
      const groupOrder = groups.map((group) => group.id)

      updateConfig({ groups, groupOrder })
    },
    [config, updateConfig]
  )

  const createCustomGroup = useCallback(
    (groupName: string) => {
      if (!config) return

      const groupId = `custom-${groupName.toLowerCase().replace(/\s+/g, '-')}`

      // 检查该分组是否已存在
      if (config.groups.find((g) => g.id === groupId)) {
        return
      }

      const newGroup: SidebarGroup = {
        id: groupId,
        nameKey: groupName,
        items: [],
        visible: true,
        collapsed: false,
        order: config.groups.length,
        isCustom: true,
      }

      const groups = [...config.groups, newGroup]
      updateConfig({ groups, groupOrder: [...config.groupOrder, groupId] })
    },
    [config, updateConfig]
  )

  const addCRDToGroup = useCallback(
    (groupId: string, crdName: string, kind: string) => {
      if (!config) return

      const groups = config.groups.map((group) => {
        if (group.id === groupId) {
          const url = `/crds/${crdName}`

          // 检查该分组中是否已存在该 CRD
          if (
            group.items.some(
              (item) => item.type === 'customResource' && item.url === url
            )
          ) {
            return group
          }

          const newItem: SidebarItem = {
            id: `${groupId}--custom-resource:${encodeURIComponent(crdName)}`,
            type: 'customResource',
            titleKey: kind,
            url,
            icon: 'IconCode',
            visible: true,
            pinned: false,
            order: group.items.length,
          }

          return {
            ...group,
            items: [...group.items, newItem],
          }
        }
        return group
      })

      updateConfig({ groups })
    },
    [config, updateConfig]
  )

  const addAPIGroupToGroup = useCallback(
    (targetGroupId: string, groupName: string) => {
      if (!config) return

      const groups = config.groups.map((group) => {
        if (group.id !== targetGroupId) return group
        if (
          group.items.some(
            (item) => item.type === 'apiGroup' && item.apiGroup === groupName
          )
        ) {
          return group
        }

        const itemId = `${targetGroupId}--api-group:${encodeURIComponent(groupName)}`
        const newItem: SidebarItem = {
          id: itemId,
          type: 'apiGroup',
          titleKey: groupName,
          icon: 'IconCode',
          visible: true,
          pinned: false,
          order: group.items.length,
          apiGroup: groupName,
        }

        return {
          ...group,
          items: [...group.items, newItem],
        }
      })

      updateConfig({ groups })
    },
    [config, updateConfig]
  )

  const moveItemToGroup = useCallback(
    (itemId: string, targetGroupId: string, targetIndex?: number) => {
      if (!config) return
      if (!config.groups.some((group) => group.id === targetGroupId)) return

      let movedItem: SidebarItem | undefined
      let sourceGroupId = ''
      let sourceIndex = -1
      const groupsWithoutItem = config.groups.map((group) => {
        const nextItems = group.items.filter((item, index) => {
          if (item.id !== itemId) {
            return true
          }
          movedItem = item
          sourceGroupId = group.id
          sourceIndex = index
          return false
        })

        if (nextItems.length === group.items.length) {
          return group
        }

        return {
          ...group,
          items: nextItems.map((item, index) => ({ ...item, order: index })),
        }
      })

      if (!movedItem) {
        return
      }

      const itemToMove = movedItem
      const groups = groupsWithoutItem.map((group) => {
        if (group.id !== targetGroupId) {
          return group
        }

        let insertIndex = targetIndex ?? group.items.length
        if (sourceGroupId === targetGroupId && sourceIndex < insertIndex) {
          insertIndex -= 1
        }
        insertIndex = Math.max(0, Math.min(insertIndex, group.items.length))

        const items = [...group.items]
        items.splice(insertIndex, 0, itemToMove)

        return {
          ...group,
          items: items.map((item, index) => ({ ...item, order: index })),
        }
      })

      updateConfig({ groups })
    },
    [config, updateConfig]
  )

  const movePinnedItem = useCallback(
    (itemId: string, targetIndex: number) => {
      if (!config) return
      const sourceIndex = config.pinnedItems.indexOf(itemId)
      if (sourceIndex === -1) return

      const pinnedItems = [...config.pinnedItems]
      pinnedItems.splice(sourceIndex, 1)
      let insertIndex = targetIndex
      if (sourceIndex < insertIndex) {
        insertIndex -= 1
      }
      insertIndex = Math.max(0, Math.min(insertIndex, pinnedItems.length))
      pinnedItems.splice(insertIndex, 0, itemId)

      updateConfig({ pinnedItems })
    },
    [config, updateConfig]
  )

  const removeItemFromGroup = useCallback(
    (groupId: string, itemID: string) => {
      if (!config) return
      const groups = config.groups.map((group) => {
        if (group.id === groupId) {
          const newItems = group.items
            .filter((item) => item.id !== itemID)
            .map((item, index) => ({ ...item, order: index }))
          return {
            ...group,
            items: newItems,
          }
        }
        return group
      })

      const pinnedItems = config.pinnedItems.filter((item) => item !== itemID)
      const hiddenItems = config.hiddenItems.filter((item) => item !== itemID)

      updateConfig({ groups, pinnedItems, hiddenItems })
    },
    [config, updateConfig]
  )

  const removeCustomGroup = useCallback(
    (groupId: string) => {
      if (!config) return

      const group = config.groups.find((g) => g.id === groupId)
      if (!group?.isCustom) return

      const otherGroupId = 'sidebar-groups-other'
      const groups = config.groups
        .filter((g) => g.id !== groupId)
        .map((g) =>
          g.id === otherGroupId
            ? {
                ...g,
                items: [
                  ...g.items,
                  ...group.items.map((item, index) => ({
                    ...item,
                    order: g.items.length + index,
                  })),
                ],
              }
            : g
        )
      const groupOrder = config.groupOrder.filter((id) => id !== groupId)

      updateConfig({ groups, groupOrder })
    },
    [config, updateConfig]
  )

  const resetConfig = useCallback(() => {
    applyConfig(buildDefaultSidebarConfig())
    setHasUpdate(false)
  }, [applyConfig])

  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true)
      await loadConfig()
      setIsLoading(false)
    }
    loadData()
  }, [loadConfig])

  const value: SidebarConfigContextType = {
    config,
    isLoading,
    hasUpdate,
    updateConfig,
    toggleItemVisibility,
    toggleGroupVisibility,
    toggleItemPin,
    toggleGroupCollapse,
    resetConfig,
    getIconComponent: getSidebarIconComponent,
    createCustomGroup,
    addCRDToGroup,
    addAPIGroupToGroup,
    removeItemFromGroup,
    removeCustomGroup,
    moveGroup,
    moveItemToGroup,
    movePinnedItem,
  }

  return (
    <SidebarConfigContext.Provider value={value}>
      {children}
    </SidebarConfigContext.Provider>
  )
}
