import { useCallback, useMemo, useState } from 'react'
import { useTerminal } from '@/contexts/terminal-context'
import type {
  Container,
  EphemeralContainer,
  Pod,
} from 'kubernetes-types/core/v1'
import { ScrollText, SquareTerminal } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { toSimpleContainer } from '@/lib/k8s'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ContainerSelector } from '@/components/selector/container-selector'
import { PodSelector } from '@/components/selector/pod-selector'

export interface TerminalLauncherProps {
  /** terminal：开一个终端会话；logs：开一路日志会话 */
  mode?: 'terminal' | 'logs'
  type?: 'pod' | 'node'
  namespace?: string
  podName?: string
  nodeName?: string
  pods?: Pod[]
  containers?: Container[]
  initContainers?: Container[]
  ephemeralContainers?: EphemeralContainer[]
  /** 命中容器时优先 attach 而不是 exec */
  attachContainerName?: string
  /** 预选容器 */
  selectedContainerName?: string
  labelSelector?: string
  /** 开session来源（资源类型），用于会话去重与标题 */
  source?: string
  className?: string
  /** 会话开出去之后的回调（例如把承载启动器的弹窗关掉） */
  onOpen?: () => void
}

export type OpenWorkspaceSessionOptions = Omit<
  TerminalLauncherProps,
  'className' | 'onOpen'
>

/**
 * 不经过选择界面、按默认目标把会话直接开进底部工作区：
 * 终端落到点名（或第一个）Pod 的预选/attach/第一个容器；日志没点名 Pod 时按 labelSelector 聚合。
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useOpenWorkspaceSession() {
  const { openSession } = useTerminal()

  return useCallback(
    (options: OpenWorkspaceSessionOptions) => {
      const isLogs = options.mode === 'logs'
      const isNode = options.type === 'node'
      const sessionType = isNode ? 'node' : isLogs ? 'logs' : 'pod'
      const podName =
        options.podName ??
        (!isNode && !isLogs ? options.pods?.[0]?.metadata?.name : undefined)
      const containerName = isNode
        ? undefined
        : isLogs
          ? // 日志未点名容器时聚合全部容器；终端必须落到具体容器。
            options.selectedContainerName
          : (options.selectedContainerName ??
            options.attachContainerName ??
            toSimpleContainer(
              options.initContainers,
              options.containers,
              options.ephemeralContainers
            )[0]?.name)

      openSession({
        type: sessionType,
        namespace: options.namespace,
        podName,
        nodeName: options.nodeName,
        containerName,
        pods: options.pods,
        containers: options.containers,
        initContainers: options.initContainers,
        ephemeralContainers: options.ephemeralContainers,
        attachContainerName: options.attachContainerName,
        labelSelector: options.labelSelector,
        source: options.source,
        title: createLauncherTitle({
          type: sessionType,
          podName,
          nodeName: options.nodeName,
          containerName,
          labelSelector: options.labelSelector,
          namespace: options.namespace,
        }),
      })
    },
    [openSession]
  )
}

/**
 * 详情页里的会话启动器：选好 Pod/容器后把终端或日志开进底部工作区，
 * 而不是就地渲染。这样切换页签、切到别的页面都不会中断会话。
 */
export function TerminalLauncher({
  mode = 'terminal',
  type = 'pod',
  namespace,
  podName,
  nodeName,
  pods,
  containers,
  initContainers,
  ephemeralContainers,
  attachContainerName,
  selectedContainerName,
  labelSelector,
  source,
  className,
  onOpen,
}: TerminalLauncherProps) {
  const { t } = useTranslation()
  const openWorkspaceSession = useOpenWorkspaceSession()
  const isLogs = mode === 'logs'
  const isNode = type === 'node'

  const containerOptions = useMemo(
    () => toSimpleContainer(initContainers, containers, ephemeralContainers),
    [initContainers, containers, ephemeralContainers]
  )
  const hasPodOptions = !isNode && !!pods && pods.length > 0

  const [selectedPod, setSelectedPod] = useState(
    () => podName ?? (isLogs ? '' : (pods?.[0]?.metadata?.name ?? ''))
  )
  const [selectedContainer, setSelectedContainer] = useState(
    () =>
      selectedContainerName ??
      attachContainerName ??
      (isLogs ? '' : (containerOptions[0]?.name ?? ''))
  )

  const handleOpen = () => {
    openWorkspaceSession({
      mode,
      type,
      namespace,
      podName: selectedPod || undefined,
      nodeName,
      pods,
      containers,
      initContainers,
      ephemeralContainers,
      attachContainerName,
      selectedContainerName: selectedContainer || undefined,
      labelSelector,
      source,
    })
    onOpen?.()
  }

  const missingTarget = !namespace || (!isNode && hasPodOptions && !selectedPod)
  const missingContainer = !isLogs && !isNode && !selectedContainer

  return (
    <div
      className={cn(
        'flex h-full min-h-0 items-center justify-center overflow-auto p-4',
        className
      )}
    >
      <div className="w-full max-w-xl rounded-lg border border-dashed bg-muted/20 p-6 text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted">
          {isLogs ? (
            <ScrollText className="h-5 w-5 text-muted-foreground" />
          ) : (
            <SquareTerminal className="h-5 w-5 text-muted-foreground" />
          )}
        </div>

        <h3 className="text-sm font-medium">
          {isLogs
            ? t('terminalLauncher.logs.title')
            : t('terminalLauncher.terminal.title')}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {isNode
            ? t('terminalLauncher.terminal.nodeDescription')
            : isLogs
              ? t('terminalLauncher.logs.description')
              : t('terminalLauncher.terminal.description')}
        </p>

        {(hasPodOptions || containerOptions.length > 1) && (
          <div className="mt-4 flex flex-col items-stretch justify-center gap-2 sm:flex-row sm:items-center">
            {hasPodOptions && (
              <PodSelector
                pods={pods ?? []}
                selectedPod={selectedPod}
                // 日志可以聚合选中的 Pod 组，终端必须落到具体某个 Pod
                showAllOption={isLogs}
                onPodChange={(name) => setSelectedPod(name ?? '')}
              />
            )}
            {containerOptions.length > 1 && (
              <ContainerSelector
                containers={containerOptions}
                selectedContainer={selectedContainer || undefined}
                showAllOption={isLogs}
                onContainerChange={(name) => setSelectedContainer(name ?? '')}
              />
            )}
          </div>
        )}

        <p className="mt-3 text-xs text-muted-foreground">
          {t('terminalLauncher.hint')}
        </p>

        <Button
          className="mt-4"
          onClick={handleOpen}
          disabled={missingTarget || missingContainer}
        >
          {isLogs
            ? t('terminalLauncher.openLogs')
            : t('terminalLauncher.openTerminal')}
        </Button>
      </div>
    </div>
  )
}

function createLauncherTitle({
  type,
  podName,
  nodeName,
  containerName,
  labelSelector,
  namespace,
}: {
  type: 'pod' | 'node' | 'logs'
  podName?: string
  nodeName?: string
  containerName?: string
  labelSelector?: string
  namespace?: string
}) {
  if (type === 'node') {
    return nodeName ?? ''
  }

  const target = podName ?? labelSelector ?? namespace ?? ''
  return containerName ? `${target} · ${containerName}` : target
}
