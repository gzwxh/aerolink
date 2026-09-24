import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { MetricsData } from '@/types/api'
import { formatMemory } from '@/lib/utils'

import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

/** 支持的指标：CPU、内存、Pod 数。三者统一为「用量 / 上限 + 百分比 + 进度条」。 */
type MetricType = 'cpu' | 'memory' | 'pods'

/** 毫核 → 「0.2 核」这种习惯写法（整数不留小数）。 */
function formatCores(milli: number): string {
  const cores = milli / 1000
  return `${Number.isInteger(cores) ? cores : cores.toFixed(1)} 核`
}

/** 去掉数值尾部的单位（英文单位或中文「核」），用于「同单位时只写一次」的紧凑显示。 */
function stripUnit(text: string): string {
  return text.replace(/\s*[A-Za-z\u4e00-\u9fa5]+$/, '')
}

/** 取数值尾部的单位（含前导空格），没有单位时返回空串。 */
function unitOf(text: string): string {
  return text.slice(stripUnit(text).length)
}

export function MetricCell({
  metrics,
  type,
  limitLabel = 'Limit',
  showPercentage = true,
  showBar = true,
  showRequest = true,
}: {
  metrics?: MetricsData
  type: MetricType
  limitLabel?: string // e.g., "Limit" or "Capacity"
  showPercentage?: boolean // Whether to show percentage in the display
  showBar?: boolean // Set false to render only the numeric value (no progress bar)
  showRequest?: boolean // Set false when there is no meaningful request
}) {
  const { t } = useTranslation()

  const metricValue =
    type === 'cpu'
      ? metrics?.cpuUsage || 0
      : type === 'memory'
        ? metrics?.memoryUsage || 0
        : metrics?.pods || 0

  const metricLimit =
    type === 'cpu'
      ? metrics?.cpuLimit
      : type === 'memory'
        ? metrics?.memoryLimit
        : metrics?.podsLimit

  // Pod 数没有「请求」这个概念，只有 CPU / 内存有。
  const metricRequest =
    type === 'cpu'
      ? metrics?.cpuRequest
      : type === 'memory'
        ? metrics?.memoryRequest
        : undefined

  const formatValue = useCallback(
    (val?: number) => {
      if (val === undefined || val === null) return '-'
      if (type === 'cpu') return formatCores(val)
      if (type === 'memory') return formatMemory(val)
      return String(val)
    },
    [type]
  )

  return useMemo(() => {
    const percentage = metricLimit
      ? Math.min((metricValue / metricLimit) * 100, 100)
      : 0

    // 上限与用量同一单位时只写一次（4.69 GiB / 8 GiB → 4.69 / 8 GiB、0 核 / 4 核 → 0 / 4 核）：
    // 内存这列文本本来就长，列宽有限时能省下几个字符给百分比留位置。
    const rawUsage = formatValue(metricValue)
    const rawLimit = formatValue(metricLimit)
    const usageText = rawUsage
    const limitText =
      unitOf(rawLimit) !== '' && unitOf(rawUsage) === unitOf(rawLimit)
        ? stripUnit(rawLimit)
        : rawLimit

    const getProgressColor = () => {
      if (percentage > 90) return 'bg-destructive'
      if (percentage > 60) return 'bg-warning'
      return 'bg-info'
    }

    // 悬浮明细：使用量 / 请求 / 可分配，数值右对齐。
    const detail = (
      <div className="text-sm grid grid-cols-2 gap-x-3 gap-y-0.5 min-w-0">
        <span>{t('common.metrics.usage', 'Usage')}:</span>
        <span className="text-right">{formatValue(metricValue)}</span>
        {showRequest && metricRequest !== undefined && metricRequest > 0 && (
          <>
            <span>{t('common.metrics.request', 'Request')}:</span>
            <span className="text-right">{formatValue(metricRequest)}</span>
          </>
        )}
        <span>{limitLabel}:</span>
        <span className="text-right">{formatValue(metricLimit)}</span>
      </div>
    )

    // 没有上限可比时退回单行：不画一条永远是 0 的进度条。
    if (!showBar || !metricLimit) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-block w-full truncate text-right text-xs text-muted-foreground whitespace-nowrap tabular-nums">
              {formatValue(metricValue)}
            </span>
          </TooltipTrigger>
          <TooltipContent>{detail}</TooltipContent>
        </Tooltip>
      )
    }

    return (
      // 两行布局：上行「用量 / 上限 + 百分比」，下行进度条——一眼横向比较各节点水位。
      // 整格都可悬浮（不只是进度条）：数值同样需要解释请求与可分配是多少。
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex w-full min-w-0 flex-col gap-1">
            <div className="flex min-w-0 items-center justify-between gap-3">
              <span className="min-w-0 truncate text-xs tabular-nums">
                {usageText}
                <span className="text-muted-foreground"> / </span>
                {limitText}
              </span>
              {showPercentage && (
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {percentage.toFixed(0)}%
                </span>
              )}
            </div>
            <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full transition-all duration-300 ${getProgressColor()}`}
                style={{
                  width: `${percentage}%`,
                  // 非零时给个最小宽度，否则 1% 这种水位完全看不见。
                  minWidth: percentage > 0 ? '0.25rem' : undefined,
                }}
              />
              {showRequest && metricRequest && metricLimit && (
                <div
                  className="absolute top-0 h-full w-0.5 bg-foreground/40"
                  style={{
                    left: `${Math.min((metricRequest / metricLimit) * 100, 100)}%`,
                  }}
                />
              )}
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent>{detail}</TooltipContent>
      </Tooltip>
    )
  }, [
    metricLimit,
    metricValue,
    metricRequest,
    formatValue,
    limitLabel,
    showPercentage,
    showBar,
    showRequest,
    t,
  ])
}
