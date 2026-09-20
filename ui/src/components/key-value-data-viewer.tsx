import { useState } from 'react'
import { IconCopy, IconEye, IconEyeOff } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { copyToClipboard } from '@/lib/clipboard'
import { Button } from '@/components/ui/button'

interface Props {
  /** 要展示的键值条目 */
  entries: Record<string, string>
  /** 为 true 时值默认模糊，可按 key 逐个显示 */
  sensitive?: boolean
  /** 为 true 时值是 base64 编码的，展示时会解码 */
  base64Encoded?: boolean
  /** 覆盖空数据时展示的"暂无条目"文案 */
  emptyMessage?: string
}

function decode(value: string) {
  try {
    return atob(value)
  } catch {
    return value
  }
}

export function KeyValueDataViewer({
  entries,
  sensitive = false,
  base64Encoded = false,
  emptyMessage,
}: Props) {
  const { t } = useTranslation()
  const keys = Object.keys(entries)
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set())

  const toggleKey = (key: string) =>
    setRevealedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })

  const toggleAll = () => {
    const allRevealed =
      keys.length > 0 && keys.every((k) => revealedKeys.has(k))
    setRevealedKeys(allRevealed ? new Set() : new Set(keys))
  }

  const copyValue = async (value: string) => {
    if (await copyToClipboard(value)) {
      toast.success(t('common.messages.copied', '已复制到剪贴板'))
    } else {
      toast.error(
        t('common.messages.copyFailed', '复制失败，请手动选择文本后复制')
      )
    }
  }

  if (keys.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {emptyMessage ?? t('keyValueDataViewer.noEntries', '暂无条目')}
      </p>
    )
  }

  const allRevealed = keys.every((k) => revealedKeys.has(k))

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          {t('keyValueDataViewer.entryCount', {
            total: keys.length,
            defaultValue: '{{total}} 个条目',
          })}
        </span>
        {sensitive && (
          <Button variant="outline" size="sm" onClick={toggleAll}>
            {allRevealed ? (
              <>
                <IconEyeOff className="h-4 w-4 mr-1" />
                {t('keyValueDataViewer.hideAll', '隐藏全部')}
              </>
            ) : (
              <>
                <IconEye className="h-4 w-4 mr-1" />
                {t('keyValueDataViewer.revealAll', '显示全部')}
              </>
            )}
          </Button>
        )}
      </div>

      <div className="space-y-2">
        {Object.entries(entries).map(([key, rawValue]) => {
          const displayValue = base64Encoded ? decode(rawValue) : rawValue
          const revealed = !sensitive || revealedKeys.has(key)

          return (
            <div key={key} className="border rounded-lg p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium font-mono">{key}</span>
                <div className="flex items-center gap-1">
                  {sensitive && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      onClick={() => toggleKey(key)}
                      title={t(
                        revealed
                          ? 'common.actions.hide'
                          : 'common.actions.show',
                        revealed ? '隐藏' : '显示'
                      )}
                    >
                      {revealed ? (
                        <IconEyeOff className="h-4 w-4" />
                      ) : (
                        <IconEye className="h-4 w-4" />
                      )}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => void copyValue(displayValue)}
                    title={t('common.actions.copy', '复制')}
                  >
                    <IconCopy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="bg-muted rounded px-3 py-2 font-mono text-xs break-all">
                <span
                  className={
                    revealed
                      ? 'whitespace-pre-wrap'
                      : 'blur-sm select-none inline'
                  }
                >
                  {displayValue}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
