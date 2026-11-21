import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { OverviewData, PodMetrics, ResourceUsageHistory } from '@/types/api'
import { useCluster } from '@/hooks/use-cluster'

import { API_BASE_URL } from '../api-client'
import { appendCurrentClusterParam } from '../current-cluster'
import { getWebSocketUrl } from '../subpath'
import useWebSocket, { WebSocketMessage } from '../useWebSocket'
import { fetchAPI } from './shared'

// 概览 API
const fetchOverview = (): Promise<OverviewData> => {
  return fetchAPI<OverviewData>('/overview')
}

export const useOverview = (options?: { staleTime?: number }) => {
  return useQuery({
    queryKey: ['overview'],
    queryFn: fetchOverview,
    staleTime: options?.staleTime || 30000, // 30 seconds cache
    refetchInterval: 30000, // Auto refresh every 30 seconds
  })
}

// 资源用量历史 API
export const fetchResourceUsageHistory = (
  duration: string,
  instance?: string
): Promise<ResourceUsageHistory> => {
  const endpoint = `/prometheus/resource-usage-history?duration=${duration}`
  if (instance) {
    return fetchAPI<ResourceUsageHistory>(
      `${endpoint}&instance=${encodeURIComponent(instance)}`
    )
  }
  return fetchAPI<ResourceUsageHistory>(endpoint)
}

export const useResourceUsageHistory = (
  duration: string,
  options?: { staleTime?: number; instance?: string; enabled?: boolean }
) => {
  return useQuery({
    queryKey: ['resource-usage-history', duration, options?.instance],
    queryFn: () => fetchResourceUsageHistory(duration, options?.instance),
    enabled: options?.enabled,
    staleTime: options?.staleTime || 10000, // 10 seconds cache
    refetchInterval: 30000, // Auto refresh every 30 seconds for historical data
    retry: 0,
    placeholderData: (prevData) => prevData, // Keep previous data while loading new data
  })
}

// Pod 监控 API 函数
export const fetchPodMetrics = (
  namespace: string,
  podName: string,
  duration: string,
  container?: string,
  labelSelector?: string
): Promise<PodMetrics> => {
  let endpoint = `/prometheus/pods/${namespace}/${podName}/metrics?duration=${duration}`
  if (container) {
    endpoint += `&container=${encodeURIComponent(container)}`
  }
  if (labelSelector) {
    endpoint += `&labelSelector=${encodeURIComponent(labelSelector)}`
  }
  return fetchAPI<PodMetrics>(endpoint)
}

export const usePodMetrics = (
  namespace: string,
  podName: string,
  duration: string,
  options?: {
    staleTime?: number
    container?: string
    refreshInterval?: number
    labelSelector?: string
  }
) => {
  return useQuery({
    queryKey: [
      'pod-metrics',
      namespace,
      podName,
      duration,
      options?.container,
      options?.labelSelector,
    ],
    queryFn: () =>
      fetchPodMetrics(
        namespace,
        podName,
        duration,
        options?.container,
        options?.labelSelector
      ),
    enabled: !!namespace && !!podName,
    staleTime: options?.staleTime || 10000, // 10 seconds cache
    refetchInterval: options?.refreshInterval || 30 * 1000, // 1 second
    retry: 0,
    placeholderData: (prevData) => prevData,
  })
}
// 日志 API 函数
export interface LogsResponse {
  logs: string[]
  container?: string
  pod: string
  namespace: string
}

// 获取静态日志的函数（follow=false）
export const fetchPodLogs = (
  namespace: string,
  podName: string,
  options?: {
    container?: string
    tailLines?: number
    timestamps?: boolean
    previous?: boolean
    sinceSeconds?: number
  }
): Promise<LogsResponse> => {
  const params = new URLSearchParams()
  params.append('follow', 'false') // Explicitly set follow=false for static logs

  if (options?.container) {
    params.append('container', options.container)
  }
  if (options?.tailLines !== undefined) {
    params.append('tailLines', options.tailLines.toString())
  }
  if (options?.timestamps !== undefined) {
    params.append('timestamps', options.timestamps.toString())
  }
  if (options?.previous !== undefined) {
    params.append('previous', options.previous.toString())
  }
  if (options?.sinceSeconds !== undefined) {
    params.append('sinceSeconds', options.sinceSeconds.toString())
  }

  const endpoint = `/logs/${namespace}/${podName}${params.toString() ? `?${params.toString()}` : ''}`
  return fetchAPI<LogsResponse>(endpoint)
}

