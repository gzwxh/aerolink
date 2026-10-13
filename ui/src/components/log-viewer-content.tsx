import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { OnMount } from '@monaco-editor/react'
import {
  IconClearAll,
  IconDownload,
  IconHighlight,
  IconMaximize,
  IconMinimize,
  IconPalette,
  IconSearch,
  IconSettings,
  IconX,
} from '@tabler/icons-react'
import { Container, EphemeralContainer, Pod } from 'kubernetes-types/core/v1'
import type { editor } from 'monaco-editor'
import { useTranslation } from 'react-i18next'

import { TERMINAL_THEMES, TerminalTheme } from '@/types/themes'
import {
  AnsiState,
  generateAnsiCss,
  getAnsiClassNames,
  parseAnsi,
} from '@/lib/ansi-parser'
import { useLogsWebSocket } from '@/lib/api'
import { toSimpleContainer } from '@/lib/k8s'
import {
  findTermRanges,
  normalizeLineTextForSearch,
  normalizeSearchTerm,
} from '@/lib/log-search'
import { MonacoEditor } from '@/lib/monaco-loader'
import { defineMonacoLogThemes } from '@/lib/monaco-theme'
import { suppressMonacoFindWidgetHovers } from '@/lib/suppress-monaco-find-widget-hovers'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'

import { ConnectionIndicator } from './connection-indicator'
import { NetworkSpeedIndicator } from './network-speed-indicator'
import { ContainerSelector } from './selector/container-selector'
import { PodSelector } from './selector/pod-selector'

export interface LogViewerProps {
  namespace: string
  podName?: string
  pods?: Pod[]
  labelSelector?: string
  containers?: Container[]
  initContainers?: Container[]
  ephemeralContainers?: EphemeralContainer[]
  selectedContainerName?: string
  onClose?: () => void
}

const ANSI_CSS = generateAnsiCss()
// 过滤命中行的视觉标记：左侧标记条 + 半透明底，用语义 token 的透明度修饰，
// 在各终端主题的深浅背景上都可辨认。
// 高亮配色：命中行与关键字共用一个颜色（可在设置里改，存 localStorage）。
// 行级用低透明度打底 + 左侧标记条，词级用高透明度让关键字一眼可见；
// 默认 amber 在深浅两套日志主题下都能和背景拉开对比。
const DEFAULT_HIGHLIGHT_COLOR = '#f59e0b'
function buildHighlightCss(color: string) {
  return `
.log-filter-match-line {
  background: color-mix(in oklab, ${color} 26%, transparent);
  box-shadow: inset 2px 0 0 ${color};
}
.log-highlight-term {
  background: color-mix(in oklab, ${color} 60%, transparent);
  border-radius: 2px;
}
`
}
// 过滤命中行保留的上下文行数（前后各 N 行）。默认 0 = 纯 grep 模式，
// 只显示命中行本身（tail -f | grep 的效果），不带上下文；
// 可在设置面板调整，存 localStorage（log-viewer-filter-context-lines）。
const DEFAULT_FILTER_CONTEXT_LINES = 0
const FILTER_CONTEXT_OPTIONS = [0, 1, 3, 5, 10, 15]
// 同一批到达的日志合并成一次过滤重建的延迟，避免高频日志下反复全量重绘。
const FILTER_RENDER_DELAY_MS = 120
// Monaco 的 NeverGrowsWhenTypingAtEdges 取值，保持为数字以避免在运行时引入 Monaco。
const NEVER_GROWS_WHEN_TYPING_AT_EDGES: editor.TrackedRangeStickiness = 1

// 一行日志：剥离转义后的纯文本 + 行内各段的 ANSI 样式段。
// 过滤视图以行缓冲为数据源整体重建，流式追加只服务无过滤的实时路径。
interface FilterableLogLine {
  text: string
  segments: Array<{ text: string; styles: AnsiState }>
}

// 把一条日志的 ANSI 段按换行拆成行（段跨行时两侧各留一份样式），
// 同时预计算每行剥离样式后的纯文本供匹配判断使用。
function splitSegmentsIntoLines(
  segments: Array<{ text: string; styles: AnsiState }>
): FilterableLogLine[] {
  const rawLines: Array<Array<{ text: string; styles: AnsiState }>> = [[]]
  for (const segment of segments) {
    const parts = segment.text.split('\n')
    parts.forEach((part, index) => {
      if (index > 0) {
        rawLines.push([])
      }
      if (part.length > 0) {
        rawLines[rawLines.length - 1].push({ text: part, styles: segment.styles })
      }
    })
  }
  return rawLines.map((lineSegments) => ({
    text: lineSegments.map((segment) => segment.text).join(''),
    segments: lineSegments,
  }))
}
const TERMINAL_THEME_KEYS = Object.keys(TERMINAL_THEMES) as TerminalTheme[]
const TERMINAL_THEME_ENTRIES = Object.entries(TERMINAL_THEMES) as Array<
  [TerminalTheme, (typeof TERMINAL_THEMES)[TerminalTheme]]
