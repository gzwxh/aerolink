import * as React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { useBranding } from '@/contexts/branding-context'
import { useSidebarConfig } from '@/contexts/sidebar-config-context'
import { CollapsibleContent } from '@radix-ui/react-collapsible'
import { IconLayoutDashboard } from '@tabler/icons-react'
import { CustomResourceDefinition } from 'kubernetes-types/apiextensions/v1'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { SidebarCustomResourceItem, SidebarItem } from '@/types/sidebar'
import { useResources } from '@/lib/api'
import { useClusterLocation } from '@/lib/cluster-path'
import { splitSiteName } from '@/lib/site-name'
import { cn } from '@/lib/utils'
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
import { ClusterLink } from '@/components/cluster-link'
import {
  getSettingsSections,
  settingsSubTabs,
} from '@/components/settings/settings-sections'

import { ClusterSelector } from './cluster-selector'
import { Collapsible, CollapsibleTrigger } from './ui/collapsible'
import { VersionInfo } from './version-info'

/**
 * 侧边栏里的品牌名称。
 *
 * 侧边栏是固定宽度（16rem、overflow-hidden），单行放不下的名称会被**直接裁掉**
 * （不是省略号，是后面的字看不见）。所以按显示宽度折成最多两行
 * （见 lib/site-name.ts），并把完整名称放进 title 作为兜底。
 *
 * 两行要完整显示，外层的 SidebarMenuButton 就不能锁高（默认 h-8，用 h-auto 覆盖），
 * 否则 40px 的文本会被 overflow-hidden 上下各裁掉一截。颜色取
 * `--sidebar-foreground`：品牌名在侧边栏上，用 `--primary` 之类的内容区 token 在
 * 深色侧边栏（如墨绿主题的浅色模式）会看不清。
 */