// 创建基于 SSE 的日志连接的函数（follow=true）
export const createLogsSSEStream = (
  namespace: string,
  podName: string,
  options?: {
    container?: string
    tailLines?: number
    timestamps?: boolean
    previous?: boolean
    sinceSeconds?: number
  },
  onMessage?: (data: string) => void,
  onError?: (error: Error) => void,
  onClose?: () => void,
  onOpen?: () => void
): EventSource => {
  const params = new URLSearchParams()
  params.append('follow', 'true') // Enable streaming

  if (options?.container) {
    params.append('container', options.container)
  }
  if (options?.tailLines !== undefined) {
    params.append('tailLines', options.tailLines.toString())
  }
  if (options?.timestamps !== undefined) {
    params.append('timestamps', options.timestamps.toString())
  }
  if (options?.previous !== undefined) {
    params.append('previous', options.previous.toString())
  }
  if (options?.sinceSeconds !== undefined) {
    params.append('sinceSeconds', options.sinceSeconds.toString())
  }

  appendCurrentClusterParam(params)

  const endpoint = `${API_BASE_URL}/logs/${namespace}/${podName}?${params.toString()}`
  const eventSource = new EventSource(endpoint, {
    withCredentials: true,
  })

  // 处理 SSE open 事件
  eventSource.onopen = () => {
    console.log('SSE connection opened')
    if (onOpen) {
      onOpen()
    }
  }

  // 处理连接已建立
  eventSource.addEventListener('connected', (event: MessageEvent) => {
    console.log('SSE connection established:', event.data)
  })

  // 处理日志消息
  eventSource.addEventListener('log', (event: MessageEvent) => {
    if (onMessage) {
      onMessage(event.data)
    }
  })

  // 处理来自服务端的错误
  eventSource.addEventListener('error', (event: MessageEvent) => {
    try {
      const errorData = JSON.parse(event.data)
      if (onError) {
        onError(new Error(errorData.error))
      }
    } catch {
      // 这不是服务端错误事件，更可能是连接错误
      console.warn('SSE error event without valid JSON data')
    }
  })

  // 处理连接关闭
  eventSource.addEventListener('close', () => {
    eventSource.close()
    if (onClose) {
      onClose()
    }
  })

  // 处理通用 SSE 错误（连接问题）
  eventSource.onerror = (event) => {
    console.error('SSE connection error:', event)
    if (eventSource.readyState === EventSource.CLOSED) {
      console.log('SSE connection closed')
      if (onClose) {
        onClose()
      }
    } else if (eventSource.readyState === EventSource.CONNECTING) {
      console.log('SSE reconnecting...')
    } else {
      if (onError) {
        onError(new Error('SSE connection error'))
      }
    }
  }

  return eventSource
}

// Pod 文件浏览器 API

