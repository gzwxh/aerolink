import { useMemo, useState } from 'react'
import {
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
  IconClock,
} from '@tabler/icons-react'
import {
  addMonths,
  addYears,
  format,
  isSameMonth,
  startOfMonth,
  subMonths,
  subYears,
} from 'date-fns'
import { useTranslation } from 'react-i18next'

import type { AuditTimeRange } from '@/lib/api'
import {
  AUDIT_TIME_PRESETS,
  monthGridDays,
  parseAuditTime,
  presetTimeRange,
  type AuditTimePreset,
} from '@/lib/audit-time-range'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

// 取值是「YYYY-MM-DD HH:mm:ss」：日期框与时间框各编辑一半，空日期表示该端不限制。
const FALLBACK_TIME = { from: '00:00:00', to: '23:59:59' } as const

function splitAuditValue(value: string | undefined, fallbackTime: string) {
  const [date = '', time] = (value ?? '').split(' ')
  return { date, time: time || fallbackTime }
}

function joinAuditValue(date: string, time: string) {
  return date ? `${date} ${time || '00:00:00'}` : undefined
}

function dayKey(value: Date): string {
  return format(value, 'yyyy-MM-dd')
}

function MonthPanel({
  month,
  rangeFrom,
  rangeTo,
  onSelectDay,
}: {
  month: Date
  rangeFrom?: Date
  rangeTo?: Date
  onSelectDay: (day: Date) => void
}) {
  const { t } = useTranslation()
  const days = useMemo(() => monthGridDays(month), [month])
  const weekdays = useMemo(
    () => t('audit.timeRange.weekdays', '日,一,二,三,四,五,六').split(','),
    [t]
  )
  const fromKey = rangeFrom ? dayKey(rangeFrom) : undefined
  const toKey = rangeTo ? dayKey(rangeTo) : undefined

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
          const outside = !isSameMonth(day, month)
          const selected = key === fromKey || key === toKey
          // 区间内的每个格子都铺底色，连起来才是一条完整的选区（含两端）。
          const inRange =
            fromKey && toKey ? key >= fromKey && key <= toKey : false
          return (
            <div
              key={key}
              className={cn(
                'flex h-8 items-center justify-center',
                inRange && 'bg-primary/10'
              )}
            >
              <button
                type="button"
                onClick={() => onSelectDay(day)}
                aria-pressed={selected}
                className={cn(
                  'h-8 w-8 rounded-md text-sm transition-colors',
                  outside ? 'text-muted-foreground/60' : 'hover:bg-accent',
                  selected &&
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

/**
 * 审计日志的时间范围筛选：左侧快捷范围，中间日期 + 时间输入，右侧双月日历。
 *
 * 取值精确到秒（等保三级核查要按时间段定界），因此比原先的原生日期输入多了时间部分：
 * 组件里存的是本地时间字符串，转查询参数时由 `toAuditQueryTimeRange` 补上时区。
 * 打开时把已生效的值拷进草稿，只有点「确定」才写回外部状态。
 */
export function AuditTimeRangePicker({
  value,
  onChange,
}: {
  value: AuditTimeRange
  onChange: (value: AuditTimeRange) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<AuditTimeRange>({})
  const [preset, setPreset] = useState<AuditTimePreset | undefined>(undefined)
  const [visibleMonth, setVisibleMonth] = useState(() =>
    startOfMonth(new Date())
  )

  const rangeFrom = parseAuditTime(draft.from)
  const rangeTo = parseAuditTime(draft.to)
  const invalid = Boolean(rangeFrom && rangeTo && rangeTo < rangeFrom)

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (next) {
      setDraft(value)
      setPreset(undefined)
      setVisibleMonth(startOfMonth(parseAuditTime(value.from) ?? new Date()))
    }
  }

  const applyPreset = (id: AuditTimePreset) => {
    const range = presetTimeRange(id)
    setDraft(range)
    setPreset(id)
    setVisibleMonth(startOfMonth(parseAuditTime(range.from) ?? new Date()))
  }

  // 点日期只改天，时间部分保留（没有就按该端的默认时间补一个整日边界）。
  const selectDay = (day: Date) => {
    setPreset(undefined)
    const key = dayKey(day)
    const fromTime = splitAuditValue(draft.from, FALLBACK_TIME.from).time
    const toTime = splitAuditValue(draft.to, FALLBACK_TIME.to).time
    if (!draft.from || draft.to) {
      setDraft({ from: `${key} ${fromTime}` })
      return
    }
    if (key < draft.from.slice(0, 10)) {
      setDraft({ from: `${key} ${fromTime}` })
      return
    }
    setDraft({ from: draft.from, to: `${key} ${toTime}` })
  }

  const updatePart = (
    end: 'from' | 'to',
    part: 'date' | 'time',
    next: string
  ) => {
    setPreset(undefined)
    const current = splitAuditValue(draft[end], FALLBACK_TIME[end])
    const merged = { ...current, [part]: next }
    setDraft({ ...draft, [end]: joinAuditValue(merged.date, merged.time) })
  }

  const triggerLabel =
    value.from || value.to
      ? `${value.from ?? t('audit.timeRange.unbounded', '不限')} ${t(
          'audit.timeRange.separator',
          '至'
        )} ${value.to ?? t('audit.timeRange.unbounded', '不限')}`
      : t('audit.timeRange.placeholder', '请选择时间范围')

  const fromParts = splitAuditValue(draft.from, FALLBACK_TIME.from)
  const toParts = splitAuditValue(draft.to, FALLBACK_TIME.to)
  const monthLabel = (month: Date) =>
    t('audit.timeRange.monthLabel', '{{year}}年{{month}}月', {
      year: month.getFullYear(),
      month: month.getMonth() + 1,
    })
  const nextMonth = addMonths(visibleMonth, 1)

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn(
            'justify-start gap-2 font-normal',
            !value.from && !value.to && 'text-muted-foreground'
          )}
        >
          <IconClock className="h-4 w-4" />
          {triggerLabel}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0" sideOffset={6}>
        <div className="flex">
          <div className="flex w-24 shrink-0 flex-col gap-0.5 border-r p-2">
            {AUDIT_TIME_PRESETS.map((id) => (
              <Button
                key={id}
                type="button"
                variant="ghost"
                size="sm"
                className={cn(
                  'justify-start px-2 font-normal',
                  preset === id && 'bg-accent text-accent-foreground'
                )}
                onClick={() => applyPreset(id)}
              >
                {t(`audit.timeRange.presets.${id}`, id)}
              </Button>
            ))}
          </div>

          <div className="flex flex-col">
            <div className="flex items-center gap-2 border-b px-3 py-2">
              <Input
                type="date"
                value={fromParts.date}
                onChange={(event) =>
                  updatePart('from', 'date', event.target.value)
                }
                aria-label={t('audit.timeRange.from', '开始时间')}
                className="h-8 w-32"
              />
              <Input
                type="time"
                step={1}
                value={fromParts.time}
                onChange={(event) =>
                  updatePart('from', 'time', event.target.value)
                }
                aria-label={t('audit.timeRange.fromTime', '开始时刻')}
                className="h-8 w-28"
              />
              <IconChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              <Input
                type="date"
                value={toParts.date}
                onChange={(event) =>
                  updatePart('to', 'date', event.target.value)
                }
                aria-label={t('audit.timeRange.to', '结束时间')}
                className="h-8 w-32"
              />
              <Input
                type="time"
                step={1}
                value={toParts.time}
                onChange={(event) =>
                  updatePart('to', 'time', event.target.value)
                }
                aria-label={t('audit.timeRange.toTime', '结束时刻')}
                className="h-8 w-28"
              />
            </div>

            <div className="flex flex-col px-3 pb-1">
              <div className="flex items-center">
                <div className="flex gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground"
                    aria-label={t('audit.timeRange.prevYear', '上一年')}
                    onClick={() => setVisibleMonth(subYears(visibleMonth, 1))}
                  >
                    <IconChevronsLeft className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground"
                    aria-label={t('audit.timeRange.prevMonth', '上个月')}
                    onClick={() => setVisibleMonth(subMonths(visibleMonth, 1))}
                  >
                    <IconChevronLeft className="h-4 w-4" />
                  </Button>
                </div>
                <div className="flex-1 text-center text-sm font-medium">
                  {monthLabel(visibleMonth)}
                </div>
                <div className="flex-1 text-center text-sm font-medium">
                  {monthLabel(nextMonth)}
                </div>
                <div className="flex gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground"
                    aria-label={t('audit.timeRange.nextMonth', '下个月')}
                    onClick={() => setVisibleMonth(addMonths(visibleMonth, 1))}
                  >
                    <IconChevronRight className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground"
                    aria-label={t('audit.timeRange.nextYear', '下一年')}
                    onClick={() => setVisibleMonth(addYears(visibleMonth, 1))}
                  >
                    <IconChevronsRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              <div className="flex gap-4">
                <MonthPanel
                  month={visibleMonth}
                  rangeFrom={rangeFrom}
                  rangeTo={rangeTo}
                  onSelectDay={selectDay}
                />
                <MonthPanel
                  month={nextMonth}
                  rangeFrom={rangeFrom}
                  rangeTo={rangeTo}
                  onSelectDay={selectDay}
                />
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 border-t px-3 py-2">
              <span className="text-xs text-destructive">
                {invalid
                  ? t('audit.timeRange.invalid', '结束时间不能早于开始时间')
                  : ''}
              </span>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setDraft({})
                    setPreset(undefined)
                  }}
                >
                  {t('audit.timeRange.clear', '清空')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={invalid}
                  onClick={() => {
                    onChange(draft)
                    setOpen(false)
                  }}
                >
                  {t('common.actions.confirm', '确认')}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
