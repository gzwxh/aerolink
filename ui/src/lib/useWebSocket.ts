import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export interface WebSocketOptions {
  enabled?: boolean
  speedUpdateInterval?: number
  speedResetInterval?: number
  reconnectOnClose?: boolean
  maxReconnectAttempts?: number
  reconnectInterval?: number
}

export interface WebSocketMessage {
  type: string
  data?: string
  // 可选的机器可读码（如 stream_limit_exceeded），服务端与前端按它而不是按文案分支。
  code?: string
  [key: string]: unknown
}

export interface WebSocketCallbacks {
  onMessage?: (message: WebSocketMessage) => void
  onOpen?: () => void
  onClose?: (event: CloseEvent) => void
  onError?: (error: Event) => void
}

export interface NetworkStats {
  uploadSpeed: number
  downloadSpeed: number
  totalUploaded: number
  totalDownloaded: number
}

export interface WebSocketState {
  isConnected: boolean
  isConnecting: boolean
  error: Error | null
  networkStats: NetworkStats
}

export interface WebSocketActions {
  send: (message: WebSocketMessage | string) => boolean
  disconnect: () => void
  reconnect: () => void
}

const defaultOptions: Required<WebSocketOptions> = {
  enabled: true,
  speedUpdateInterval: 500,
  speedResetInterval: 3000,
  reconnectOnClose: false,
  maxReconnectAttempts: 3,
  reconnectInterval: 5000,
}

