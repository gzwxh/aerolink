import { type ComponentProps } from 'react'

import { cn } from '@/lib/utils'
import { TabsList } from '@/components/ui/tabs'

/**
 * 下划线式标签条，外观与 `ResponsiveTabs` 一致，用于那些仅靠
 * need to interleave plain actions (e.g. "添加容器") with the triggers — which
 * `TabsList` + `TabsTrigger` 无法表达的页面。键盘导航与
 * 标签 ARIA 角色仍来自 `ui/tabs` 原语。
 */
export function TabStrip({
  className,
  ...props
}: ComponentProps<typeof TabsList>) {
  return (
    <TabsList
      className={cn(
        'min-h-11 h-auto w-full flex-wrap justify-start gap-x-4 gap-y-0 overflow-x-visible rounded-none border-b bg-transparent p-0 text-muted-foreground',
        '**:data-[slot=tabs-trigger]:h-11 **:data-[slot=tabs-trigger]:flex-none **:data-[slot=tabs-trigger]:rounded-none **:data-[slot=tabs-trigger]:border-0 **:data-[slot=tabs-trigger]:border-b-2 **:data-[slot=tabs-trigger]:border-transparent **:data-[slot=tabs-trigger]:bg-transparent **:data-[slot=tabs-trigger]:px-0 **:data-[slot=tabs-trigger]:py-0 **:data-[slot=tabs-trigger]:text-muted-foreground **:data-[slot=tabs-trigger]:shadow-none **:data-[slot=tabs-trigger]:transition-colors **:data-[slot=tabs-trigger]:hover:text-foreground **:data-[slot=tabs-trigger]:data-[state=active]:border-primary **:data-[slot=tabs-trigger]:data-[state=active]:bg-transparent **:data-[slot=tabs-trigger]:data-[state=active]:text-primary **:data-[slot=tabs-trigger]:data-[state=active]:shadow-none',
        '**:data-[slot=tabs-trigger]:dark:data-[state=active]:border-primary **:data-[slot=tabs-trigger]:dark:data-[state=active]:bg-transparent **:data-[slot=tabs-trigger]:dark:data-[state=active]:text-primary',
        className
      )}
      {...props}
    />
  )
}
