import { Table } from '@tanstack/react-table'
import { Settings2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface TableColumnToggleProps<T> {
  table: Table<T>
  className?: string
}

/**
 * 表格右上角的「显示哪些列」齿轮菜单。
 *
 * 与资源列表（/deployments 等）用的是同一套交互与文案，设置页的表格复用它可以保持
 * 整个控制台一致。列的显示状态由调用方决定是否持久化（见各页面里的 columnVisibility）。
 */
export function TableColumnToggle<T>({
  table,
  className,
}: TableColumnToggleProps<T>) {
  const { t } = useTranslation()
  // 结构性列（例如勾选框、操作列）会声明 enableHiding: false，不出现在这里。
  const hideableColumns = table
    .getAllLeafColumns()
    .filter((column) => column.getCanHide())

  if (hideableColumns.length === 0) {
    return null
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className={className}
          aria-label={t('resourceTable.toggleColumns', 'Toggle columns')}
        >
          <Settings2 className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>
          {t('resourceTable.toggleColumns', 'Toggle columns')}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {hideableColumns.map((column) => {
          const header = column.columnDef.header
          const headerText = typeof header === 'string' ? header : column.id

          return (
            <DropdownMenuCheckboxItem
              key={column.id}
              // 列 id 兜底显示时是小写英文（如 ready），中文/已本地化的表头不受影响。
              className="capitalize"
              checked={column.getIsVisible()}
              onCheckedChange={(value) => column.toggleVisibility(!!value)}
            >
              {headerText}
            </DropdownMenuCheckboxItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