export const useLogsStream = (
  namespace: string,
  podName: string,
  options?: {
    container?: string
    tailLines?: number
    timestamps?: boolean
    previous?: boolean
    sinceSeconds?: number
    enabled?: boolean
    follow?: boolean
  }
) => {
  const [logs, setLogs] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [downloadSpeed, setDownloadSpeed] = useState(0)
  const eventSourceRef = useRef<EventSource | null>(null)
  const networkStatsRef = useRef({
    lastReset: Date.now(),
    bytesReceived: 0,
  })
  const speedUpdateTimerRef = useRef<NodeJS.Timeout | null>(null)

  const stopStreaming = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }

    // 清除速率更新定时器
    if (speedUpdateTimerRef.current) {
      clearInterval(speedUpdateTimerRef.current)
      speedUpdateTimerRef.current = null
    }

    setIsConnected(false)
    setIsLoading(false)
    setDownloadSpeed(0)
  }, [])

  const startStreaming = useCallback(async () => {
    if (!namespace || !podName || options?.enabled === false) return

    // 先关闭已有连接，避免竞态
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }

    try {
      setIsLoading(true)
      setError(null)
      setLogs([]) // Clear previous logs when starting new stream

      if (options?.follow) {
        // follow 模式使用 SSE
        const eventSource = createLogsSSEStream(
          namespace,
          podName,
          {
            container: options?.container,
            tailLines: options?.tailLines,
            timestamps: options?.timestamps,
            previous: options?.previous,
            sinceSeconds: options?.sinceSeconds,
          },
          // onMessage 回调
          (logLine: string) => {
            // 计算数据量，用于跟踪网络速率
            const dataSize = new Blob([logLine]).size
            networkStatsRef.current.bytesReceived += dataSize

            setLogs((prev) => [...prev, logLine])
          },
          // onError 回调
          (err: Error) => {
            console.error('SSE error:', err)
            setError(err)
            setIsLoading(false)
            setIsConnected(false)
          },
          // onClose 回调
          () => {
            setIsLoading(false)
            setIsConnected(false)
          },
          // onOpen 回调
          () => {
            setIsLoading(false)
            setIsConnected(true)
            setError(null)

            // 重置网络统计并开始速率跟踪
            networkStatsRef.current = {
              lastReset: Date.now(),
              bytesReceived: 0,
            }
            setDownloadSpeed(0)

            // 启动周期性速率更新定时器
            if (speedUpdateTimerRef.current) {
              clearInterval(speedUpdateTimerRef.current)
            }
            speedUpdateTimerRef.current = setInterval(() => {
              const now = Date.now()
              const stats = networkStatsRef.current
              const timeDiff = (now - stats.lastReset) / 1000

              if (timeDiff > 0) {
                const downloadSpeedValue = stats.bytesReceived / timeDiff
                setDownloadSpeed(downloadSpeedValue)

                // 每 3 秒重置计数
                if (timeDiff >= 3) {
                  stats.lastReset = now
                  stats.bytesReceived = 0
                }
              }
            }, 500)
          }
        )

        eventSourceRef.current = eventSource
      } else {
        // 非 follow 模式改用静态 fetch
        const response = await fetchPodLogs(namespace, podName, {
          container: options?.container,
          tailLines: options?.tailLines,
          timestamps: options?.timestamps,
          previous: options?.previous,
          sinceSeconds: options?.sinceSeconds,
        })

        setLogs(response.logs || [])
      }
    } catch (err) {
      if (err instanceof Error) {
        setError(err)
      }
    } finally {
      if (!options?.follow) {
        setIsLoading(false)
        setIsConnected(false)
      }
    }
  }, [
    namespace,
    podName,
    options?.container,
    options?.tailLines,
    options?.timestamps,
    options?.previous,
    options?.sinceSeconds,
    options?.enabled,
    options?.follow,
  ])

  const refetch = useCallback(() => {
    stopStreaming()
    setTimeout(startStreaming, 100) // Small delay to ensure cleanup
  }, [stopStreaming, startStreaming])

  useEffect(() => {
    if (options?.enabled !== false) {
      startStreaming()
    }

    return () => {
      stopStreaming()
    }
  }, [startStreaming, stopStreaming, options?.enabled])

  // 卸载时清理
  useEffect(() => {
    return stopStreaming
  }, [stopStreaming])

  return {
    logs,
    isLoading,
    error,
    isConnected,
    downloadSpeed,
    refetch,
    stopStreaming,
  }
}
export const useLogsWebSocket = (
  namespace: string,
  podName: string,
  options?: {
    container?: string
    tailLines?: number
    timestamps?: boolean
    previous?: boolean
    sinceSeconds?: number
    enabled?: boolean
    labelSelector?: string
    onNewLog?: (log: string) => void
    /**
     * 服务端 error 帧的回调。日志流失败时不能只进 console，
     * 面板需要把它显示出来（缺陷 D-53）。
     */
    onStreamError?: (message: string, code?: string) => void
    onClear?: () => void
  }
) => {
  const { currentCluster } = useCluster()
  const onClear = options?.onClear

  // 构造 WebSocket URL
  const buildWebSocketUrl = useCallback(() => {
    if (!options?.enabled || !namespace || !podName) return ''

    const params = new URLSearchParams()

    if (options.container) {
      params.append('container', options.container)
    }
    if (options.tailLines !== undefined) {
      params.append('tailLines', options.tailLines.toString())
    }
    if (options.timestamps !== undefined) {
      params.append('timestamps', options.timestamps.toString())
    }
    if (options.previous !== undefined) {
      params.append('previous', options.previous.toString())
    }
    if (options.sinceSeconds !== undefined) {
      params.append('sinceSeconds', options.sinceSeconds.toString())
    }
    if (options.labelSelector) {
      params.append('labelSelector', options.labelSelector)
    }

    appendCurrentClusterParam(params, currentCluster)

    const wsPath = `/api/v1/logs/${namespace}/${podName}/ws?${params.toString()}`
    return getWebSocketUrl(wsPath)
  }, [
    namespace,
    podName,
    options?.container,
    options?.tailLines,
    options?.timestamps,
    options?.previous,
    options?.sinceSeconds,
    options?.enabled,
    options?.labelSelector,
    currentCluster,
  ])

  // WebSocket 事件处理器
  const handleMessage = useCallback(
    (message: WebSocketMessage) => {
      switch (message.type) {
        case 'log':
          if (message.data && options?.onNewLog) {
            options.onNewLog(message.data)
          }
          break
        case 'error':
          // 不能只写 console：限流、「没有上一次容器」这类情况界面必须说清原因，
          // 否则用户只看到一个空白面板（缺陷 D-53）。
          console.error('Log streaming error:', message.data)
          options?.onStreamError?.(
            message.data || '',
            (message as { code?: string }).code
          )
          break
        case 'close':
          console.log('Log stream closed:', message.data)
          break
      }
    },
    [options]
  )

  const handleOpen = useCallback(() => {
    console.debug('WebSocket connection opened')
    // 这里有意不调用 options.onClear。
    // 历史日志缓冲（tailLines）由服务端在 WebSocket 打开后
    // 立即下发。若每次 onopen 都清空，会与这次下发产生竞态，
    // 把 tail 历史抹掉（重连时尤其明显）。
    // 组件应在用户切换 pod / 容器 / tailLines 参数时
    // 显式清空编辑器。
  }, [])

  const handleClose = useCallback(() => {
    console.debug('WebSocket connection closed')
  }, [])

  const handleError = useCallback((event: Event) => {
    console.debug('WebSocket error:', event)
  }, [])

  // 使用通用的 WebSocket hook
  const [wsState, wsActions] = useWebSocket(
    buildWebSocketUrl,
    {
      onMessage: handleMessage,
      onOpen: handleOpen,
      onClose: handleClose,
      onError: handleError,
    },
    {
      enabled: options?.enabled !== false,
      reconnectOnClose: true,
      maxReconnectAttempts: 3,
      reconnectInterval: 5000,
    }
  )

  useEffect(() => {
    onClear?.()
  }, [currentCluster, onClear])

  const refetch = useCallback(() => {
    wsActions.reconnect()
    if (options?.onClear) {
      options.onClear()
    }
  }, [wsActions, options])

  const stopStreaming = useCallback(() => {
    wsActions.disconnect()
  }, [wsActions])

  const clearLogs = useCallback(() => {
    if (options?.onClear) {
      options.onClear()
    }
  }, [options])

  return useMemo(
    () => ({
      isLoading: wsState.isConnecting,
      error: wsState.error,
      isConnected: wsState.isConnected,
      downloadSpeed: wsState.networkStats.downloadSpeed,
      refetch,
      stopStreaming,
      clearLogs,
    }),
    [
      wsState.isConnecting,
      wsState.error,
      wsState.isConnected,
      wsState.networkStats.downloadSpeed,
      refetch,
      stopStreaming,
      clearLogs,
    ]
  )
}
