import { useMemo, useState } from 'react'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
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

interface MultiSelectProps {
  label?: string
  options: string[]
  value: string[]
  onChange: (value: string[]) => void
  placeholder?: string
  emptyText?: string
  hint?: string
  disabled?: boolean
  allowAdd?: boolean
  /**
   * 专用"全选"行的行为。
   * - "wildcard"：全选会把值折叠为 ['*']（"*" 选项
   *   必须存在于调用方提供的选项中，例如角色授权）。
   * - "all"：全选会勾选列表中的每一个具体选项（用于
   *   那些字面量 "*" 不是合法取值的主体选择器）。
   */
  selectAllMode?: 'wildcard' | 'all'
  /**
   * 选中数量的上限。达到上限后，再选择新选项会
   * 淘汰最旧的一个，因此 max=1 等同于单选。
   * 设置了上限时，批量操作（全选 / 选择本页）会被隐藏。
   */
  max?: number
}

const PAGE_SIZE = 50

export function MultiSelect({
  label,
  options,
  value,
  onChange,
  placeholder,
  emptyText,
  hint,
  disabled,
  allowAdd = true,
  selectAllMode = 'wildcard',
  max,
}: MultiSelectProps) {
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

  const hasAllOption = dedupedOptions.includes('*')
  const allSelected = value.includes('*')
  const searching = search.trim().length > 0

  // 可以单独选中的选项（当列表中存在 "*" 通配时，
  // 由专用的全选行来代表它）。
  const concreteOptions = useMemo(
    () => dedupedOptions.filter((opt) => opt !== '*'),
    [dedupedOptions]
  )

  // 在遵守 `max` 的前提下追加选项：达到上限后淘汰最旧的
  // 选择，使最新的一次选择总是生效。
  const withAdded = (option: string) => {
    if (max === undefined || value.length < max) return [...value, option]
    return [...value.slice(value.length - max + 1), option]
  }

  // 选择 "*" 意味着"全部"：它是排他的，因此会替换掉所有具体
  // 选项；而在 "*" 生效时选择某个具体项，会把范围收窄到它。
  const toggle = (option: string) => {
    if (option === '*') {
      onChange(allSelected ? [] : ['*'])
      return
    }
    if (allSelected) {
      onChange([option])
      return
    }
    onChange(
      value.includes(option)
        ? value.filter((v) => v !== option)
        : withAdded(option)
    )
  }

  const remove = (option: string) => {
    onChange(value.filter((v) => v !== option))
  }

  const addNew = () => {
    const raw = search.trim()
    if (!raw) return
    if (allSelected) {
      onChange([raw])
    } else if (!value.includes(raw)) {
      onChange(withAdded(raw))
    }
    setSearch('')
  }

  // 通配全选：['*'] 与 [] 之间切换。
  const toggleWildcardAll = () => toggle('*')

  // 具体全选（主体选择器）：勾选每一个真实选项；当所有项都已勾选时
  // 清空整个选择（同一行即开关）。
  const allConcreteSelected =
    concreteOptions.length > 0 &&
    concreteOptions.every((opt) => value.includes(opt))
  const toggleSelectAllOptions = () => {
    if (allSelected || allConcreteSelected) {
      onChange([])
      return
    }
    const merged = value.filter((v) => v !== '*')
    for (const opt of concreteOptions) {
      if (!merged.includes(opt)) merged.push(opt)
    }
    onChange(merged)
  }

  // 全选「已全部选上」时（通配或全部具体项）再点一次就是取消全选。
  const allEverythingSelected =
    selectAllMode === 'wildcard' ? allSelected : allConcreteSelected

  // 页级选择：切换当前页渲染的每一个选项。这是
  // 大列表逐页填充的方式，无需切到 "*"。
  const pageSelectable = useMemo(
    () => pageOptions.filter((opt) => opt !== '*'),
    [pageOptions]
  )
  const pageSelectedCount = pageSelectable.filter((opt) =>
    value.includes(opt)
  ).length
  const pageFullySelected =
    pageSelectable.length > 0 && pageSelectedCount === pageSelectable.length
  const togglePage = () => {
    if (allSelected || pageSelectable.length === 0) return
    if (pageFullySelected) {
      onChange(value.filter((v) => !pageSelectable.includes(v)))
      return
    }
    const merged = value.filter((v) => v !== '*')
    for (const opt of pageSelectable) {
      if (!merged.includes(opt)) merged.push(opt)
    }
    onChange(merged)
  }

  const showSelectAllRow =
    max === undefined &&
    !searching &&
    (selectAllMode === 'all' ? concreteOptions.length > 0 : hasAllOption)
  const showPageSelectRow =
    max === undefined &&
    !allSelected &&
    totalPages > 1 &&
    pageSelectable.length > 0 &&
    !allConcreteSelected

  const displayValue = allSelected
    ? t('common.values.all', 'All')
    : value.length === 0
      ? ''
      : value.length <= 2
        ? value.join(', ')
        : t('common.values.selectedCount', {
            count: value.length,
            defaultValue: '{{count}} selected',
          })

  const selectedItems = value

  return (
    <div className="space-y-1.5">
      {label && <Label>{label}</Label>}
      <Popover open={open} onOpenChange={setOpen}>
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
              className={`truncate ${!displayValue ? 'text-muted-foreground' : ''}`}
            >
              {displayValue ||
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
              onKeyDown={(e) => {
                if (
                  e.key === 'Enter' &&
                  allowAdd &&
                  !allSelected &&
                  search.trim()
                ) {
                  e.preventDefault()
                  addNew()
                }
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
              {allowAdd &&
                !allSelected &&
                searching &&
                !dedupedOptions.includes(search.trim()) && (
                  <CommandItem
                    value={search.trim()}
                    onSelect={addNew}
                    className="text-primary"
                  >
                    {t('common.actions.addItem', {
                      defaultValue: 'Add “{{value}}”',
                      value: search.trim(),
                    })}
                  </CommandItem>
                )}
              <CommandGroup className="p-0">
                {showSelectAllRow && (
                  <CommandItem
                    value="__select_all__"
                    onSelect={
                      selectAllMode === 'wildcard'
                        ? toggleWildcardAll
                        : toggleSelectAllOptions
                    }
                    className="border-b"
                  >
                    <div
                      className={`mr-2 flex h-4 w-4 items-center justify-center rounded-sm border ${
                        allEverythingSelected
                          ? 'bg-primary text-primary-foreground'
                          : 'border-muted-foreground/30'
                      }`}
                    >
                      {allEverythingSelected && <Check className="h-3 w-3" />}
                    </div>
                    <span className="min-w-0 truncate font-medium">
                      {allEverythingSelected
                        ? t('common.actions.deselectAllOptions', {
                            defaultValue: 'Clear all',
                          })
                        : selectAllMode === 'wildcard'
                          ? t('common.actions.selectAll', 'Select all (*)')
                          : t('common.actions.selectAllOptions', {
                              count: concreteOptions.length,
                              defaultValue: 'Select all ({{count}})',
                            })}
                    </span>
                  </CommandItem>
                )}
                {showPageSelectRow && (
                  <CommandItem
                    value="__select_page__"
                    onSelect={togglePage}
                    className="border-b text-muted-foreground"
                  >
                    <div
                      className={`mr-2 flex h-4 w-4 items-center justify-center rounded-sm border ${
                        pageFullySelected
                          ? 'bg-primary text-primary-foreground'
                          : 'border-muted-foreground/30'
                      }`}
                    >
                      {pageFullySelected && <Check className="h-3 w-3" />}
                    </div>
                    <span className="min-w-0 truncate">
                      {t('common.actions.selectPage', {
                        count: pageSelectable.length,
                        defaultValue: 'Select this page ({{count}})',
                      })}
                    </span>
                  </CommandItem>
                )}
                {pageOptions.map((option) => {
                  if (option === '*') return null
                  // 在通配模式下，"*" 值意味着覆盖了每个具体选项，
                  // 因此也要把它们渲染为已勾选。
                  const selected =
                    (allSelected && selectAllMode === 'wildcard') ||
                    value.includes(option)
                  return (
                    <CommandItem
                      key={option}
                      value={option}
                      onSelect={() => toggle(option)}
                    >
                      <div
                        className={`mr-2 flex h-4 w-4 items-center justify-center rounded-sm border ${
                          selected
                            ? 'bg-primary text-primary-foreground'
                            : 'border-muted-foreground/30'
                        }`}
                      >
                        {selected && <Check className="h-3 w-3" />}
                      </div>
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
      {selectedItems.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedItems.map((item) => (
            <Badge
              key={item}
              variant="secondary"
              className="max-w-full gap-1 pl-2 pr-1"
            >
              <span className="min-w-0 truncate">{item}</span>
              <button
                type="button"
                onClick={() => remove(item)}
                aria-label={`remove ${item}`}
                className="rounded-sm p-0.5 hover:bg-muted"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