export function useWebSocket(
  url: string | (() => string),
  callbacks: WebSocketCallbacks = {},
  options: WebSocketOptions = {}
): [WebSocketState, WebSocketActions] {
  const opts = useMemo(() => ({ ...defaultOptions, ...options }), [options])

  const [isConnected, setIsConnected] = useState(false)
  const [isConnecting, setIsConnecting] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [networkStats, setNetworkStats] = useState<NetworkStats>({
    uploadSpeed: 0,
    downloadSpeed: 0,
    totalUploaded: 0,
    totalDownloaded: 0,
  })

  // WebSocket 与定时器的 ref
  const wsRef = useRef<WebSocket | null>(null)
  const speedUpdateTimerRef = useRef<NodeJS.Timeout | null>(null)
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null)
  const reconnectAttemptsRef = useRef(0)
  const isMountedRef = useRef(true)

  // 网络统计跟踪
  const networkStatsRef = useRef({
    lastReset: Date.now(),
    bytesUploaded: 0,
    bytesDownloaded: 0,
    totalUploaded: 0,
    totalDownloaded: 0,
  })

  // 更新网络统计
  const updateNetworkStats = useCallback((bytes: number, isSent: boolean) => {
    const stats = networkStatsRef.current
    if (isSent) {
      stats.bytesUploaded += bytes
      stats.totalUploaded += bytes
    } else {
      stats.bytesDownloaded += bytes
      stats.totalDownloaded += bytes
    }
  }, [])

  // 清理所有资源
  const cleanupResources = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.onopen = null
      wsRef.current.onclose = null
      wsRef.current.onerror = null
      wsRef.current.onmessage = null
      if (
        wsRef.current.readyState === WebSocket.OPEN ||
        wsRef.current.readyState === WebSocket.CONNECTING
      ) {
        wsRef.current.close()
      }
      wsRef.current = null
    }

    if (speedUpdateTimerRef.current) {
      clearInterval(speedUpdateTimerRef.current)
      speedUpdateTimerRef.current = null
    }

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
  }, [])

  // 启动速率更新定时器
  const startSpeedUpdateTimer = useCallback(() => {
    if (speedUpdateTimerRef.current) return

    speedUpdateTimerRef.current = setInterval(() => {
      if (!isMountedRef.current) return

      const now = Date.now()
      const stats = networkStatsRef.current
      const timeDiff = (now - stats.lastReset) / 1000

      if (timeDiff > 0) {
        const uploadSpeed = stats.bytesUploaded / timeDiff
        const downloadSpeed = stats.bytesDownloaded / timeDiff

        setNetworkStats((prev) => {
          if (
            prev.uploadSpeed === uploadSpeed &&
            prev.downloadSpeed === downloadSpeed &&
            prev.totalUploaded === stats.totalUploaded &&
            prev.totalDownloaded === stats.totalDownloaded
          ) {
            return prev
          }

          return {
            uploadSpeed,
            downloadSpeed,
            totalUploaded: stats.totalUploaded,
            totalDownloaded: stats.totalDownloaded,
          }
        })

        // 在指定间隔后重置计数
        const currentOpts = optsRef.current
        if (timeDiff >= currentOpts.speedResetInterval / 1000) {
          stats.lastReset = now
          stats.bytesUploaded = 0
          stats.bytesDownloaded = 0
        }
      }
    }, optsRef.current.speedUpdateInterval)
  }, [])

  // 把回调存入 ref，避免重复创建 connect 函数
  const callbacksRef = useRef(callbacks)
  const optsRef = useRef(opts)
  callbacksRef.current = callbacks
  optsRef.current = opts

  // 连接 WebSocket
  const connect = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.CONNECTING) {
      return // Already connecting
    }

    cleanupResources()

    const wsUrl = typeof url === 'function' ? url() : url
    const currentOpts = optsRef.current
    if (!wsUrl || !currentOpts.enabled) return

    try {
      setIsConnecting(true)
      setError(null)

      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        if (!isMountedRef.current) return

        console.log('WebSocket connected to:', wsUrl)
        setIsConnected(true)
        setIsConnecting(false)
        setError(null)
        reconnectAttemptsRef.current = 0

        // 重置网络统计
        networkStatsRef.current = {
          lastReset: Date.now(),
          bytesUploaded: 0,
          bytesDownloaded: 0,
          totalUploaded: networkStatsRef.current.totalUploaded,
          totalDownloaded: networkStatsRef.current.totalDownloaded,
        }

        // 启动定时器
        startSpeedUpdateTimer()

        callbacksRef.current.onOpen?.()
      }

      ws.onclose = (event) => {
        if (!isMountedRef.current) return

        console.log('WebSocket disconnected:', event.code, event.reason)
        setIsConnected(false)
        setIsConnecting(false)

        // 清理定时器
        if (speedUpdateTimerRef.current) {
          clearInterval(speedUpdateTimerRef.current)
          speedUpdateTimerRef.current = null
        }

        setNetworkStats((prev) => {
          if (prev.uploadSpeed === 0 && prev.downloadSpeed === 0) return prev
          return {
            ...prev,
            uploadSpeed: 0,
            downloadSpeed: 0,
          }
        })

        callbacksRef.current.onClose?.(event)

        // 处理重连
        const currentOptsForReconnect = optsRef.current
        if (
          currentOptsForReconnect.reconnectOnClose &&
          event.code !== 1000 &&
          reconnectAttemptsRef.current <
            currentOptsForReconnect.maxReconnectAttempts
        ) {
          reconnectAttemptsRef.current++
          reconnectTimerRef.current = setTimeout(() => {
            if (isMountedRef.current) {
              console.log(
                `Reconnecting... (attempt ${reconnectAttemptsRef.current}/${currentOptsForReconnect.maxReconnectAttempts})`
              )
              connect()
            }
          }, currentOptsForReconnect.reconnectInterval)
        }
      }

      ws.onerror = (event) => {
        if (!isMountedRef.current) return

        console.error('WebSocket error:', event)
        const wsError = new Error('WebSocket connection error')
        setError(wsError)
        setIsConnecting(false)
        callbacksRef.current.onError?.(event)
      }

      ws.onmessage = (event) => {
        if (!isMountedRef.current) return

        try {
          // 统计下载字节数
          const dataSize = new Blob([event.data]).size
          updateNetworkStats(dataSize, false)

          // 解析消息
          let message: WebSocketMessage
          try {
            message = JSON.parse(event.data)
          } catch {
            // 如果不是 JSON，按纯文本消息处理
            message = { type: 'data', data: event.data }
          }

          // 处理内部消息类型
          if (message.type === 'pong') {
            return // Ignore pong responses
          }

          callbacksRef.current.onMessage?.(message)
        } catch (err) {
          console.error('Error processing WebSocket message:', err)
        }
      }
    } catch (err) {
      console.error('Failed to create WebSocket:', err)
      setError(
        err instanceof Error ? err : new Error('Failed to create WebSocket')
      )
      setIsConnecting(false)
    }
  }, [url, cleanupResources, startSpeedUpdateTimer, updateNetworkStats])

  // 发送消息
  const send = useCallback(
    (message: WebSocketMessage | string): boolean => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        console.warn('WebSocket is not connected')
        return false
      }

      try {
        const data =
          typeof message === 'string' ? message : JSON.stringify(message)
        wsRef.current.send(data)
        updateNetworkStats(new Blob([data]).size, true)
        return true
      } catch (err) {
        console.error('Failed to send WebSocket message:', err)
        return false
      }
    },
    [updateNetworkStats]
  )

  // 断开连接
  const disconnect = useCallback(() => {
    reconnectAttemptsRef.current = optsRef.current.maxReconnectAttempts // Prevent reconnection
    cleanupResources()
    setIsConnected(false)
    setIsConnecting(false)
  }, [cleanupResources])

  // 手动重连
  const reconnect = useCallback(() => {
    reconnectAttemptsRef.current = 0
    connect()
  }, [connect])

  // 连接生命周期的主 effect
  useEffect(() => {
    isMountedRef.current = true
    let timer: ReturnType<typeof setTimeout> | undefined

    if (optsRef.current.enabled) {
      // 加一点延迟，避免快速反复重连
      timer = setTimeout(() => {
        if (isMountedRef.current && optsRef.current.enabled) {
          connect()
        }
      }, 100)
    }

    return () => {
      if (timer) {
        clearTimeout(timer)
      }
      isMountedRef.current = false
      cleanupResources()
    }
  }, [connect, cleanupResources])

  // 处理 enabled 选项变化的 effect
  useEffect(() => {
    if (opts.enabled && !isConnected && !isConnecting) {
      const timer = setTimeout(() => {
        if (opts.enabled && !isConnected && !isConnecting) {
          connect()
        }
      }, 100)
      return () => clearTimeout(timer)
    } else if (!opts.enabled && (isConnected || isConnecting)) {
      cleanupResources()
      setIsConnected(false)
      setIsConnecting(false)
    }
  }, [opts.enabled, isConnected, isConnecting, connect, cleanupResources])

  // 返回状态与操作
  return [
    {
      isConnected,
      isConnecting,
      error,
      networkStats,
    },
    {
      send,
      disconnect,
      reconnect,
    },
  ]
}

export default useWebSocket
