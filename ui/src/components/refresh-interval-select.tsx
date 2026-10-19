import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/**
 * 自动刷新间隔（毫秒），`0` 表示关闭。
 *
 * 资源列表工具栏与资源详情页共用同一组取值，避免两处各写一份。
 */
const REFRESH_INTERVAL_OPTIONS = [0, 1000, 5000, 10000, 30000] as const

interface RefreshIntervalSelectProps {
  value: number
  onChange: (value: number) => void
  /** 例如列表页在监听（watch）模式下由服务端推送，自动刷新会被禁用。 */
  disabled?: boolean
  className?: string
}

export function RefreshIntervalSelect({
  value,
  onChange,
  disabled,
  className,
}: RefreshIntervalSelectProps) {
  const { t } = useTranslation()

  return (
    <Select
      value={value.toString()}
      onValueChange={(next) => onChange(Number(next))}
      disabled={disabled}
    >
      <SelectTrigger
        className={cn('w-full sm:w-[120px]', className)}
        aria-label={t('resourceTable.refreshInterval')}
      >
        <div className="flex items-center gap-2">
          <RefreshCw className="h-4 w-4" />
          <SelectValue />
        </div>
      </SelectTrigger>
      <SelectContent>
        {REFRESH_INTERVAL_OPTIONS.map((option) => (
          <SelectItem key={option} value={option.toString()}>
            {option === 0 ? t('resourceTable.refreshOff') : `${option / 1000}s`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