>

export function LogViewer({
  namespace,
  podName,
  pods,
  containers: _containers,
  initContainers,
  ephemeralContainers,
  selectedContainerName,
  onClose,
  labelSelector,
}: LogViewerProps) {
  const [logTheme, setLogTheme] = useState<TerminalTheme>(() => {
    const saved = localStorage.getItem('log-viewer-theme')
    return (saved as TerminalTheme) || 'classic'
  })
  const containers = useMemo(() => {
    return toSimpleContainer(initContainers, _containers, ephemeralContainers)
  }, [_containers, initContainers, ephemeralContainers])
  const [selectedContainer, setSelectedContainer] = useState<
    string | undefined
  >(containers.length > 0 ? containers[0].name : '')
  const selectedContainerIsEphemeral = containers.some(
    (container) => container.name === selectedContainer && container.ephemeral
  )
  const [tailLines, setTailLines] = useState(() => {
    const saved = localStorage.getItem('log-viewer-tail-lines')
    return saved ? parseInt(saved, 10) : 100
  })
  // 过滤命中行保留的上下文行数（0 = 只显示命中行）
  const [filterContextLines, setFilterContextLines] = useState(() => {
    const saved = localStorage.getItem('log-viewer-filter-context-lines')
    return saved !== null
      ? parseInt(saved, 10)
      : DEFAULT_FILTER_CONTEXT_LINES
  })
  const { t } = useTranslation()
  const [timestamps, setTimestamps] = useState(false)
  const [previous, setPrevious] = useState(false)
  const [filterTerm, setFilterTerm] = useState('')
  const [highlightTerm, setHighlightTerm] = useState('')
  const [highlightColor, setHighlightColor] = useState(() => {
    const saved = localStorage.getItem('log-viewer-highlight-color')
    return saved || DEFAULT_HIGHLIGHT_COLOR
  })
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const [isReconnecting, setIsReconnecting] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [wordWrap, setWordWrap] = useState<boolean>(() => {
    const saved = localStorage.getItem('log-viewer-word-wrap')
    if (saved === null) {
      localStorage.setItem('log-viewer-word-wrap', 'true')
      return true
    }
    return saved === 'true'
  })

  const [showLineNumbers, setShowLineNumbers] = useState<boolean>(() => {
    const saved = localStorage.getItem('log-viewer-show-line-numbers')
    if (saved === null) {
      return false
    }
    return saved === 'true'
  })

  const [fontSize, setFontSize] = useState(() => {
    const saved = localStorage.getItem('log-viewer-font-size')
    return saved ? parseInt(saved, 10) : 14
  })
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const [logCount, setLogCount] = useState(0) // Track log count for re-rendering
  const ansiStateRef = useRef<AnsiState>({})
  const decorationIdsRef = useRef<string[]>([])
  const highlightIdsRef = useRef<string[]>([])
  const normalizedFilterTermRef = useRef('')
  const normalizedHighlightTermRef = useRef('')
  const pendingLogsRef = useRef<string[]>([])
  // 全量日志行缓冲：过滤视图从这里整体重建。
  const logLinesRef = useRef<FilterableLogLine[]>([])
  // 无过滤流式路径的写入条数；清空过滤词还原全量视图时用它恢复计数。
  const streamLogCountRef = useRef(0)
  // 当前编辑器显示的是过滤重建视图还是全量流式视图。
  const isFilterViewRef = useRef(false)
  const filterRenderTimerRef = useRef<number | null>(null)
  const scheduleFilterRenderRef = useRef<() => void>(() => {})
  const suppressFindWidgetHoversRef = useRef<(() => void) | null>(null)

  // 关键字高亮：对当前模型的全部行扫描命中片段并替换装饰。调用点只有
  // 「高亮词变化」「过滤视图重建后」两处，流式追加走 writeLogToEditor 的增量路径。
  const applyHighlightDecorations = useCallback(() => {
    const model = editorRef.current?.getModel()
    if (!model) {
      return
    }
    const term = normalizedHighlightTermRef.current
    const highlightDecorations: editor.IModelDeltaDecoration[] = []
    if (term) {
      for (let lineNumber = 1; lineNumber <= model.getLineCount(); lineNumber++) {
        for (const range of findTermRanges(
          model.getLineContent(lineNumber),
          term
        )) {
          highlightDecorations.push({
            range: {
              startLineNumber: lineNumber,
              startColumn: range.start + 1,
              endLineNumber: lineNumber,
              endColumn: range.end + 1,
            },
            options: {
              inlineClassName: 'log-highlight-term',
              stickiness: NEVER_GROWS_WHEN_TYPING_AT_EDGES,
            },
          })
        }
      }
    }
    highlightIdsRef.current = model.deltaDecorations(
      highlightIdsRef.current,
      highlightDecorations
    )
  }, [])

  // 过滤视图（重）渲染：以 logLinesRef 为唯一数据源整体重建编辑器内容与
  // ANSI 装饰。有过滤词时只显示匹配行（grep 风格，行数即命中数）；
  // 无过滤词时重建全量（用于清空过滤后还原流式视图的内容）。
  const renderLogView = useCallback(() => {
    const model = editorRef.current?.getModel()
    if (!model) {
      return
    }

    const term = normalizedFilterTermRef.current
    const allLines = logLinesRef.current

    const matchSet = new Set<number>()
    if (term) {
      allLines.forEach((line, index) => {
        if (normalizeLineTextForSearch(line.text).includes(term)) {
          matchSet.add(index)
        }
      })
    }

    const visibleIndexes: number[] = []
    if (term) {
      const shown = new Set<number>()
      for (const index of matchSet) {
        const from = Math.max(0, index - filterContextLines)
        const to = Math.min(allLines.length - 1, index + filterContextLines)
        for (let i = from; i <= to; i++) {
          if (!shown.has(i)) {
            shown.add(i)
            visibleIndexes.push(i)
          }
        }
      }
      visibleIndexes.sort((a, b) => a - b)
    } else {
      for (let i = 0; i < allLines.length; i++) {
        visibleIndexes.push(i)
      }
    }

    const renderedLines = visibleIndexes.map((index) => allLines[index])
    const decorations: editor.IModelDeltaDecoration[] = []
    renderedLines.forEach((line, renderIndex) => {
      const lineNumber = renderIndex + 1
      let column = 1
      for (const segment of line.segments) {
        if (segment.text.length === 0) {
          continue
        }
        const className = getAnsiClassNames(segment.styles)
        if (className) {
          decorations.push({
            range: {
              startLineNumber: lineNumber,
              startColumn: column,
              endLineNumber: lineNumber,
              endColumn: column + segment.text.length,
            },
            options: {
              inlineClassName: className,
              stickiness: NEVER_GROWS_WHEN_TYPING_AT_EDGES,
            },
          })
        }
        column += segment.text.length
      }
      if (matchSet.has(visibleIndexes[renderIndex])) {
        decorations.push({
          range: {
            startLineNumber: lineNumber,
            startColumn: 1,
            endLineNumber: lineNumber,
            endColumn: 1,
          },
          options: {
            className: 'log-filter-match-line',
            stickiness: NEVER_GROWS_WHEN_TYPING_AT_EDGES,
          },
        })
      }
    })

    model.setValue(renderedLines.map((line) => line.text).join('\n'))
    decorationIdsRef.current = model.deltaDecorations(
      decorationIdsRef.current,
      decorations
    )
    // setValue 会丢弃全部装饰，装饰 id 跟踪随之作废；关键字高亮在重建后统一补齐。
    highlightIdsRef.current = []
    applyHighlightDecorations()

    // 过滤视图显示命中行数；还原全量时恢复流式累计的条数。
    setLogCount(term ? matchSet.size : streamLogCountRef.current)
  }, [applyHighlightDecorations, filterContextLines])

  // 同一批到达的多条日志只触发一次重建。
  const scheduleFilterRender = useCallback(() => {
    if (filterRenderTimerRef.current !== null) {
      return
    }
    filterRenderTimerRef.current = window.setTimeout(() => {
      filterRenderTimerRef.current = null
      renderLogView()
    }, FILTER_RENDER_DELAY_MS)
  }, [renderLogView])
  scheduleFilterRenderRef.current = scheduleFilterRender
  const sortedPods = useMemo(() => {
    if (!pods) {
      return undefined
    }

    return [...pods].sort((a, b) =>
      (a.metadata?.creationTimestamp || 0) >
      (b.metadata?.creationTimestamp || 0)
        ? -1
        : 1
    )
  }, [pods])
  const currentTheme = TERMINAL_THEMES[logTheme]

  const [selectPodName, setSelectPodName] = useState<string | undefined>(
    podName || pods?.[0]?.metadata?.name || undefined
  )

  useEffect(() => {
    normalizedFilterTermRef.current = normalizeSearchTerm(
      filterTerm
    ).toLocaleLowerCase()
    if (normalizedFilterTermRef.current) {
      isFilterViewRef.current = true
      scheduleFilterRenderRef.current()
    } else if (isFilterViewRef.current) {
      // 清空过滤词：还原全量视图
      isFilterViewRef.current = false
      renderLogView()
    }
  }, [filterTerm, renderLogView])

  useEffect(() => {
    normalizedHighlightTermRef.current = normalizeSearchTerm(
      highlightTerm
    ).toLocaleLowerCase()
    applyHighlightDecorations()
  }, [highlightTerm, applyHighlightDecorations])

  useEffect(() => {
    if (podName) {
      if (selectPodName !== podName) {
        setSelectPodName(podName)
      }
      return
    }
    if (pods && pods.length > 0) {
      if (
        selectPodName !== '_all' &&
        (!selectPodName ||
          !pods.find((p) => p.metadata?.name === selectPodName))
      ) {
        setSelectPodName(pods[0].metadata?.name)
      }
    }
  }, [podName, pods, selectPodName])

  useEffect(() => {
    if (containers.length === 0) {
      setSelectedContainer('')
      return
    }

    setSelectedContainer((current) => {
      if (
        selectedContainerName &&
        containers.some((container) => container.name === selectedContainerName)
      ) {
        return selectedContainerName
      }
      if (
        !current ||
        !containers.some((container) => container.name === current)
      ) {
        return containers[0].name
      }
      return current
    })
  }, [containers, selectedContainerName])

  // 处理主题变更并持久化到 localStorage
  const handleThemeChange = useCallback((theme: TerminalTheme) => {
    setLogTheme(theme)
    localStorage.setItem('log-viewer-theme', theme)
  }, [])

  // 处理字号变更并持久化到 localStorage
  const handleFontSizeChange = useCallback((size: number) => {
    setFontSize(size)
    localStorage.setItem('log-viewer-font-size', size.toString())
  }, [])

  // 处理高亮颜色变更并持久化到 localStorage
  const handleHighlightColorChange = useCallback((color: string) => {
    setHighlightColor(color)
    localStorage.setItem('log-viewer-highlight-color', color)
  }, [])

  // 处理 tail 行数变更并持久化到 localStorage
  const handleTailLinesChange = useCallback((lines: number) => {
    setTailLines(lines)
    if (lines !== -1) {
      localStorage.setItem('log-viewer-tail-lines', lines.toString())
    }
  }, [])

  // 处理过滤上下文行数变更并持久化到 localStorage
  const handleFilterContextLinesChange = useCallback((lines: number) => {
    setFilterContextLines(lines)
    localStorage.setItem('log-viewer-filter-context-lines', lines.toString())
  }, [])

  // 快速循环切换主题的函数
  const cycleTheme = useCallback(() => {
    const currentIndex = TERMINAL_THEME_KEYS.indexOf(logTheme)
    const nextIndex = (currentIndex + 1) % TERMINAL_THEME_KEYS.length
    handleThemeChange(TERMINAL_THEME_KEYS[nextIndex])
  }, [logTheme, handleThemeChange])

  const writeLogToEditor = useCallback((log: string) => {
    if (!editorRef.current) {
      pendingLogsRef.current.push(log)
      return
    }

    const model = editorRef.current.getModel()
    if (!model) {
      pendingLogsRef.current.push(log)
      return
    }

    const { segments, finalState } = parseAnsi(log, ansiStateRef.current)
    ansiStateRef.current = finalState

    // 所有行都先进缓冲（含被过滤掉的），过滤视图以它为数据源整体重建。
    const lines = splitSegmentsIntoLines(segments)
    logLinesRef.current.push(...lines)

    const term = normalizedFilterTermRef.current
    if (term) {
      // 过滤开启时不逐条写入编辑器：命中行触发一次合并重建，由重建逻辑
      // 统一补齐前后上下文。
      if (
        lines.some((line) =>
          normalizeLineTextForSearch(line.text).includes(term)
        )
      ) {
        scheduleFilterRenderRef.current()
      }
      return
    }

    const plainText = segments.map((s) => s.text).join('')

    const lineCount = model.getLineCount()
    const lineMaxColumn = model.getLineMaxColumn(lineCount)
    const prefix = model.getValueLength() === 0 ? '' : '\n'

    const textToInsert = `${prefix}${plainText}`
    model.applyEdits([
      {
        range: {
          startColumn: lineMaxColumn,
          endColumn: lineMaxColumn,
          startLineNumber: lineCount,
          endLineNumber: lineCount,
        },
        text: textToInsert,
        forceMoveMarkers: false,
      },
    ])

    const newDecorations: editor.IModelDeltaDecoration[] = []

    // 装饰的起始位置
    let currentLine = lineCount
    let currentColumn = lineMaxColumn

    if (prefix === '\n') {
      currentLine++
      currentColumn = 1
    }

    segments.forEach((segment) => {
      const lines = segment.text.split('\n')
      const endLine = currentLine + lines.length - 1
      const endColumn =
        lines.length === 1
          ? currentColumn + lines[0].length
          : lines[lines.length - 1].length + 1

      const className = getAnsiClassNames(segment.styles)
      if (className) {
        newDecorations.push({
          range: {
            startLineNumber: currentLine,
            startColumn: currentColumn,
            endLineNumber: endLine,
            endColumn: endColumn,
          },
          options: {
            inlineClassName: className,
            stickiness: NEVER_GROWS_WHEN_TYPING_AT_EDGES,
          },
        })
      }

      currentLine = endLine
      currentColumn = endColumn
    })

    if (newDecorations.length > 0) {
      const newIds = model.deltaDecorations([], newDecorations)
      decorationIdsRef.current.push(...newIds)
    }

    // 关键字高亮：流式路径只扫描本次插入的行，避免每条日志都全量重扫。
    // 插入文本与 lines 一一对应：prefix 换行后内容从 lineCount+1 行起，
    // 模型为空（prefix 为空串）时从第 1 行起。
    const highlightTermLower = normalizedHighlightTermRef.current
    if (highlightTermLower) {
      const firstLineNumber = prefix === '\n' ? lineCount + 1 : lineCount
      const highlightDecorations: editor.IModelDeltaDecoration[] = []
      lines.forEach((line, index) => {
        for (const range of findTermRanges(line.text, highlightTermLower)) {
          highlightDecorations.push({
            range: {
              startLineNumber: firstLineNumber + index,
              startColumn: range.start + 1,
              endLineNumber: firstLineNumber + index,
              endColumn: range.end + 1,
            },
            options: {
              inlineClassName: 'log-highlight-term',
              stickiness: NEVER_GROWS_WHEN_TYPING_AT_EDGES,
            },
          })
        }
      })
      if (highlightDecorations.length > 0) {
        highlightIdsRef.current.push(
          ...model.deltaDecorations([], highlightDecorations)
        )
      }
    }

    const visibleRange = editorRef.current.getVisibleRanges()[0]
    if (visibleRange?.endLineNumber + 2 >= lineCount) {
      editorRef.current.revealLine(model.getLineCount())
      setShowScrollToBottom(false)
    } else {
      setShowScrollToBottom(true)
    }

    streamLogCountRef.current += 1
    setLogCount(streamLogCountRef.current)
  }, [])

  // 处理编辑器挂载
  const handleEditorMount: OnMount = useCallback(
    (editor) => {
      editorRef.current = editor

      // 配置搜索组件
      editor.updateOptions({
        find: {
          addExtraSpaceOnTop: false,
          autoFindInSelection: 'never',
          seedSearchStringFromSelection: 'never',
        },
      })

      suppressFindWidgetHoversRef.current?.()
      suppressFindWidgetHoversRef.current = suppressMonacoFindWidgetHovers(
        editor.getContainerDomNode()
      )

      const pendingLogs = pendingLogsRef.current
      pendingLogsRef.current = []
      pendingLogs.forEach((log) => writeLogToEditor(log))
    },
    [writeLogToEditor]
  )

  const appendLog = useCallback(
    (log: string) => {
      writeLogToEditor(log)
    },
    [writeLogToEditor]
  )

  const cleanLog = useCallback(() => {
    setLogCount(0)
    streamLogCountRef.current = 0
    ansiStateRef.current = {}
    decorationIdsRef.current = []
    pendingLogsRef.current = []
    logLinesRef.current = []
    if (filterRenderTimerRef.current !== null) {
      clearTimeout(filterRenderTimerRef.current)
      filterRenderTimerRef.current = null
    }
    if (editorRef.current) {
      const model = editorRef.current.getModel()
      if (model) {
        model.setValue('')
      }
    }
  }, [])

  const logsOptions = useMemo(
    () => ({
      container: selectedContainer,
      tailLines,
      timestamps,
      previous: previous && !selectedContainerIsEphemeral,
      enabled: !!selectPodName,
      labelSelector,
      onNewLog: appendLog,
      onClear: cleanLog,
    }),
    [
      selectedContainer,
      tailLines,
      timestamps,
      previous,
      selectedContainerIsEphemeral,
      selectPodName,
      labelSelector,
      appendLog,
      cleanLog,
    ]
  )

  // 使用新的 WebSocket 日志 hook
  const {
    isLoading,
    isConnected,
    downloadSpeed,
    refetch,
    stopStreaming,
    clearLogs,
  } = useLogsWebSocket(namespace, selectPodName || '', logsOptions)

  const stopStreamingRef = useRef<() => void>(stopStreaming)
  stopStreamingRef.current = stopStreaming

  // 组件卸载时清理 WebSocket 连接
  useEffect(() => {
    return () => {
      if (stopStreamingRef.current) {
        stopStreamingRef.current()
      }
      if (filterRenderTimerRef.current !== null) {
        clearTimeout(filterRenderTimerRef.current)
      }
      suppressFindWidgetHoversRef.current?.()
    }
  }, [])

  // 关键参数变化时停止上一条流
  useEffect(() => {
    // 在新流开始之前清空编辑器。这里有意
    // 在真实的参数变化时清空，而不是在每次
    // WebSocket onopen 时清空，这样服务端在连接后
    // 立即下发的历史 tail 缓冲才能被保留。
    cleanLog()

    // 参数变化时显示重连状态
    setIsReconnecting(true)
  }, [
    selectedContainer,
    selectPodName,
    tailLines,
    timestamps,
    previous,
    cleanLog,
  ])

  // 加载完成后隐藏重连状态
  useEffect(() => {
    if (!isLoading) {
      const timer = setTimeout(() => setIsReconnecting(false), 200)
      return () => clearTimeout(timer)
    }
  }, [isLoading])

  const downloadLogs = () => {
    const model = editorRef?.current?.getModel()
    if (model) {
      const content = model.getValue()
      const blob = new Blob([content], { type: 'text/plain' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const podFileName = selectPodName || 'all-pods'
      a.download = `${podFileName}-${selectedContainer || 'pod'}-logs.txt`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    }
  }

  const scrollToBottom = useCallback(() => {
    if (editorRef.current) {
      const model = editorRef.current.getModel()
      if (model) {
        editorRef.current.revealLine(model.getLineCount())
        setShowScrollToBottom(false)
      }
    }
  }, [])

  // 处理全屏切换
  const toggleFullscreen = useCallback(() => {
    setIsFullscreen((prev) => !prev)
  }, [])

  const toggleWordWrap = useCallback(() => {
    setWordWrap((prev) => {
      localStorage.setItem('log-viewer-word-wrap', `${!prev}`)
      return !prev
    })
  }, [])

  const toggleShowLineNumbers = useCallback(() => {
    setShowLineNumbers((prev) => {
      localStorage.setItem('log-viewer-show-line-numbers', `${!prev}`)
      return !prev
    })
  }, [])

  // 处理快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl/Cmd + F 打开 Monaco 搜索
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        editorRef.current?.getAction('actions.find')?.run()
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        toggleFullscreen()
      }
      // Alt/Option + Z 切换自动换行
      if (e.altKey && (e.key === 'z' || e.key === 'Z' || e.key === 'Ω')) {
        e.preventDefault()
        toggleWordWrap()
      }
      // 字号快捷键
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        handleFontSizeChange(Math.min(24, fontSize + 1))
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === '-' || e.key === '_')) {
        e.preventDefault()
        handleFontSizeChange(Math.max(10, fontSize - 1))
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault()
        handleFontSizeChange(14) // Reset to default font size
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [toggleFullscreen, fontSize, handleFontSizeChange, toggleWordWrap])

  return (
    <Card
      className={`h-full min-h-0 flex flex-col py-4 gap-0 ${isFullscreen ? 'fixed inset-0 z-50 m-0 rounded-none' : ''} ${wordWrap ? 'whitespace-pre-wrap' : 'whitespace-pre'} `}
    >
      <style>{ANSI_CSS + buildHighlightCss(highlightColor)}</style>
      <CardHeader>
        <div className="flex min-w-0 flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-2">
            <CardTitle className="text-lg">{t('logViewer.title')}</CardTitle>
            <CardDescription>
              <div className="flex items-center gap-4 text-sm text-muted-foreground">
                <span>
                  {t('logViewer.lineCount', { count: logCount })}{' '}
                  {filterTerm.length > 0 && t('logViewer.filtered')}
                </span>
                <ConnectionIndicator
                  isConnected={isConnected}
                  onReconnect={refetch}
                />
                <NetworkSpeedIndicator
                  downloadSpeed={downloadSpeed}
                  uploadSpeed={0}
                />
                {isLoading && <span>{t('common.messages.loading')}</span>}
                {isReconnecting && (
                  <span className="text-info">
                    {t('logViewer.reconnecting')}
                  </span>
                )}
              </div>
            </CardDescription>
          </div>
          <div className="flex w-full min-w-0 flex-wrap items-center gap-2 md:w-auto md:justify-end">
            <div className="relative min-w-0 flex-1 basis-40 md:w-48 md:flex-none md:basis-auto">
              <IconSearch className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={t('logViewer.filterPlaceholder')}
                value={filterTerm}
                onChange={(e) => setFilterTerm(e.target.value)}
                className="pl-8 w-full pr-8"
              />
            </div>
            <div className="relative min-w-0 flex-1 basis-40 md:w-48 md:flex-none md:basis-auto">
              <IconHighlight className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={t('logViewer.highlightPlaceholder')}
                value={highlightTerm}
                onChange={(e) => setHighlightTerm(e.target.value)}
                className="pl-8 w-full pr-8"
              />
            </div>

            {/* Container Selector */}
            {containers.length > 1 && (
              <ContainerSelector
                containers={containers}
                showAllOption={false}
                selectedContainer={selectedContainer}
                onContainerChange={setSelectedContainer}
              />
            )}

            {/* Pod Selector */}
            {sortedPods && (
              <PodSelector
                pods={sortedPods}
                showAllOption={true}
                selectedPod={selectPodName}
                onPodChange={(v) => setSelectPodName(v || '_all')}
              />
            )}

            {/* Quick Theme Toggle */}
            <Button
              variant="outline"
              size="sm"
              onClick={cycleTheme}
              title={`Current theme: ${currentTheme.name}`}
              className="relative"
            >
              <IconPalette className="h-4 w-4" />
              <div
                className="absolute -top-1 -right-1 w-3 h-3 rounded-full border border-border"
                style={{
                  backgroundColor: currentTheme.background,
                }}
              ></div>
            </Button>

            {/* Settings */}
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm">
                  <IconSettings className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-80" align="end">
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="tail-lines">
                      {t('logViewer.tailLines')}
                    </Label>
                    <Select
                      value={tailLines.toString()}
                      onValueChange={(value) =>
                        handleTailLinesChange(Number(value))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="50">50</SelectItem>
                        <SelectItem value="100">100</SelectItem>
                        <SelectItem value="200">200</SelectItem>
                        <SelectItem value="500">500</SelectItem>
                        <SelectItem value="1000">1000</SelectItem>
                        <SelectItem value="-1">
                          {t('logViewer.allLines')}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex items-center justify-between">
                    <Label htmlFor="timestamps">
                      {t('logViewer.showTimestamps')}
                    </Label>
                    <Switch
                      id="timestamps"
                      checked={timestamps}
                      onCheckedChange={setTimestamps}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <Label htmlFor="previous">
                      {t('logViewer.previousContainer')}
                    </Label>
                    <Switch
                      id="previous"
                      checked={previous && !selectedContainerIsEphemeral}
                      disabled={selectedContainerIsEphemeral}
                      onCheckedChange={setPrevious}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <Label htmlFor="word-wrap">{t('logViewer.wordWrap')}</Label>
                    <Switch
                      id="word-wrap"
                      checked={wordWrap}
                      onCheckedChange={toggleWordWrap}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <Label htmlFor="show-line-numbers">
                      {t('logViewer.showLineNumbers')}
                    </Label>
                    <Switch
                      id="show-line-numbers"
                      checked={showLineNumbers}
                      onCheckedChange={toggleShowLineNumbers}
                    />
                  </div>

                  {/* Log Theme Selector */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="log-theme">
                        {t('logViewer.logTheme')}
                      </Label>
                      <Select
                        value={logTheme}
                        onValueChange={handleThemeChange}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {TERMINAL_THEME_ENTRIES.map(([key, theme]) => (
                            <SelectItem key={key} value={key}>
                              <div className="flex items-center gap-2">
                                {theme.name}
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* Highlight Color Picker */}
                  <div className="flex items-center justify-between">
                    <Label htmlFor="highlight-color">
                      {t('logViewer.highlightColor')}
                    </Label>
                    <div className="flex items-center gap-2">
                      <input
                        id="highlight-color"
                        type="color"
                        value={highlightColor}
                        onChange={(e) =>
                          handleHighlightColorChange(e.target.value)
                        }
                        className="h-8 w-12 cursor-pointer rounded-md border border-input bg-transparent p-0.5"
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          handleHighlightColorChange(DEFAULT_HIGHLIGHT_COLOR)
                        }
                      >
                        {t('logViewer.resetHighlightColor')}
                      </Button>
                    </div>
                  </div>

                  {/* Filter Context Lines Selector */}
                  <div className="flex items-center justify-between">
                    <Label htmlFor="filter-context-lines">
                      {t('logViewer.filterContextLines')}
                    </Label>
                    <Select
                      value={filterContextLines.toString()}
                      onValueChange={(value) =>
                        handleFilterContextLinesChange(Number(value))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="0">
                          {t('logViewer.filterContextMatchesOnly')}
                        </SelectItem>
                        {FILTER_CONTEXT_OPTIONS.filter((n) => n > 0).map(
                          (n) => (
                            <SelectItem key={n} value={n.toString()}>
                              {t('logViewer.filterContextNLines', { n })}
                            </SelectItem>
                          )
                        )}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Font Size Selector */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="font-size">
                        {t('logViewer.fontSize')}
                      </Label>
                      <Select
                        value={fontSize.toString()}
                        onValueChange={(value) =>
                          handleFontSizeChange(Number(value))
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="10">10px</SelectItem>
                          <SelectItem value="11">11px</SelectItem>
                          <SelectItem value="12">12px</SelectItem>
                          <SelectItem value="13">13px</SelectItem>
                          <SelectItem value="14">14px</SelectItem>
                          <SelectItem value="15">15px</SelectItem>
                          <SelectItem value="16">16px</SelectItem>
                          <SelectItem value="18">18px</SelectItem>
                          <SelectItem value="20">20px</SelectItem>
                          <SelectItem value="22">22px</SelectItem>
                          <SelectItem value="24">24px</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* Keyboard Shortcuts */}
                  <div className="space-y-2 pt-2 border-t">
                    <Label className="text-xs font-medium text-muted-foreground">
                      {t('logViewer.keyboardShortcuts')}
                    </Label>
                    <div className="space-y-1 text-xs text-muted-foreground">
                      <div className="flex justify-between">
                        <span>{t('logViewer.shortcuts.openSearch')}</span>
                        <kbd className="px-1 py-0.5 bg-muted rounded text-xs">
                          Ctrl+F
                        </kbd>
                      </div>
                      <div className="flex justify-between">
                        <span>{t('logViewer.shortcuts.toggleFullscreen')}</span>
                        <kbd className="px-1 py-0.5 bg-muted rounded text-xs">
                          Ctrl+Enter
                        </kbd>
                      </div>
                      <div className="flex justify-between">
                        <span>{t('logViewer.shortcuts.toggleWordWrap')}</span>
                        <kbd className="px-1 py-0.5 bg-muted rounded text-xs">
                          Alt+Z
                        </kbd>
                      </div>
                      <div className="flex justify-between">
                        <span>{t('logViewer.shortcuts.increaseFontSize')}</span>
                        <kbd className="px-1 py-0.5 bg-muted rounded text-xs">
                          Ctrl++
                        </kbd>
                      </div>
                      <div className="flex justify-between">
                        <span>{t('logViewer.shortcuts.decreaseFontSize')}</span>
                        <kbd className="px-1 py-0.5 bg-muted rounded text-xs">
                          Ctrl+-
                        </kbd>
                      </div>
                      <div className="flex justify-between">
                        <span>{t('logViewer.shortcuts.resetFontSize')}</span>
                        <kbd className="px-1 py-0.5 bg-muted rounded text-xs">
                          Ctrl+0
                        </kbd>
                      </div>
                    </div>
                  </div>
                </div>
              </PopoverContent>
            </Popover>

            {/* Clear Logs */}
            <Button
              variant="outline"
              size="sm"
              onClick={clearLogs}
              title={t('logViewer.clearLogs')}
            >
              <IconClearAll className="h-4 w-4" />
            </Button>

            {/* Download */}
            <Button
              variant="outline"
              size="sm"
              onClick={downloadLogs}
              disabled={logCount === 0}
            >
              <IconDownload className="h-4 w-4" />
            </Button>

            {/* Fullscreen Toggle */}
            <Button
              variant="outline"
              size="sm"
              onClick={toggleFullscreen}
              title={
                isFullscreen
                  ? t('logViewer.exitFullscreen')
                  : t('logViewer.enterFullscreen')
              }
            >
              {isFullscreen ? (
                <IconMinimize className="h-4 w-4" />
              ) : (
                <IconMaximize className="h-4 w-4" />
              )}
            </Button>

            {/* Close */}
            {onClose && (
              <Button variant="outline" size="sm" onClick={onClose}>
                <IconX className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="min-h-0 flex-1 p-0 relative">
        <MonacoEditor
          height="100%"
          theme={`log-theme-${logTheme}`}
          loading={
            <div className="flex h-full items-center justify-center">
              <div className="text-center opacity-60">
                {t('common.messages.loadingEditor')}
              </div>
            </div>
          }
          beforeMount={(monaco) => {
            defineMonacoLogThemes(monaco)
          }}
          onMount={handleEditorMount}
          options={{
            readOnly: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize,
            wordWrap: wordWrap ? 'on' : 'off',
            lineHeight: 1.7,
            insertSpaces: true,
            fontFamily:
              "'Maple Mono',Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace",
            lineNumbers: showLineNumbers ? 'on' : 'off',
            glyphMargin: false,
            folding: false,
            renderLineHighlight: 'gutter',
            scrollbar: {
              vertical: 'visible',
              horizontal: 'visible',
              useShadows: false,
              verticalScrollbarSize: 10,
              horizontalScrollbarSize: 10,
            },
            overviewRulerLanes: 0,
            hideCursorInOverviewRuler: true,
            overviewRulerBorder: false,
            automaticLayout: true,
            colorDecorators: false,
          }}
        />
        {showScrollToBottom && (
          <div
            className={`absolute bottom-4 right-4 shadow-lg z-10  ml-auto w-fit animate-in fade-in-0 slide-in-from-bottom-2 duration-300 ${
              logTheme === 'github'
                ? 'bg-white/90 text-gray-600 border border-gray-200 shadow-sm'
                : 'bg-gray-800/90 text-gray-300 border border-gray-600 shadow-sm'
            } px-3 py-1.5 text-xs rounded-full backdrop-blur-sm`}
          >
            <Button
              size="sm"
              variant="ghost"
              className={`h-auto p-0 text-xs font-normal ${
                logTheme === 'github'
                  ? 'text-gray-600 hover:text-gray-800 hover:bg-gray-100/70'
                  : 'text-gray-300 hover:text-white hover:bg-gray-700/70'
              }`}
              onClick={scrollToBottom}
            >
              ↓ {t('common.actions.jumpToBottom', 'Jump to bottom')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