function SiteNameText({
  name,
  className,
}: {
  name: string
  className?: string
}) {
  const lines = splitSiteName(name)

  return (
    <span className={cn('text-base font-semibold', className)} title={name}>
      {lines.map((line, index) => (
        <span key={index} className="block leading-tight break-words">
          {line}
        </span>
      ))}
    </span>
  )
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const location = useClusterLocation()
  const { isMobile, setOpenMobile } = useSidebar()
  const { config, isLoading, getIconComponent } = useSidebarConfig()
  const { logoUrl, siteName, isCustomBranding } = useBranding()
  const [openAPIGroupItems, setOpenAPIGroupItems] = useState<
    Record<string, boolean>
  >({})
  // 设置章节的子页签展开状态。它与路由**解耦**：箭头是一个独立的开关，
  // 否则只能展开不能收起（子页签曾经只按 sectionActive 渲染）。
  const [openSettingsSections, setOpenSettingsSections] = useState<
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
    const itemsById = new Map<string, SidebarItem>(
      config.groups
        .flatMap((group) => group.items)
        .map((item) => [item.id, item] as const)
    )
    // 置顶区按用户拖拽后的顺序渲染：pinnedItems 数组顺序即展示顺序。
    return config.pinnedItems
      .map((id) => itemsById.get(id))
      .filter((item): item is SidebarItem => Boolean(item))
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

  // 用户可以打开的分区：每个设置分区都带自己的授权，因此
  // 审计管理员只会看到审计页面，安全管理员只会看到
  // 身份/权限相关页面，依此类推。
  const settingsSections = useMemo(
    () =>
      getSettingsSections(
        t,
        (section) => user?.canViewSettingsSection(section) ?? false
      ),
    [t, user]
  )

  // 路由切到某个设置章节时自动展开它的子页签（例如从别处跳到 /settings/security）。
  // 只在指向的章节变化时补一次：用户手动收起当前章节后不会被立刻重新撑开。
  const activeSettingsSection = settingsSections.find((section) =>
    location.pathname.startsWith(`/settings/${section.value}`)
  )?.value
  useEffect(() => {
    if (!activeSettingsSection || !settingsSubTabs[activeSettingsSection]) {
      return
    }
    setOpenSettingsSections((current) =>
      current[activeSettingsSection]
        ? current
        : { ...current, [activeSettingsSection]: true }
    )
  }, [activeSettingsSection])

  const isActive = (url: string) => {
    if (url === '/') {
      return location.pathname === '/'
    }
    if (url === '/crds') {
      return location.pathname == '/crds'
    }
    return location.pathname.startsWith(url)
  }

  // 处理移动端的菜单项点击——关闭侧边栏
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
                        <ClusterLink
                          to={child.url}
                          onClick={handleMenuItemClick}
                          title={childTitle}
                        >
                          <span>{childTitle}</span>
                        </ClusterLink>
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
          <ClusterLink to={item.url} onClick={handleMenuItemClick}>
            <IconComponent className="text-sidebar-primary" />
            <span>{title}</span>
          </ClusterLink>
        </SidebarMenuButton>
      </SidebarMenuItem>
    )
  }

  // 置顶项整体渲染在概览下方、所有分组之前：它是「置顶到顶部」的语义，
  // 挂在某个分组之后会随该分组的位置漂移，分组被隐藏时还会整块消失。
  // 置顶项从原分组移除，避免同一入口在侧边栏出现两次。
  const pinnedGroup =
    pinnedItems.length > 0 ? (
      <SidebarGroup>
        <SidebarGroupLabel className="text-xs font-bold uppercase tracking-wide text-sidebar-foreground/70">
          {t('sidebar.pinned', 'Pinned')}
        </SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>{pinnedItems.map(renderSidebarItem)}</SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    ) : null

  if (isLoading || !config) {
    return (
      <Sidebar collapsible="offcanvas" {...props}>
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild className="h-auto">
                <ClusterLink to="/" onClick={handleMenuItemClick}>
                  <img
                    src={logoUrl}
                    alt={`${siteName} Logo`}
                    className="ml-1 h-8 w-8"
                  />
                  <SiteNameText name={siteName} />
                </ClusterLink>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <div className="p-4 text-center text-sidebar-foreground/70">
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
              className="data-[slot=sidebar-menu-button]:!p-1.5 hover:bg-accent/50 transition-colors h-auto"
            >
              <ClusterLink to="/" onClick={handleMenuItemClick}>
                <div className="relative flex items-center justify-between w-full">
                  <div className="flex items-center gap-2">
                    <img
                      src={logoUrl}
                      alt={`${siteName} Logo`}
                      className="h-8 w-8"
                    />
                    <div className="flex flex-col">
                      <SiteNameText
                        name={siteName}
                        className="text-sidebar-foreground"
                      />
                      {/* 改了品牌就不再暴露上游版本号与提交链接（见 Branding） */}
                      {isCustomBranding ? null : <VersionInfo />}
                    </div>
                  </div>
                </div>
              </ClusterLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        {/* 集群切换器固定在 logo 下方（SidebarHeader 不随内容滚动）：各页面与设置章节
            都按集群生效，切换是一个全局的客户端偏好，放到内容区会被滚走。
            底色取 sidebar 作用域的 token、不画描边：--border/--muted 是内容区的值，
            落在深色侧边栏（如墨绿浅色模式）上会画出一条亮框，实测描边对底色的对比
            度 5.56（默认主题只有 1.15），和旁边的菜单项不协调。 */}
        <SidebarMenu>
          <SidebarMenuItem>
            <div className="flex items-center gap-2 rounded-md bg-sidebar-accent px-1.5 py-1">
              <ClusterSelector />
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
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
                  <ClusterLink to="/" onClick={handleMenuItemClick}>
                    <IconLayoutDashboard className="text-sidebar-primary" />
                    <span className="font-medium">{t('nav.overview')}</span>
                  </ClusterLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        )}

        {!location.pathname.startsWith('/settings') && pinnedGroup}

        {/* 进入系统设置后只保留设置相关入口，隐藏业务导航 */}
        {!location.pathname.startsWith('/settings') &&
          visibleGroups.map((group) => (
            <Collapsible
              key={group.id}
              defaultOpen={!group.collapsed}
              className="group/collapsible"
            >
              <SidebarGroup className="group-data-[state=closed]/collapsible:py-0">
                <SidebarGroupLabel asChild>
                  <CollapsibleTrigger className="flex items-center justify-between w-full text-sm font-semibold text-sidebar-foreground/70 hover:text-sidebar-foreground transition-colors group-data-[state=open]:text-sidebar-foreground">
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

        {settingsSections.length > 0 &&
          location.pathname.startsWith('/settings') && (
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  {settingsSections.map((section) => {
                    const SectionIcon = section.icon
                    const sectionActive = location.pathname.startsWith(
                      `/settings/${section.value}`
                    )
                    const sub = settingsSubTabs[section.value]
                    // 页签可能属于另一个设置章节（安全管理的「认证配置」= settings.authentication）：
                    // 没有该章节读权限时不列出来，避免出现点进去就 403 的死链。
                    const visibleSubTabs = sub?.tabs.filter((subTab) =>
                      user?.canViewSettingsSection(
                        subTab.section ?? section.section
                      )
                    )
                    const currentSubTab = sub
                      ? (new URLSearchParams(location.search).get(sub.param) ??
                        visibleSubTabs?.[0]?.value)
                      : undefined
                    // 默认跟随路由展开；箭头是独立开关，可以手动收起。
                    const open =
                      openSettingsSections[section.value] ?? sectionActive

                    return (
                      <SidebarMenuItem key={section.value}>
                        {/* 相对定位的容器只包住章节名这一行（不包含下面的子页签），
                            否则展开后 li 变高，箭头会被居中到整组的中部。 */}
                        <div className="relative">
                          <SidebarMenuButton
                            tooltip={section.label}
                            asChild
                            isActive={isActive(`/settings/${section.value}`)}
                            className={cn(
                              'transition-colors data-[active=true]:bg-primary/10 data-[active=true]:font-semibold data-[active=true]:text-primary',
                              // 给右侧的展开/收起开关留位置，避免章节名压在箭头上。
                              sub && 'pr-8'
                            )}
                          >
                            <ClusterLink
                              to={`/settings/${section.value}`}
                              onClick={handleMenuItemClick}
                            >
                              <SectionIcon className="text-sidebar-primary" />
                              <span>{section.label}</span>
                            </ClusterLink>
                          </SidebarMenuButton>
                          {sub && (
                            <button
                              type="button"
                              aria-label={`${section.label}: ${t(
                                open
                                  ? 'common.actions.collapse'
                                  : 'common.actions.expand',
                                open ? '收起' : '展开'
                              )}`}
                              aria-expanded={open}
                              className="absolute top-1/2 right-2 -translate-y-1/2 rounded-sm p-0.5 text-sidebar-foreground/70 transition-colors hover:text-sidebar-foreground group-data-[collapsible=icon]:hidden"
                              onClick={() =>
                                setOpenSettingsSections((current) => ({
                                  ...current,
                                  [section.value]: !open,
                                }))
                              }
                            >
                              <ChevronDown
                                className={cn(
                                  'h-4 w-4 transition-transform duration-200',
                                  open && 'rotate-180'
                                )}
                              />
                            </button>
                          )}
                        </div>
                        {open &&
                          visibleSubTabs &&
                          visibleSubTabs.length > 0 && (
                            <SidebarMenuSub>
                              {visibleSubTabs.map((subTab) => (
                                <SidebarMenuSubItem key={subTab.value}>
                                  <SidebarMenuSubButton
                                    asChild
                                    // 必须同时满足「在本章节」和「参数值匹配」：各章节共用 `tab` 参数，
                                    // 而且缺省时会退回第一个子页签，只看参数值就会让不在当前页的章节
                                    // （例如权限管理的「角色管理」）也跟着亮起来。
                                    isActive={
                                      sectionActive &&
                                      currentSubTab === subTab.value
                                    }
                                    className="data-[active=true]:bg-primary/10 data-[active=true]:font-semibold data-[active=true]:text-primary"
                                  >
                                    <ClusterLink
                                      to={`/settings/${section.value}?${sub.param}=${subTab.value}`}
                                      onClick={handleMenuItemClick}
                                    >
                                      <span>
                                        {t(subTab.labelKey, {
                                          defaultValue: subTab.defaultLabel,
                                        })}
                                      </span>
                                    </ClusterLink>
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
