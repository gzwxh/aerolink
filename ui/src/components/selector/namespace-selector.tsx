import { useMemo, useState } from 'react'
import { Namespace } from 'kubernetes-types/core/v1'
import { Check, ChevronDown, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useNamespaceBindingMap } from '@/hooks/use-namespace-binding-map'
import { useResources } from '@/lib/api'
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

  const selectedSet = useMemo(
    () => new Set(selectedNamespaces),
    [selectedNamespaces]
  )

  // 权限绑定：当前集群下「命名空间 → 组名」映射，用于下拉分组与组级整选
  const bindingMap = useNamespaceBindingMap()

  const namespaceGroups = useMemo(() => {
    const grouped = new Map<string, Namespace[]>()
    const loose: Namespace[] = []
    sortedNamespaces.forEach((ns) => {
      const name = ns.metadata?.name || ''
      const groupName = bindingMap.get(name)
      if (groupName) {
        if (!grouped.has(groupName)) grouped.set(groupName, [])
        grouped.get(groupName)!.push(ns)
      } else {
        loose.push(ns)
      }
    })
    return { grouped: Array.from(grouped.entries()), loose }
  }, [sortedNamespaces, bindingMap])

  // 含已选项的分组整体上浮：组头连着组内条目一起排到前面（参考截图：选中的
  // 项目分组排在前面），重开下拉就能一眼看到已选范围落在哪几个组里。
  // 散装的「其他 Namespace」也参与排序，避免只选了散装项时看不出任何变化。
  // 这里只管组间顺序，组内的「已选优先」在渲染时做：toggleGroupSelection 依赖
  // 组内原有字母序决定「补齐整组」的取值顺序。
  const orderedSections = useMemo(() => {
    type Section = {
      key: string
      /** 权限绑定组名；散装分组没有组名，标题另有兜底文案 */
      heading?: string
      list: Namespace[]
      /** 权限绑定组：多选时组头是可点选的整组勾选行 */
      isBindingGroup: boolean
    }
    const sections: Section[] = namespaceGroups.grouped.map(([name, list]) => ({
      key: name,
      heading: name,
      list,
      isBindingGroup: true,
    }))
    if (namespaceGroups.loose.length > 0) {
      sections.push({
        key: '__loose__',
        list: namespaceGroups.loose,
        isBindingGroup: false,
      })
    }
    const hasSelected = (section: Section) =>
      section.list.some((ns) => selectedSet.has(ns.metadata?.name || ''))
    return sections
      .filter(hasSelected)
      .concat(sections.filter((section) => !hasSelected(section)))
  }, [namespaceGroups, selectedSet])

  // 散装分组的兜底标题：只有存在权限绑定分组时才需要一个区分用的标题
  const looseHeading =
    namespaceGroups.grouped.length > 0
      ? t('common.namespaceSelector.other', 'Other namespaces')
      : undefined

  // groupName 编码进 cmdk 的 value（显示文本不变）：cmdk 只按条目 value 过滤，
  // 组名不进 value 的话，搜索框里输入权限绑定组名无法命中该组下的命名空间。
  const renderNamespaceItem = (
    ns: Namespace,
    groupName?: string,
    indent?: boolean
  ) => {
    const name = ns.metadata?.name || ''
    const selected = multiple
      ? selectedNamespaces.includes(name)
      : selectedNamespace === name

    return (
      <CommandItem
        key={name}
        value={groupName ? `${groupName} ${name}` : name}
        onSelect={() => handleNamespaceSelect(name)}
        className={cn('flex items-center', indent && 'pl-7')}
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
    // 单选：选完即收起；多选时条目走 toggleNamespace，不收下拉，方便连续勾选
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

  // 组级选择：该组全部已选时点击取消整组，否则把组内命名空间并入选中
  const toggleGroupSelection = (list: Namespace[]) => {
    const names = list
      .map((ns) => ns.metadata?.name || '')
      .filter(Boolean)
    const allSelected =
      names.length > 0 &&
      names.every((name) => selectedNamespaces.includes(name))
    const next = allSelected
      ? selectedNamespaces.filter((name) => !names.includes(name))
      : Array.from(new Set([...selectedNamespaces, ...names]))
    handleNamespaceChange(next.length > 0 ? next.join(',') : '_all')
  }

  const handleNamespaceSelect = (namespace: string) => {
    // 多选模式：点击条目只切换勾选，不收起下拉，方便连续选择多个命名空间
    // （收起由点击下拉外部或再点触发按钮完成）。
    if (multiple) {
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
        // 关闭时机只认「点击外部 / Esc / 再点触发按钮」，不要用 onMouseLeave 收起：
        // 多选时鼠标稍一移出列表，连续勾选就会被打断。
        // 另：cmdk 的条目是不可聚焦的 div，点它会让焦点从搜索框掉回 body，Radix 会
        // 把这当成「焦点离开浮层」而立刻收起下拉 —— 表现就是点一次就关。多选下忽略它。
        onFocusOutside={(event) => {
          if (multiple) event.preventDefault()
        }}
      >
        <Command>
          <CommandInput
            placeholder={t('common.namespaceSelector.search', 'Search...')}
            className="h-9"
          />
          <CommandList
            // 分组之间画分隔线：用相邻兄弟选择器，并排除被 cmdk 过滤隐藏的分组，
            // 这样搜索时不会留下悬空线，首个可见分组自己也不带线。
            className={cn(
              'max-h-[min(50dvh,300px)] overflow-x-hidden overflow-y-auto overscroll-contain',
              '[&_[cmdk-group]:not([hidden])~[cmdk-group]:not([hidden])]:border-t'
            )}
          >
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
                      onSelect={() => handleNamespaceChange('_all')}
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

                {orderedSections.map((section) => {
                  const names = section.list
                    .map((ns) => ns.metadata?.name || '')
                    .filter(Boolean)
                  const allSelected =
                    names.length > 0 &&
                    names.every((name) => selectedSet.has(name))
                  const someSelected = names.some((name) =>
                    selectedSet.has(name)
                  )
                  // 组内也把已选项排到最前，其余保持原有字母序：组级上浮 + 组内
                  // 上浮，重开下拉就能一眼看到这个组里已经选了哪几个
                  const items = section.list
                    .filter((ns) => selectedSet.has(ns.metadata?.name || ''))
                    .concat(
                      section.list.filter(
                        (ns) => !selectedSet.has(ns.metadata?.name || '')
                      )
                    )
                  return (
                    <CommandGroup
                      key={section.key}
                      // 多选时权限绑定组的组名由可点选的组头行展示，heading 不再重复渲染；
                      // 散装分组没有组头行，一律靠 heading 标明
                      heading={
                        section.isBindingGroup
                          ? multiple
                            ? undefined
                            : section.heading
                          : looseHeading
                      }
                    >
                      {multiple && section.isBindingGroup && (
                        <div
                          className="flex cursor-pointer items-center px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent/50"
                          onClick={() => toggleGroupSelection(section.list)}
                        >
                          <Checkbox
                            checked={
                              allSelected || (someSelected && 'indeterminate')
                            }
                            onCheckedChange={() =>
                              toggleGroupSelection(section.list)
                            }
                            onClick={(event) => event.stopPropagation()}
                            aria-label={t(
                              'common.namespaceSelector.toggleGroup',
                              {
                                name: section.heading,
                                defaultValue:
                                  'Select all namespaces in group {{name}}',
                              }
                            )}
                            className="mr-2"
                          />
                          <span className="truncate">{section.heading}</span>
                        </div>
                      )}
                      {/* 组内条目右移缩进，与组头形成从属层次 */}
                      {items.map((ns) =>
                        renderNamespaceItem(
                          ns,
                          section.heading,
                          section.isBindingGroup
                        )
                      )}
                    </CommandGroup>
                  )
                })}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
