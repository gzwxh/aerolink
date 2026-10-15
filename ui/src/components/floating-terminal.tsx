import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { useTerminal } from '@/contexts/terminal-context'
import {
  ChevronDown,
  ChevronUp,
  Maximize2,
  Minimize2,
  Monitor,
  Plus,
  ScrollText,
  Server,
  SquareTerminal,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { LogViewer } from '@/components/log-viewer'
import { Terminal } from '@/components/terminal'

import type { WorkspaceSession } from '@/contexts/terminal-context'

const MIN_HEIGHT = 120
const DEFAULT_HEIGHT_VH = 40

function SessionIcon({ type }: { type: WorkspaceSession['type'] }) {
  if (type === 'kubectl') return <SquareTerminal className="h-3.5 w-3.5" />
  if (type === 'node') return <Server className="h-3.5 w-3.5" />
  if (type === 'logs') return <ScrollText className="h-3.5 w-3.5" />
  return <Monitor className="h-3.5 w-3.5" />
}

function sessionDescription(session: WorkspaceSession) {
  return [session.clusterName, session.namespace, session.containerName]
    .filter(Boolean)
    .join(' · ')
}

export function FloatingTerminal() {
  const { t } = useTranslation()
  const { user, capabilities } = useAuth()
  const {
    isOpen,
    isMinimized,
    sessions,
    activeSessionId,
    openTerminal,
    activateSession,
    closeSession,
    closeTerminal,
    minimizeTerminal,
    restoreTerminal,
  } = useTerminal()
  const isAdmin = user?.isAdmin() ?? false
  const kubectlEnabled = capabilities.kubectlEnabled
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [height, setHeight] = useState(
    () => (window.innerHeight * DEFAULT_HEIGHT_VH) / 100
  )
  // 日志会话会拉起 Monaco 与日志 WebSocket：首次激活时才挂载，之后隐藏保活，
  // 避免一开面板就把所有日志会话的 Monaco 都实例化一遍。
  const [mountedSessionIds, setMountedSessionIds] = useState<string[]>([])
  const dragging = useRef(false)
  const startY = useRef(0)
  const startH = useRef(0)
  const [toolbarHostElement, setToolbarHostElement] =
    useState<HTMLDivElement | null>(null)

  // kubectl 被设置关闭时不再展示 kubectl 会话（入口本身也已按该开关收敛）。
  const visibleSessions = useMemo(
    () =>
      kubectlEnabled
        ? sessions
        : sessions.filter((session) => session.type !== 'kubectl'),
    [kubectlEnabled, sessions]
  )
  const activeSession = useMemo(
    () => visibleSessions.find((session) => session.id === activeSessionId),
    [activeSessionId, visibleSessions]
  )

  useEffect(() => {
    if (!activeSessionId) return
    setMountedSessionIds((current) =>
      current.includes(activeSessionId) ? current : [...current, activeSessionId]
    )
  }, [activeSessionId])

  const setToolbarHostRef = useCallback((node: HTMLDivElement | null) => {
    setToolbarHostElement(node)
  }, [])

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (isMinimized || isFullscreen) return
      dragging.current = true
      startY.current = e.clientY
      startH.current = height
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    },
    [height, isFullscreen, isMinimized]
  )

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return
    const maxHeight = window.innerHeight * 0.75
    const newH = Math.min(
      maxHeight,
      Math.max(MIN_HEIGHT, startH.current + (startY.current - e.clientY))
    )
    setHeight(newH)
  }, [])

  const onPointerUp = useCallback(() => {
    dragging.current = false
  }, [])

  const toggleFullscreen = useCallback(() => {
    setIsFullscreen((prev) => !prev)
  }, [])

  const handleMinimize = useCallback(() => {
    setIsFullscreen(false)
    if (isMinimized) {
      restoreTerminal()
      return
    }
    minimizeTerminal()
  }, [isMinimized, minimizeTerminal, restoreTerminal])

  const handleClose = useCallback(() => {
    setIsFullscreen(false)
    closeTerminal()
  }, [closeTerminal])

  const activeToolbarPortalElement = isMinimized ? null : toolbarHostElement

  if (!isOpen || visibleSessions.length === 0) return null

  return (
    <div
      className={
        isFullscreen
          ? 'fixed inset-0 z-50 flex flex-col bg-background shadow-2xl'
          : 'fixed bottom-0 left-0 right-0 z-50 flex flex-col border-t bg-background shadow-2xl'
      }
      style={{
        height: isMinimized ? 40 : isFullscreen ? '100dvh' : height,
      }}
    >
      {/* Drag handle */}
      {!isMinimized && !isFullscreen && (
        <div
          className="absolute -top-1 left-0 right-0 h-2 cursor-ns-resize z-10"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
      )}

      {/* Header */}
      <div className="flex min-h-10 shrink-0 items-center justify-between gap-3 border-b bg-muted/50 px-3 py-1">
        <button
          className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-sm font-semibold text-foreground transition-opacity hover:opacity-70"
          onClick={handleMinimize}
        >
          <span className="bg-success h-2.5 w-2.5 shrink-0 rounded-full shadow-sm" />
          <span className="shrink-0 truncate">
            {t('terminalWorkspace.title')}
          </span>
          {activeSession ? (
            <span className="hidden min-w-0 truncate text-xs font-normal text-muted-foreground md:inline">
              {activeSession.title}
              {sessionDescription(activeSession)
                ? ` · ${sessionDescription(activeSession)}`
                : ''}
            </span>
          ) : null}
        </button>

        {/* 活动会话自己的工具栏（Pod/容器选择器、主题、字号、清屏）挂在这里。 */}
        <div
          ref={setToolbarHostRef}
          className={cn(
            'ml-auto hidden min-w-0 items-center justify-end gap-2 lg:flex',
            isMinimized && 'lg:hidden'
          )}
        />

        <div className="flex shrink-0 items-center">
          {isAdmin && kubectlEnabled && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={openTerminal}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {t('terminalWorkspace.newTerminal')}
                </TooltipContent>
              </Tooltip>

              <Separator orientation="vertical" className="mx-1 h-4" />
            </>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={toggleFullscreen}
                disabled={isMinimized}
              >
                {isFullscreen ? (
                  <Minimize2 className="h-4 w-4" />
                ) : (
                  <Maximize2 className="h-4 w-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {isFullscreen
                ? t('terminalWorkspace.exitFullscreen')
                : t('terminalWorkspace.fullscreen')}
            </TooltipContent>
          </Tooltip>

          <Separator orientation="vertical" className="mx-1 h-4" />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={handleMinimize}
              >
                {isMinimized ? (
                  <ChevronUp className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {isMinimized
                ? t('terminalWorkspace.restore')
                : t('terminalWorkspace.minimize')}
            </TooltipContent>
          </Tooltip>

          <Separator orientation="vertical" className="mx-1 h-4" />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 hover:bg-destructive hover:text-destructive-foreground"
                onClick={handleClose}
              >
                <X className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {t('terminalWorkspace.closeAllSessions')}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div
        className="min-h-0 flex-1 flex-col"
        style={{ display: isMinimized ? 'none' : 'flex' }}
      >
        {/* 会话页签：非活动会话只隐藏、不卸载，终端与日志流因此得以保活。 */}
        <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b bg-background px-2">
          {visibleSessions.map((session) => {
            const active = session.id === activeSessionId
            return (
              <button
                key={session.id}
                type="button"
                className={cn(
                  'group flex h-7 min-w-[140px] max-w-[260px] items-center gap-2 rounded-md border px-2 text-left text-xs transition-colors',
                  active
                    ? 'border-primary/40 bg-primary/10 text-foreground'
                    : 'border-transparent bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
                onClick={() => activateSession(session.id)}
              >
                <span className="shrink-0">
                  <SessionIcon type={session.type} />
                </span>
                <span className="min-w-0 flex-1 truncate">{session.title}</span>
                <span className="hidden shrink-0 text-[11px] text-muted-foreground xl:inline">
                  {session.clusterName}
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  className="rounded p-0.5 opacity-60 hover:bg-background hover:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation()
                    closeSession(session.id)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      event.stopPropagation()
                      closeSession(session.id)
                    }
                  }}
                  aria-label={t('terminalWorkspace.closeSession')}
                >
                  <X className="h-3 w-3" />
                </span>
              </button>
            )
          })}
        </div>

        <div className="relative min-h-0 flex-1">
          {visibleSessions.map((session) => {
            const active = session.id === activeSessionId
            const shouldMount =
              session.type !== 'logs' || mountedSessionIds.includes(session.id)
            return (
              <div
                key={session.id}
                className={cn('absolute inset-0 min-h-0', active ? 'block' : 'hidden')}
              >
                {session.type === 'logs' ? (
                  shouldMount ? (
                    <LogViewer
                      namespace={session.namespace ?? ''}
                      podName={session.podName}
                      pods={session.pods}
                      labelSelector={session.labelSelector}
                      containers={session.containers}
                      initContainers={session.initContainers}
                      ephemeralContainers={session.ephemeralContainers}
                      selectedContainerName={session.containerName}
                      onClose={() => closeSession(session.id)}
                    />
                  ) : null
                ) : (
                  <Terminal
                    type={session.type}
                    clusterName={session.clusterName}
                    namespace={session.namespace}
                    podName={session.podName}
                    nodeName={session.nodeName}
                    pods={session.pods}
                    containers={session.containers}
                    initContainers={session.initContainers}
                    ephemeralContainers={session.ephemeralContainers}
                    attachContainerName={session.attachContainerName}
                    selectedContainerName={session.containerName}
                    embedded
                    embeddedToolbar
                    toolbarPortalElement={
                      active ? activeToolbarPortalElement : null
                    }
                  />
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}