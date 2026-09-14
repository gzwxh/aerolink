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
   * How the dedicated "select all" row behaves.
   * - "wildcard": selecting all collapses the value to ['*'] (the "*" option
   *   must be present in the caller-supplied options, e.g. role grants).
   * - "all": selecting all ticks every concrete option in the list (used by
   *   subject pickers where a literal "*" is not a valid choice).
   */
  selectAllMode?: 'wildcard' | 'all'
  /**
   * Upper bound on the number of selections. When the limit is reached, picking
   * a new option evicts the oldest one, so max=1 behaves like a single select.
   * Bulk actions (select all / select page) are hidden while a limit is set.
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

  // Options that can be picked individually (the "*" wildcard, when present in
  // the list, is represented by the dedicated select-all row instead).
  const concreteOptions = useMemo(
    () => dedupedOptions.filter((opt) => opt !== '*'),
    [dedupedOptions]
  )

  // Appends an option while honouring `max`: the oldest selection is dropped
  // once the limit is reached so the newest pick always wins.
  const withAdded = (option: string) => {
    if (max === undefined || value.length < max) return [...value, option]
    return [...value.slice(value.length - max + 1), option]
  }

  // Selecting "*" means "all": it is exclusive, so it replaces any concrete
  // items, and picking a concrete item while "*" is active narrows to it.
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

  // Wildcard select-all: ['*'] toggles with [].
  const toggleWildcardAll = () => toggle('*')

  // Concrete select-all (subject pickers): ticks every real option.
  const allConcreteSelected =
    concreteOptions.length > 0 &&
    concreteOptions.every((opt) => value.includes(opt))
  const toggleSelectAllOptions = () => {
    if (allSelected) return
    if (allConcreteSelected) {
      onChange(value.filter((v) => v !== '*'))
      return
    }
    const merged = value.filter((v) => v !== '*')
    for (const opt of concreteOptions) {
      if (!merged.includes(opt)) merged.push(opt)
    }
    onChange(merged)
  }

  // Page-level select: toggle every option rendered on the current page. This
  // is how large lists are filled page by page without switching to "*".
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
    pageSelectable.length > 0

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
                        (selectAllMode === 'wildcard' && allSelected) ||
                        (selectAllMode === 'all' && allConcreteSelected)
                          ? 'bg-primary text-primary-foreground'
                          : 'border-muted-foreground/30'
                      }`}
                    >
                      {((selectAllMode === 'wildcard' && allSelected) ||
                        (selectAllMode === 'all' && allConcreteSelected)) && (
                        <Check className="h-3 w-3" />
                      )}
                    </div>
                    <span className="min-w-0 truncate font-medium">
                      {selectAllMode === 'wildcard'
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
                  // In wildcard mode a "*" value means every concrete option
                  // is covered, so render them as checked as well.
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
            {value.length > 0 && (
              <div className="border-t p-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  onClick={() => onChange([])}
                >
                  {t('common.actions.clearAll', 'Clear all')}
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
