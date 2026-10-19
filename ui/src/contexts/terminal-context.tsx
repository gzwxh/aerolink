import { createContext, ReactNode, useContext, useMemo, useState } from 'react'
import type {
  Container,
  EphemeralContainer,
  Pod,
} from 'kubernetes-types/core/v1'

import { getCurrentCluster } from '@/lib/current-cluster'

/** 底部工作区里的一种会话：终端（Pod / 节点 / kubectl）或日志。 */
export type WorkspaceSessionType = 'node' | 'pod' | 'kubectl' | 'logs'

export interface WorkspaceSessionSpec {
  type: WorkspaceSessionType
  title?: string
  subtitle?: string
  clusterName?: string
  namespace?: string
  podName?: string
  nodeName?: string
  containerName?: string
  pods?: Pod[]
  containers?: Container[]
  initContainers?: Container[]
  ephemeralContainers?: EphemeralContainer[]
  labelSelector?: string
  attachContainerName?: string
  /** 开session的来源（资源类型），用于会话去重与标题展示。 */
  source?: string
}

export interface WorkspaceSession extends WorkspaceSessionSpec {
  id: string
  title: string
  clusterName: string
  createdAt: number
}

interface TerminalContextType {
  isOpen: boolean
  isMinimized: boolean
  sessions: WorkspaceSession[]
  activeSession: WorkspaceSession | null
  activeSessionId: string | null
  openTerminal: () => void
  restoreTerminal: () => void
  openSession: (spec: WorkspaceSessionSpec) => string
  activateSession: (sessionId: string) => void
  closeSession: (sessionId: string) => void
  closeTerminal: () => void
  minimizeTerminal: () => void
  toggleTerminal: () => void
}

const TerminalContext = createContext<TerminalContextType | undefined>(
  undefined
)

export function TerminalProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<WorkspaceSession[]>([])
  const [requestedActiveId, setRequestedActiveId] = useState<string | null>(
    null
  )
  const [isMinimized, setIsMinimized] = useState(false)
  const isOpen = sessions.length > 0

  // 活动会话由列表推导：关掉当前会话后自动落到最后一个，避免在 setSessions 的
  // updater 里嵌套 setState（StrictMode 下会重复执行）。
  const activeSession = useMemo(
    () =>
      sessions.find((session) => session.id === requestedActiveId) ??
      sessions[sessions.length - 1] ??
      null,
    [requestedActiveId, sessions]
  )
  const activeSessionId = activeSession?.id ?? null

  const openSession = (spec: WorkspaceSessionSpec) => {
    const session = createWorkspaceSession(spec)
    setSessions((current) =>
      current.some((item) => item.id === session.id)
        ? current
        : [...current, session]
    )
    setRequestedActiveId(session.id)
    setIsMinimized(false)
    return session.id
  }

  // 打开（或复用）默认的 kubectl 终端。
  const openTerminal = () => {
    openSession({ type: 'kubectl', title: 'kubectl', source: 'global' })
  }

  const activateSession = (sessionId: string) => {
    setRequestedActiveId(sessionId)
    setIsMinimized(false)
  }

  /** 展开忙碌面板（会话已存在时只取消最小化）。 */
  const restoreTerminal = () => {
    if (isOpen) {
      setIsMinimized(false)
    }
  }

  const closeSession = (sessionId: string) => {
    setSessions((current) =>
      current.filter((session) => session.id !== sessionId)
    )
  }

  /** 关闭全部会话并销毁其终端 / 日志连接。 */
  const closeTerminal = () => {
    setSessions([])
    setRequestedActiveId(null)
    setIsMinimized(false)
  }

  /** 隐藏面板但保持会话存活。 */
  const minimizeTerminal = () => {
    setIsMinimized(true)
  }

  const toggleTerminal = () => {
    if (!isOpen) {
      openTerminal()
    } else if (isMinimized) {
      setIsMinimized(false)
    } else {
      minimizeTerminal()
    }
  }

  return (
    <TerminalContext.Provider
      value={{
        isOpen,
        isMinimized,
        sessions,
        activeSession,
        activeSessionId,
        openTerminal,
        restoreTerminal,
        openSession,
        activateSession,
        closeSession,
        closeTerminal,
        minimizeTerminal,
        toggleTerminal,
      }}
    >
      {children}
    </TerminalContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTerminal() {
  const context = useContext(TerminalContext)
  if (context === undefined) {
    throw new Error('useTerminal must be used within a TerminalProvider')
  }
  return context
}

function createWorkspaceSession(spec: WorkspaceSessionSpec): WorkspaceSession {
  const clusterName = spec.clusterName ?? getCurrentCluster() ?? ''
  return {
    ...spec,
    id: [
      clusterName,
      spec.type,
      spec.source ?? '',
      spec.namespace ?? '',
      spec.podName ?? '',
      spec.nodeName ?? '',
      spec.containerName ?? '',
      spec.labelSelector ?? '',
    ].join(':'),
    title: spec.title ?? createSessionTitle(spec),
    clusterName,
    createdAt: Date.now(),
  }
}

/** 默认标题只用资源名（不落可翻译文案），具体展示由面板按需拼装。 */
function createSessionTitle(spec: WorkspaceSessionSpec) {
  if (spec.type === 'kubectl') {
    return 'kubectl'
  }

  if (spec.type === 'node') {
    return spec.nodeName ?? ''
  }

  const containerSuffix = spec.containerName ? ` · ${spec.containerName}` : ''
  return `${spec.podName ?? spec.labelSelector ?? spec.namespace ?? ''}${containerSuffix}`
}
