import { useMemo, useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { useTerminal } from '@/contexts/terminal-context'
import { House, Plus, Settings, TerminalSquare } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useClusterLocation, useClusterNavigate } from '@/lib/cluster-path'
import { resourceMetadataList } from '@/lib/resource-catalog'
import { useCanAnyNamespace } from '@/hooks/use-can'
import { useIsMobile } from '@/hooks/use-mobile'
import { Separator } from '@/components/ui/separator'
import { SidebarTrigger } from '@/components/ui/sidebar'

import { AnnouncementBar } from './announcement-bar'
import { CreateResourceDialog } from './create-resource-dialog'
import { CurrentClusterBadge } from './current-cluster-badge'
import { DynamicBreadcrumb } from './dynamic-breadcrumb'
import { LanguageToggle } from './language-toggle'
import { ModeToggle } from './mode-toggle'
import { NavigationControls } from './navigation-controls'
import { NotificationBell } from './notification-bell'
import { Search } from './search'
import { UserMenu } from './user-menu'

export function SiteHeader() {
  const isMobile = useIsMobile()
  const navigate = useClusterNavigate()
  const { pathname } = useClusterLocation()
  const { t } = useTranslation()
  const { user, capabilities } = useAuth()
  const { toggleTerminal, sessions } = useTerminal()
  // 顶栏按钮只管 kubectl 会话：工作区里可能还有别的 Pod/节点/日志会话。
  const hasKubectlSession = sessions.some(
    (session) => session.type === 'kubectl'
  )
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const isAdmin = user?.isAdmin() ?? false
  const can = useCanAnyNamespace()
  // 顶栏的「创建资源」是通用 YAML apply 入口：只有确实能创建至少一种资源时才展示，
  // 否则只读账号会看到一个必然被后端拒绝的入口。
  const canCreateAnyResource = useMemo(
    () => resourceMetadataList.some((meta) => can(meta.type, 'create')),
    [can]
  )
  // 系统设置入口对所有能打开至少一个设置章节的账号可见（含安全管理员 / 审计管理员）。
  const canViewSettings = user?.canViewSettings() ?? false
  const kubectlEnabled = capabilities.kubectlEnabled

  return (
    <>
      <header className="sticky top-0 z-50 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
        {/* min-w-0：这一层必须能收缩，否则右侧那组固定宽度的元素（公告栏、集群徽章、
            搜索）不会让步，压力全落在面包屑上，把它挤到只剩几个字宽。 */}
        <div className="flex w-full min-w-0 items-center gap-1 px-4 lg:gap-2 lg:px-6">
          <SidebarTrigger className="-ml-1" />
          <Separator
            orientation="vertical"
            className="mx-2 data-[orientation=vertical]:h-4"
          />
          <NavigationControls />
          {pathname.startsWith('/settings') && (
            <button
              type="button"
              onClick={() => navigate('/')}
              aria-label={t('common.actions.goHome', 'Go home')}
              title={t('common.actions.goHome', 'Go home')}
              className="flex items-center justify-center rounded-sm p-1 text-muted-foreground transition-colors hover:text-foreground"
            >
              <House className="h-4 w-4" />
            </button>
          )}
          <DynamicBreadcrumb />
          {/* flex-1 + min-w-0：这一组要吃掉面包屑之外的剩余宽度，里面的公告栏才能做到
              「空间大就长、空间小就短」（见 AnnouncementBar 的注释）。
              面包屑默认是 `flex: 0 1 auto`，基础宽度按内容算、又不参与 grow，
              因此它的宽度不受影响，弹性全部落在公告栏上；justify-end 保证内容仍靠右。 */}
          <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2">
            {/* 公告在集群徽章之前（两者同属顶栏的右侧信息区）。 */}
            <AnnouncementBar />
            {/* 集群名不在这里重复：左侧栏的集群选择器已经显示了当前集群。 */}
            <CurrentClusterBadge showName={false} />
            <Search />
            {canCreateAnyResource && (
              <Plus
                className="h-5 w-5 cursor-pointer text-muted-foreground hover:text-foreground"
                onClick={() => setCreateDialogOpen(true)}
                aria-label={t(
                  'common.actions.createNewResource',
                  'Create new resource'
                )}
              />
            )}
            {isAdmin && kubectlEnabled && (
              <button
                onClick={toggleTerminal}
                title={t('nav.kubectl', 'Kubectl Terminal')}
                aria-label={t(
                  'common.actions.toggleKubectlTerminal',
                  'Toggle Kubectl Terminal'
                )}
                className={`flex items-center justify-center rounded-sm p-1 transition-colors ${
                  hasKubectlSession
                    ? 'text-success hover:text-success/80'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <TerminalSquare className="h-5 w-5" />
              </button>
            )}
            {!isMobile && (
              <>
                <Separator
                  orientation="vertical"
                  className="mx-2 data-[orientation=vertical]:h-4"
                />
                {canViewSettings && (
                  <button
                    type="button"
                    onClick={() => navigate('/settings')}
                    aria-label={t('nav.settings', 'System Settings')}
                    title={t('nav.settings', 'System Settings')}
                    className="flex items-center justify-center rounded-sm p-1 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <Settings className="h-5 w-5" />
                  </button>
                )}
                <NotificationBell />
                <LanguageToggle />
                <ModeToggle />
              </>
            )}
            <UserMenu />
          </div>
        </div>
      </header>

      {canCreateAnyResource && createDialogOpen ? (
        <CreateResourceDialog
          open={createDialogOpen}
          onOpenChange={setCreateDialogOpen}
        />
      ) : null}
    </>
  )
}
