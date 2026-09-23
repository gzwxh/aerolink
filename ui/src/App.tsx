import './App.css'

import { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Outlet, useSearchParams } from 'react-router-dom'

import { AIChatbox, StandaloneAIChatbox } from './components/ai-chat/ai-chatbox'
import { AppSidebar } from './components/app-sidebar'
import { ErrorBoundary } from './components/error-boundary'
import { FloatingTerminal } from './components/floating-terminal'
import { GlobalSearch } from './components/global-search'
import {
  GlobalSearchProvider,
  useGlobalSearch,
} from './components/global-search-provider'
import { MFAEnrollmentGate } from './components/mfa-enrollment-gate'
import { MFAPromptDialog } from './components/mfa-prompt-dialog'
import { ServiceStatusOverlay } from './components/service-status-overlay'
import { SessionSupersededDialog } from './components/session-superseded-dialog'
import { SiteHeader } from './components/site-header'
import { SidebarInset, SidebarProvider } from './components/ui/sidebar'
import { Toaster } from './components/ui/sonner'
import { AIChatProvider } from './contexts/ai-chat-context'
import { ClusterProvider } from './contexts/cluster-context'
import { NavigationProvider } from './contexts/navigation-context'
import { TerminalProvider, useTerminal } from './contexts/terminal-context'
import { useCluster } from './hooks/use-cluster'
import { useSessionHeartbeat } from './hooks/use-session-heartbeat'
import { useSessionTakeoverNotice } from './hooks/use-session-takeover-notice'

function ClusterGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const { isLoading, error } = useCluster()

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="flex items-center space-x-2">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary" />
          <span>{t('cluster.loading')}</span>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-destructive">
          <p>{t('cluster.error', { error: error.message })}</p>
        </div>
      </div>
    )
  }

  return <>{children}</>
}

function AppContent() {
  const { isOpen, closeSearch } = useGlobalSearch()
  const { isOpen: isTerminalOpen } = useTerminal()
  const [searchParams] = useSearchParams()
  const isIframe = searchParams.get('iframe') === 'true'

  if (isIframe) {
    return <Outlet />
  }

  return (
    <>
      <SidebarProvider>
        <AppSidebar variant="inset" />
        <SidebarInset className="h-dvh overflow-y-auto overscroll-none scrollbar-hide">
          {/* 通知栏在顶栏里（见 SiteHeader 的右侧信息区），不另外占一行。 */}
          <SiteHeader />
          <div className="@container/main flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1 flex-col gap-4 py-4 md:gap-6">
              <div className="flex min-h-0 flex-1 flex-col px-4 lg:px-6">
                <ErrorBoundary>
                  <Outlet />
                </ErrorBoundary>
              </div>
            </div>
          </div>
        </SidebarInset>
      </SidebarProvider>
      {isOpen ? (
        <GlobalSearch open={isOpen} onOpenChange={closeSearch} />
      ) : null}
      {isTerminalOpen ? (
        <ErrorBoundary fallback={null}>
          <FloatingTerminal />
        </ErrorBoundary>
      ) : null}
      <ErrorBoundary fallback={null}>
        <AIChatbox />
      </ErrorBoundary>
      <MFAPromptDialog />
      {/* 提示统一在顶部居中、约 3 秒自动消失（全局默认时长）。 */}
      <Toaster position="top-center" richColors closeButton duration={3000} />
    </>
  )
}

function AppProviders({ children }: { children: ReactNode }) {
  // 单点登录：把其他设备的会话顶下线后，在新设备上提示一次。
  useSessionTakeoverNotice()
  // 在已登录页面上持续探活：会话被顶下线后马上弹提示，不用等下一次页面操作。
  useSessionHeartbeat()

  return (
    <TerminalProvider>
      <ClusterProvider>
        <NavigationProvider>
          <GlobalSearchProvider>
            <AIChatProvider>
              {children}
              {/* 账号被顶下线的提示（单点登录）：主界面与独立 AI 页共用一个实例。 */}
              <SessionSupersededDialog />
              {/* 服务异常横幅、以及登录跳转成环时的阻断页：主界面与独立 AI 页共用。 */}
              <ServiceStatusOverlay />
            </AIChatProvider>
          </GlobalSearchProvider>
        </NavigationProvider>
      </ClusterProvider>
    </TerminalProvider>
  )
}

function App() {
  return (
    <AppProviders>
      <MFAEnrollmentGate>
        <ClusterGate>
          <AppContent />
        </ClusterGate>
      </MFAEnrollmentGate>
    </AppProviders>
  )
}

export function StandaloneAIChatApp() {
  return (
    <AppProviders>
      <MFAEnrollmentGate>
        <ClusterGate>
          <StandaloneAIChatbox />
        </ClusterGate>
      </MFAEnrollmentGate>
    </AppProviders>
  )
}

export default App
