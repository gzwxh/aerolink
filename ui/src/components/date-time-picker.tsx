import { useMemo, useState } from 'react'
import {
  IconCalendar,
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
} from '@tabler/icons-react'
import {
  addMonths,
  addYears,
  isSameMonth,
  startOfMonth,
  subMonths,
  subYears,
} from 'date-fns'
import { useTranslation } from 'react-i18next'

import { dayKey, monthGridDays } from '@/lib/date-time'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

/**
 * 日期 + 时刻选择器：一个可点的月历 + 日期/时刻输入框，取值形如 `2026-09-21 22:00:00`。
 *
 * 原生 `<input type="datetime-local">` 在企业环境的浏览器/策略下常常退化成纯文本框，
 * 只能手打、点不出日历；这里改成与审计页时间筛选一致的「弹出面板 + 月历」，
 * 空串表示未设置（通知栏公告里 = 立即生效 / 永不过期）。
 *
 * 打开时把已生效的值拷进草稿，只有点「确认」才写回外部状态。
 */

const DEFAULT_TIME = '00:00:00'

interface DateTimeDraft {
  date: string
  time: string
}

function splitValue(value?: string): DateTimeDraft {
  const [date = '', time] = (value ?? '').split(' ')
  return { date, time: time || DEFAULT_TIME }
}

function joinValue(draft: DateTimeDraft): string {
  return draft.date ? `${draft.date} ${draft.time || DEFAULT_TIME}` : ''
}

function MonthPanel({
  month,
  selected,
  onSelectDay,
}: {
  month: Date
  selected?: string
  onSelectDay: (day: Date) => void
}) {
  const { t } = useTranslation()
  const days = useMemo(() => monthGridDays(month), [month])
  const weekdays = useMemo(
    () => t('common.dateTime.weekdays', '日,一,二,三,四,五,六').split(','),
    [t]
  )

  return (
    <div className="w-56">
      <div className="grid grid-cols-7">
        {weekdays.map((weekday) => (
          <div
            key={weekday}
            className="py-1 text-center text-xs text-muted-foreground"
          >
            {weekday}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((day) => {
          const key = dayKey(day)
          const isSelected = key === selected
          return (
            <div key={key} className="flex h-8 items-center justify-center">
              <button
                type="button"
                onClick={() => onSelectDay(day)}
                aria-pressed={isSelected}
                className={cn(
                  'h-8 w-8 rounded-md text-sm transition-colors',
                  isSameMonth(day, month)
                    ? 'hover:bg-accent'
                    : 'text-muted-foreground/60',
                  isSelected &&
                    'bg-primary font-medium text-primary-foreground hover:bg-primary'
                )}
              >
                {day.getDate()}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function DateTimePicker({
  id,
  value,
  onChange,
  disabled,
}: {
  id?: string
  /** 本地时间字符串（`DATE_TIME_FORMAT`）；空串表示未设置。 */
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<DateTimeDraft>(() => splitValue(value))
  const [visibleMonth, setVisibleMonth] = useState(() =>
    startOfMonth(new Date())
  )

  const handleOpenChange = (next: boolean) => {
    if (next && disabled) {
      return
    }
    setOpen(next)
    if (next) {
      const current = splitValue(value)
      setDraft(current)
      setVisibleMonth(
        startOfMonth(
          current.date ? new Date(`${current.date}T00:00:00`) : new Date()
        )
      )
    }
  }

  const updatePart = (part: keyof DateTimeDraft, next: string) => {
    setDraft((current) => ({ ...current, [part]: next }))
  }

  const monthLabel = t('common.dateTime.monthLabel', '{{year}}年{{month}}月', {
    year: visibleMonth.getFullYear(),
    month: visibleMonth.getMonth() + 1,
  })

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn(
            'w-full justify-start gap-2 font-normal tabular-nums',
            !value && 'text-muted-foreground'
          )}
        >
          <IconCalendar className="h-4 w-4 shrink-0" />
          <span className="truncate">
            {value || t('common.dateTime.placeholder', '选择时间')}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0" sideOffset={6}>
        <div className="flex flex-col">
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <Input
              type="date"
              value={draft.date}
              onChange={(event) => updatePart('date', event.target.value)}
              aria-label={t('common.dateTime.date', '日期')}
              className="h-8 w-32"
            />
            <Input
              type="time"
              step={1}
              value={draft.time}
              onChange={(event) => updatePart('time', event.target.value)}
              aria-label={t('common.dateTime.time', '时刻')}
              className="h-8 w-28"
            />
          </div>

          <div className="flex flex-col px-3 pb-1">
            <div className="flex items-center justify-between gap-1">
              <div className="flex gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground"
                  aria-label={t('common.dateTime.prevYear', '上一年')}
                  onClick={() => setVisibleMonth(subYears(visibleMonth, 1))}
                >
                  <IconChevronsLeft className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground"
                  aria-label={t('common.dateTime.prevMonth', '上个月')}
                  onClick={() => setVisibleMonth(subMonths(visibleMonth, 1))}
                >
                  <IconChevronLeft className="h-4 w-4" />
                </Button>
              </div>
              <div className="text-sm font-medium">{monthLabel}</div>
              <div className="flex gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground"
                  aria-label={t('common.dateTime.nextMonth', '下个月')}
                  onClick={() => setVisibleMonth(addMonths(visibleMonth, 1))}
                >
                  <IconChevronRight className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground"
                  aria-label={t('common.dateTime.nextYear', '下一年')}
                  onClick={() => setVisibleMonth(addYears(visibleMonth, 1))}
                >
                  <IconChevronsRight className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <MonthPanel
              month={visibleMonth}
              selected={draft.date}
              onSelectDay={(day) => updatePart('date', dayKey(day))}
            />
          </div>

          <div className="flex items-center justify-between gap-2 border-t px-3 py-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setDraft({ date: '', time: DEFAULT_TIME })}
            >
              {t('common.dateTime.clear', '清空')}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                onChange(joinValue(draft))
                setOpen(false)
              }}
            >
              {t('common.actions.confirm', '确认')}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
