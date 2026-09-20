import { useMemo, useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { useTerminal } from '@/contexts/terminal-context'
import { ArrowLeft, Plus, Settings, TerminalSquare } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import { resourceMetadataList } from '@/lib/resource-catalog'
import { useCanAnyNamespace } from '@/hooks/use-can'
import { useIsMobile } from '@/hooks/use-mobile'
import { Separator } from '@/components/ui/separator'
import { SidebarTrigger } from '@/components/ui/sidebar'

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
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { user, capabilities } = useAuth()
  const { toggleTerminal, isOpen } = useTerminal()
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
        <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
          <SidebarTrigger className="-ml-1" />
          <Separator
            orientation="vertical"
            className="mx-2 data-[orientation=vertical]:h-4"
          />
          <NavigationControls />
          {location.pathname.startsWith('/settings') && (
            <button
              type="button"
              onClick={() => navigate('/')}
              aria-label={t(
                'common.actions.backToOverview',
                'Back to overview'
              )}
              title={t('common.actions.backToOverview', 'Back to overview')}
              className="flex items-center justify-center rounded-sm p-1 text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <DynamicBreadcrumb />
          <div className="ml-auto flex items-center gap-2">
            <CurrentClusterBadge />
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
                  isOpen
                    ? 'text-green-500 hover:text-green-600'
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
