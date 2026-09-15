import * as React from 'react'
import { useCallback, useMemo, useState } from 'react'
import Icon from '@/assets/icon.svg'
import { useAuth } from '@/contexts/auth-context'
import { useSidebarConfig } from '@/contexts/sidebar-config-context'
import { CollapsibleContent } from '@radix-ui/react-collapsible'
import { IconLayoutDashboard } from '@tabler/icons-react'
import { CustomResourceDefinition } from 'kubernetes-types/apiextensions/v1'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation } from 'react-router-dom'

import { SidebarCustomResourceItem, SidebarItem } from '@/types/sidebar'
import { useResources, useVersionInfo } from '@/lib/api'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { getSettingsSections } from '@/components/settings/settings-sections'

import { ClusterSelector } from './cluster-selector'
import { Collapsible, CollapsibleTrigger } from './ui/collapsible'
import { VersionInfo } from './version-info'

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const isAdmin = user ? user.isAdmin() : false
  const location = useLocation()
  const { isMobile, setOpenMobile } = useSidebar()
  const { config, isLoading, getIconComponent } = useSidebarConfig()
  const { data: versionInfo } = useVersionInfo()
  const [openAPIGroupItems, setOpenAPIGroupItems] = useState<
    Record<string, boolean>
  >({})
  const hasConfiguredCRDItems = useMemo(
    () =>
      config?.groups.some((group) =>
        group.items.some(
          (item) => item.type === 'apiGroup' || item.type === 'customResource'
        )
      ) || false,
    [config]
  )
  const { data: crds } = useResources('crds', undefined, {
    disable: !hasConfiguredCRDItems,
  })
  const { apiGroupItems, availableCRDURLs } = useMemo(() => {
    const groups = new Map<string, SidebarCustomResourceItem[]>()
    const urls = new Set<string>()

    for (const crd of (crds || []) as CustomResourceDefinition[]) {
      const apiGroup = crd.spec.group
      const name = crd.metadata?.name
      const kind = crd.spec.names.kind
      if (!apiGroup || !name || !kind) continue

      const items = groups.get(apiGroup) || []
      const url = `/crds/${name}`
      urls.add(url)
      items.push({
        id: `api-group:${encodeURIComponent(apiGroup)}:${encodeURIComponent(name)}`,
        type: 'customResource',
        titleKey: kind,
        url,
        icon: 'IconCode',
        visible: true,
        pinned: false,
        order: items.length,
      })
      groups.set(apiGroup, items)
    }

    for (const items of groups.values()) {
      items.sort((a, b) => a.titleKey.localeCompare(b.titleKey))
    }

    return { apiGroupItems: groups, availableCRDURLs: urls }
  }, [crds])
  const isCRDItemAvailable = useCallback(
    (item: SidebarItem) => {
      if (crds === undefined || item.type === 'link') return true
      if (item.type === 'apiGroup') {
        return apiGroupItems.has(item.apiGroup)
      }
      return availableCRDURLs.has(item.url)
    },
    [apiGroupItems, availableCRDURLs, crds]
  )

  const pinnedItems = useMemo(() => {
    if (!config) return []
    return config.groups
      .flatMap((group) => group.items)
      .filter((item) => config.pinnedItems.includes(item.id))
      .filter((item) => !config.hiddenItems.includes(item.id))
      .filter(isCRDItemAvailable)
  }, [config, isCRDItemAvailable])

  const visibleGroups = useMemo(() => {
    if (!config) return []
    return config.groups
      .filter((group) => group.visible)
      .sort((a, b) => a.order - b.order)
      .map((group) => ({
        ...group,
        items: group.items
          .filter((item) => !config.hiddenItems.includes(item.id))
          .filter((item) => !config.pinnedItems.includes(item.id))
          .filter(isCRDItemAvailable)
          .sort((a, b) => a.order - b.order),
      }))
      .filter((group) => group.items.length > 0)
  }, [config, isCRDItemAvailable])

  const settingsSections = useMemo(() => getSettingsSections(t), [t])

  const isActive = (url: string) => {
    if (url === '/') {
      return location.pathname === '/'
    }
    if (url === '/crds') {
      return location.pathname == '/crds'
    }
    return location.pathname.startsWith(url)
  }

  // Handle menu item click on mobile - close sidebar
  const handleMenuItemClick = () => {
    if (isMobile) {
      setOpenMobile(false)
    }
  }

  const renderSidebarItem = (item: SidebarItem) => {
    const IconComponent = getIconComponent(item.icon)
    const title = item.titleKey
      ? t(item.titleKey, { defaultValue: item.titleKey })
      : ''
    if (item.type === 'apiGroup') {
      const children = apiGroupItems.get(item.apiGroup) || []
      const hasActiveChild = children.some((child) => isActive(child.url))

      return (
        <Collapsible
          key={item.id}
          asChild
          open={openAPIGroupItems[item.id] || false}
          onOpenChange={(open) =>
            setOpenAPIGroupItems((current) => ({
              ...current,
              [item.id]: open,
            }))
          }
          className="group/submenu"
        >
          <SidebarMenuItem>
            <CollapsibleTrigger asChild>
              <SidebarMenuButton tooltip={title} isActive={hasActiveChild}>
                <IconComponent className="text-sidebar-primary" />
                <span>{title}</span>
                <ChevronRight className="ml-auto group-data-[state=open]/submenu:rotate-90" />
              </SidebarMenuButton>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <SidebarMenuSub>
                {children.map((child) => {
                  const childTitle = child.titleKey
                    ? t(child.titleKey, { defaultValue: child.titleKey })
                    : ''

                  return (
                    <SidebarMenuSubItem key={child.id}>
                      <SidebarMenuSubButton
                        asChild
                        isActive={isActive(child.url)}
                      >
                        <Link
                          to={child.url}
                          onClick={handleMenuItemClick}
                          title={childTitle}
                        >
                          <span>{childTitle}</span>
                        </Link>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  )
                })}
              </SidebarMenuSub>
            </CollapsibleContent>
          </SidebarMenuItem>
        </Collapsible>
      )
    }

    return (
      <SidebarMenuItem key={item.id}>
        <SidebarMenuButton
          tooltip={title}
          asChild
          isActive={isActive(item.url)}
        >
          <Link to={item.url} onClick={handleMenuItemClick}>
            <IconComponent className="text-sidebar-primary" />
            <span>{title}</span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    )
  }

  if (isLoading || !config) {
    return (
      <Sidebar collapsible="offcanvas" {...props}>
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <Link to="/" onClick={handleMenuItemClick}>
                  <img src={Icon} alt="Kite Logo" className="ml-1 h-8 w-8" />
                  <span className="text-base font-semibold">Kite</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <div className="p-4 text-center text-muted-foreground">
            {t('common.messages.loading', 'Loading...')}
          </div>
        </SidebarContent>
      </Sidebar>
    )
  }

  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              className="data-[slot=sidebar-menu-button]:!p-1.5 hover:bg-accent/50 transition-colors"
            >
              <Link to="/" onClick={handleMenuItemClick}>
                <div className="relative flex items-center justify-between w-full">
                  <div className="flex items-center gap-2">
                    <img src={Icon} alt="Kite Logo" className="h-8 w-8" />
                    <div className="flex flex-col">
                      <span className="text-base font-semibold bg-gradient-to-r from-primary to-primary/70 bg-clip-text text-transparent">
                        Kite
                      </span>
                      <VersionInfo />
                    </div>
                  </div>
                  {versionInfo?.hasNewVersion ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        if (versionInfo?.releaseUrl) {
                          window.open(versionInfo.releaseUrl, '_blank')
                        }
                      }}
                      className="absolute right-0 top-0 mr-1 mt-1 rounded-sm bg-red-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-red-500 hover:bg-red-500/20"
                      title={t('sidebar.updateAvailable')}
                    >
                      New
                    </button>
                  ) : null}
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {/* 系统设置页面不需要集群切换器 */}
        {!location.pathname.startsWith('/settings') && (
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <div className="flex items-center gap-2 rounded-md border border-border/60 bg-gradient-to-r from-muted/40 to-muted/20 px-1.5 py-1 backdrop-blur-sm">
                    <ClusterSelector />
                  </div>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {/* 系统设置页面不需要概览入口 */}
        {!location.pathname.startsWith('/settings') && (
          <SidebarGroup>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip={t('nav.overview')}
                  asChild
                  isActive={isActive('/')}
                  className="transition-all duration-200 hover:bg-accent/60 active:scale-95 data-[active=true]:bg-primary/10 data-[active=true]:font-semibold data-[active=true]:text-primary data-[active=true]:shadow-sm"
                >
                  <Link to="/" onClick={handleMenuItemClick}>
                    <IconLayoutDashboard className="text-sidebar-primary" />
                    <span className="font-medium">{t('nav.overview')}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        )}

        {pinnedItems.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
              {t('sidebar.pinned', 'Pinned')}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>{pinnedItems.map(renderSidebarItem)}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {/* 进入系统设置后只保留设置相关入口，隐藏业务导航 */}
        {!location.pathname.startsWith('/settings') &&
          visibleGroups.map((group) => (
            <Collapsible
              key={group.id}
              defaultOpen={!group.collapsed}
              className="group/collapsible"
            >
              <SidebarGroup>
                <SidebarGroupLabel asChild>
                  <CollapsibleTrigger className="flex items-center justify-between w-full text-sm font-semibold text-muted-foreground hover:text-foreground transition-colors group-data-[state=open]:text-foreground">
                    <span className="uppercase tracking-wide text-xs font-bold">
                      {group.nameKey
                        ? t(group.nameKey, { defaultValue: group.nameKey })
                        : ''}
                    </span>
                    <ChevronDown className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-180" />
                  </CollapsibleTrigger>
                </SidebarGroupLabel>
                <CollapsibleContent>
                  <SidebarGroupContent className="flex flex-col gap-2">
                    <SidebarMenu>
                      {group.items.map(renderSidebarItem)}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </CollapsibleContent>
              </SidebarGroup>
            </Collapsible>
          ))}

        {isAdmin && location.pathname.startsWith('/settings') && (
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {settingsSections.map((section) => {
                  const SectionIcon = section.icon
                  const sectionActive = location.pathname.startsWith(
                    `/settings/${section.value}`
                  )
                  // 各章节的子页签：侧边栏子菜单 + 内容区页签共用
                  const sectionSubTabs: Record<
                    string,
                    {
                      param: string
                      tabs: {
                        value: string
                        labelKey: string
                        defaultLabel: string
                      }[]
                    }
                  > = {
                    rbac: {
                      param: 'rbacTab',
                      tabs: [
                        {
                          value: 'roles',
                          labelKey: 'settings.subTabs.rbacRoles',
                          defaultLabel: 'Roles',
                        },
                        {
                          value: 'user',
                          labelKey: 'settings.subTabs.rbacUsers',
                          defaultLabel: 'Users',
                        },
                        {
                          value: 'group',
                          labelKey: 'settings.subTabs.rbacGroups',
                          defaultLabel: 'User Groups',
                        },
                        {
                          value: 'namespace',
                          labelKey: 'settings.subTabs.rbacNamespaces',
                          defaultLabel: 'Namespace Grants',
                        },
                        {
                          value: 'node',
                          labelKey: 'settings.subTabs.rbacNodes',
                          defaultLabel: 'Node Permissions',
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
                          value: 'password',
                          labelKey: 'audit.tabs.password',
                          defaultLabel: 'Password Change Logs',
                        },
                      ],
                    },
                  }
                  const sub = sectionSubTabs[section.value]
                  const currentSubTab = sub
                    ? (new URLSearchParams(location.search).get(sub.param) ??
                      sub.tabs[0]?.value)
                    : undefined

                  return (
                    <SidebarMenuItem key={section.value}>
                      <SidebarMenuButton
                        tooltip={section.label}
                        asChild
                        isActive={isActive(`/settings/${section.value}`)}
                        className="transition-colors data-[active=true]:bg-primary/10 data-[active=true]:font-semibold data-[active=true]:text-primary"
                      >
                        <Link
                          to={`/settings/${section.value}`}
                          onClick={handleMenuItemClick}
                        >
                          <SectionIcon className="text-sidebar-primary" />
                          <span>{section.label}</span>
                          {sub && (
                            <ChevronDown
                              className={`ml-auto h-4 w-4 transition-transform duration-200 ${
                                sectionActive ? 'rotate-180' : ''
                              }`}
                            />
                          )}
                        </Link>
                      </SidebarMenuButton>
                      {sectionActive && sub && (
                        <SidebarMenuSub>
                          {sub.tabs.map((subTab) => (
                            <SidebarMenuSubItem key={subTab.value}>
                              <SidebarMenuSubButton
                                asChild
                                isActive={currentSubTab === subTab.value}
                                className="data-[active=true]:bg-primary/10 data-[active=true]:font-semibold data-[active=true]:text-primary"
                              >
                                <Link
                                  to={`/settings/${section.value}?${sub.param}=${subTab.value}`}
                                  onClick={handleMenuItemClick}
                                >
                                  <span>
                                    {t(subTab.labelKey, {
                                      defaultValue: subTab.defaultLabel,
                                    })}
                                  </span>
                                </Link>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          ))}
                        </SidebarMenuSub>
                      )}
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>
    </Sidebar>
  )
}
