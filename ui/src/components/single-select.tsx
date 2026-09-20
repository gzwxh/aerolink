import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, ChevronsUpDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Label } from '@/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

interface SingleSelectProps {
  label?: string
  options: string[]
  value: string
  onChange: (value: string) => void
  placeholder?: string
  emptyText?: string
  disabled?: boolean
}

const PAGE_SIZE = 50

/**
 * 单选下拉：与 MultiSelect 同一套弹出层 / 搜索 / 分页交互，但渲染的是**单选框**，
 * 选中即替换当前值并关闭弹层。
 *
 * 用在「语义上就是单选」的位置（例如权限绑定里一个用户/用户组只能出现在一组授权中），
 * 避免用多选框的样式表达单选，让人误以为可以多选。
 */
export function SingleSelect({
  label,
  options,
  value,
  onChange,
  placeholder,
  emptyText,
  disabled,
}: SingleSelectProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)

  const dedupedOptions = useMemo(() => {
    const seen = new Set<string>()
    const result: string[] = []
    for (const opt of options) {
      if (!seen.has(opt)) {
        seen.add(opt)
        result.push(opt)
      }
    }
    return result
  }, [options])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return dedupedOptions
    return dedupedOptions.filter((opt) => opt.toLowerCase().includes(q))
  }, [dedupedOptions, search])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages - 1)
  const pageOptions = useMemo(
    () => filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE),
    [filtered, safePage]
  )

  const select = (option: string) => {
    onChange(option)
    setOpen(false)
  }

  return (
    <div className="space-y-1.5">
      {label && <Label>{label}</Label>}
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setSearch('')
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            className="h-9 w-full justify-between font-normal"
          >
            <span
              className={`truncate ${value ? '' : 'text-muted-foreground'}`}
            >
              {value ||
                placeholder ||
                t('common.placeholders.select', 'Select...')}
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-[var(--radix-popover-trigger-width)] p-0"
          align="start"
        >
          <Command shouldFilter={false}>
            <CommandInput
              value={search}
              onValueChange={(v) => {
                setSearch(v)
                setPage(0)
              }}
              placeholder={t('common.placeholders.searchItems', 'Search...')}
              className="h-9"
            />
            <CommandList
              className="max-h-[min(45dvh,240px)] overflow-x-hidden overflow-y-auto overscroll-contain"
              onWheelCapture={(event) => event.stopPropagation()}
              onTouchMove={(event) => event.stopPropagation()}
            >
              <CommandEmpty>
                {emptyText ||
                  t('common.messages.noOptionsFound', 'No options found')}
              </CommandEmpty>
              <CommandGroup className="p-0">
                {pageOptions.map((option) => {
                  const selected = option === value
                  return (
                    <CommandItem
                      key={option}
                      value={option}
                      role="radio"
                      aria-checked={selected}
                      onSelect={() => select(option)}
                    >
                      <span
                        className={`mr-2 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                          selected
                            ? 'border-primary'
                            : 'border-muted-foreground/30'
                        }`}
                      >
                        {selected && (
                          <span className="h-2 w-2 rounded-full bg-primary" />
                        )}
                      </span>
                      <span className="min-w-0 truncate">{option}</span>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            </CommandList>
            {totalPages > 1 && (
              <div className="flex items-center justify-between gap-2 border-t p-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2"
                  disabled={safePage === 0}
                  onClick={() => setPage(safePage - 1)}
                >
                  <ChevronLeft className="h-4 w-4" />
                  {t('common.pagination.previous', 'Previous')}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {t('common.pagination.page', {
                    current: safePage + 1,
                    total: totalPages,
                    defaultValue: 'Page {{current}} of {{total}}',
                  })}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2"
                  disabled={safePage >= totalPages - 1}
                  onClick={() => setPage(safePage + 1)}
                >
                  {t('common.pagination.next', 'Next')}
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            )}
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}

export default SingleSelect
