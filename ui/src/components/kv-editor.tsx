import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

export interface KVPair {
  key: string
  value: string
}

export function KVEditor({
  title,
  hint,
  pairs,
  addLabel,
  onChange,
  multiline = false,
}: {
  title: string
  hint?: string
  pairs: KVPair[]
  addLabel: string
  onChange: (next: KVPair[]) => void
  /**
   * 值为长文本（证书、token、配置文件）时改用多行文本域：
   * 默认 3 行高、等宽字体，并且可以纵向拖拽放大看全内容。
   */
  multiline?: boolean
}) {
  const { t } = useTranslation()
  return (
    <div className="space-y-3">
      <h4 className="text-sm font-semibold">{title}</h4>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {pairs.map((pair, index) => (
        <div
          key={index}
          className={cn(
            'grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2',
            multiline ? 'items-start' : 'items-center'
          )}
        >
          <Input
            value={pair.key}
            onChange={(e) =>
              onChange(
                pairs.map((p, i) =>
                  i === index ? { ...p, key: e.target.value } : p
                )
              )
            }
            placeholder={t('workloadWizard.labelKey', '键')}
            className="h-8"
          />
          {multiline ? (
            <Textarea
              value={pair.value}
              onChange={(e) =>
                onChange(
                  pairs.map((p, i) =>
                    i === index ? { ...p, value: e.target.value } : p
                  )
                )
              }
              placeholder={t('workloadWizard.labelValue', '值')}
              className="min-h-20 resize-y py-1.5 font-mono text-xs leading-relaxed"
            />
          ) : (
            <Input
              value={pair.value}
              onChange={(e) =>
                onChange(
                  pairs.map((p, i) =>
                    i === index ? { ...p, value: e.target.value } : p
                  )
                )
              }
              placeholder={t('workloadWizard.labelValue', '值')}
              className="h-8"
            />
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-destructive"
            aria-label={t('common.actions.delete', '删除')}
            onClick={() => onChange(pairs.filter((_, i) => i !== index))}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 text-xs"
        onClick={() => onChange([...pairs, { key: '', value: '' }])}
      >
        {addLabel}
      </Button>
    </div>
  )
}
