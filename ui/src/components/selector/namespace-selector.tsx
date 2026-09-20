import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Namespace } from 'kubernetes-types/core/v1'
import { Check, ChevronDown, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { fetchUserBindingGroups, useResources } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

export function NamespaceSelector({
  selectedNamespace,
  handleNamespaceChange,
  showAll = false,
  disabled = false,
  triggerClassName,
  multiple = false,
  modal = false,
}: {
  selectedNamespace?: string
  handleNamespaceChange: (namespace: string) => void
  showAll?: boolean
  disabled?: boolean
  triggerClassName?: string
  multiple?: boolean
  modal?: boolean
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const { data, isLoading } = useResources('namespaces')
  const selectedNamespaces = useMemo(() => {
    if (!selectedNamespace || selectedNamespace === '_all') return []
    return selectedNamespace.split(',').filter(Boolean)
  }, [selectedNamespace])

  const sortedNamespaces = useMemo(() => {
    if (!data) return []
    return [...data].sort((a, b) => {
      const nameA = a.metadata?.name?.toLowerCase() || ''
      const nameB = b.metadata?.name?.toLowerCase() || ''
      return nameA.localeCompare(nameB)
    })
  }, [data])

  // 权限绑定：当前用户可见的组及其命名空间，用于下拉分组展示
  const { data: bindingGroups = [] } = useQuery({
    queryKey: ['user-binding-groups'],
    queryFn: fetchUserBindingGroups,
    staleTime: 60_000,
  })

  const namespaceGroups = useMemo(() => {
    const owner = new Map<string, string>()
    bindingGroups.forEach((g) =>
      (g.namespaces ?? []).forEach((n) => owner.set(n.namespace, g.name))
    )
    const grouped = new Map<string, Namespace[]>()
    const loose: Namespace[] = []
    sortedNamespaces.forEach((ns) => {
      const name = ns.metadata?.name || ''
      const groupName = owner.get(name)
      if (groupName) {
        if (!grouped.has(groupName)) grouped.set(groupName, [])
        grouped.get(groupName)!.push(ns)
      } else {
        loose.push(ns)
      }
    })
    return { grouped: Array.from(grouped.entries()), loose }
  }, [sortedNamespaces, bindingGroups])

  const renderNamespaceItem = (ns: Namespace) => {
    const name = ns.metadata?.name || ''
    const selected = multiple
      ? selectedNamespaces.includes(name)
      : selectedNamespace === name

    return (
      <CommandItem
        key={name}
        value={name}
        onSelect={() => handleNamespaceSelect(name)}
        className="flex items-center"
      >
        {multiple ? (
          <Checkbox
            checked={selected}
            onCheckedChange={() => toggleNamespace(name)}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            aria-label={t('common.namespaceSelector.toggle', {
              name,
              defaultValue: 'Toggle namespace {{name}}',
            })}
            className="mr-2"
          />
        ) : (
          <Check
            className={cn(
              'mr-2 h-4 w-4 shrink-0',
              selected ? 'opacity-100' : 'opacity-0'
            )}
          />
        )}
        <span className="truncate flex-1 min-w-0" title={name}>
          {name}
        </span>
      </CommandItem>
    )
  }

  const triggerLabel =
    selectedNamespace === '_all'
      ? t('common.namespaceSelector.all', 'All Namespaces')
      : multiple && selectedNamespaces.length > 1
        ? t('common.namespaceSelector.many', {
            total: selectedNamespaces.length,
            defaultValue: '{{total}} Namespaces',
          })
        : selectedNamespace ||
          t(
            multiple
              ? 'common.namespaceSelector.selectMultiple'
              : 'common.namespaceSelector.select',
            multiple ? 'Select namespaces...' : 'Select namespace...'
          )

  const selectNamespace = (namespace: string) => {
    handleNamespaceChange(namespace)
    setOpen(false)
  }

  const toggleNamespace = (namespace: string) => {
    if (selectedNamespace === '_all') {
      handleNamespaceChange(namespace)
      return
    }

    const nextNamespaces = selectedNamespaces.includes(namespace)
      ? selectedNamespaces.filter((name) => name !== namespace)
      : [...selectedNamespaces, namespace]

    handleNamespaceChange(
      nextNamespaces.length > 0 ? nextNamespaces.join(',') : '_all'
    )
  }

  const handleNamespaceSelect = (namespace: string) => {
    if (multiple && selectedNamespaces.length >= 2) {
      toggleNamespace(namespace)
      return
    }

    selectNamespace(namespace)
  }

  return (
    <Popover open={open} onOpenChange={setOpen} modal={modal}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            'h-9 w-full min-w-0 justify-between gap-2 rounded-md border-input bg-transparent px-3 py-2 text-sm font-normal shadow-xs hover:bg-transparent focus-visible:border-ring focus-visible:ring-ring/50 dark:bg-input/30 dark:hover:bg-input/50 sm:w-auto sm:min-w-[9rem] sm:max-w-[14rem]',
            triggerClassName
          )}
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>

      <PopoverContent
        className="w-[max(var(--radix-popover-trigger-width),18rem)] max-w-[min(300px,calc(100vw-1rem))] p-0"
        align="start"
      >
        <Command>
          <CommandInput
            placeholder={t('common.namespaceSelector.search', 'Search...')}
            className="h-9"
          />
          <CommandList className="max-h-[min(50dvh,300px)] overflow-x-hidden overflow-y-auto overscroll-contain">
            {isLoading ? (
              <div className="flex items-center justify-center p-6 text-sm">
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                {t('common.namespaceSelector.loading', 'Loading...')}
              </div>
            ) : (
              <>
                <CommandEmpty>
                  {t('common.namespaceSelector.noResults', 'No results')}
                </CommandEmpty>
                {/* 分组之间不能嵌套 CommandGroup：cmdk 在搜索时只保留「直属 item
                    命中」的分组，外层空分组会被连子分组一起隐藏，表现就是输入
                    关键词后整个列表空白。所以各分组一律作为 CommandList 的直接子级。 */}
                {showAll && (
                  <CommandGroup>
                    <CommandItem
                      value="_all"
                      onSelect={() => {
                        handleNamespaceChange('_all')
                        setOpen(false)
                      }}
                    >
                      <Check
                        className={cn(
                          'mr-2 h-4 w-4 shrink-0',
                          selectedNamespace === '_all'
                            ? 'opacity-100'
                            : 'opacity-0'
                        )}
                      />
                      <span className="truncate">
                        {t('common.namespaceSelector.all', 'All Namespaces')}
                      </span>
                    </CommandItem>
                  </CommandGroup>
                )}

                {namespaceGroups.grouped.map(([groupName, list]) => (
                  <CommandGroup key={groupName} heading={groupName}>
                    {list.map(renderNamespaceItem)}
                  </CommandGroup>
                ))}
                {namespaceGroups.loose.length > 0 && (
                  <CommandGroup
                    heading={
                      namespaceGroups.grouped.length > 0
                        ? t(
                            'common.namespaceSelector.other',
                            'Other namespaces'
                          )
                        : undefined
                    }
                  >
                    {namespaceGroups.loose.map(renderNamespaceItem)}
                  </CommandGroup>
                )}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
