import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

interface RefreshButtonProps {
  onClick: () => void
  disabled?: boolean
  /** 最短旋转时长：数据回得快时也要看得出来点过了。 */
  minSpinMs?: number
  /** 覆盖默认文案与提示（如监听模式下是「重新连接并拉取」）。 */
  label?: string
  className?: string
}

/**
 * 立刻刷新按钮。只负责「点一次 + 给一段可见反馈」，数据请求由调用方自己做，
 * 避免这里再开一条绕过 react-query 去重的请求路径。
 */
export function RefreshButton({
  onClick,
  disabled = false,
  minSpinMs = 1000,
  label,
  className,
}: RefreshButtonProps) {
  const { t } = useTranslation()
  const [isSpinning, setIsSpinning] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const text = label ?? t('common.actions.refresh', 'Refresh')

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    []
  )

  const handleClick = useCallback(() => {
    if (disabled) return
    onClick()
    // 连点时重置计时，避免第二次点击看不到反馈。
    setIsSpinning(true)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setIsSpinning(false), minSpinMs)
  }, [disabled, minSpinMs, onClick])

  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      onClick={handleClick}
      disabled={disabled}
      aria-label={text}
      title={text}
      className={className}
    >
      <RefreshCw className={cn('h-4 w-4', isSpinning && 'animate-spin')} />
    </Button>
  )
}
