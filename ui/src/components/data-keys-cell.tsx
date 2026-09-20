import { useTranslation } from 'react-i18next'

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

/**
 * ConfigMap / Secret 列表里的「键」单元格。
 *
 * 键的数量与长度都不受控（集群里见过 150+ 个键的 ConfigMap），直接铺开会把整张表
 * 撑宽、逼出横向滚动条。这里只显示一行并在超长时截断，完整列表放 tooltip。
 */
export function DataKeysCell({ keys }: { keys: string[] }) {
  const { t } = useTranslation()

  if (keys.length === 0) {
    return <span className="text-muted-foreground text-sm">-</span>
  }

  const joined = keys.join(', ')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-block max-w-72 cursor-default truncate align-bottom text-left text-muted-foreground">
          {joined}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">
        <div className="font-medium">
          {t('resourceTable.keyCount', { count: keys.length })}
        </div>
        <div className="mt-1 max-h-64 overflow-y-auto break-all">{joined}</div>
      </TooltipContent>
    </Tooltip>
  )
}
