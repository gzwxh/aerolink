import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

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
}: {
  title: string
  hint?: string
  pairs: KVPair[]
  addLabel: string
  onChange: (next: KVPair[]) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="space-y-3">
      <h4 className="text-sm font-semibold">{title}</h4>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {pairs.map((pair, index) => (
        <div
          key={index}
          className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2"
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
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-destructive"
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
