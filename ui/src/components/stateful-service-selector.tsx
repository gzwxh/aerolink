import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useResources } from '@/lib/api'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/**
 * StatefulSet requires a governing (headless) service. Lists the services
 * available in the selected namespace.
 */
export function StatefulServiceSelector({
  namespace,
  value,
  onChange,
}: {
  namespace: string
  value: string
  onChange: (name: string) => void
}) {
  const { t } = useTranslation()
  const { data: services = [] } = useResources<'services'>(
    'services',
    namespace,
    { staleTime: 30_000 }
  )

  const names = useMemo(
    () =>
      services
        .map((s) => s.metadata?.name)
        .filter((n): n is string => !!n)
        .sort((a, b) => a.localeCompare(b)),
    [services]
  )

  return (
    <div className="space-y-1.5">
      <Label className="text-xs">
        {t('workloadWizard.serviceName', '服务名称')} *
      </Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-9">
          <SelectValue
            placeholder={t('workloadWizard.selectService', '选择服务...')}
          />
        </SelectTrigger>
        <SelectContent>
          {names.map((name) => (
            <SelectItem key={name} value={name}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        {names.length === 0
          ? t(
              'workloadWizard.noServicesHint',
              '当前命名空间下暂无 Service，请先创建对应的 Headless Service。'
            )
          : t(
              'workloadWizard.serviceHint',
              'StatefulSet 需要一个 governing Service（通常为 Headless）。'
            )}
      </p>
    </div>
  )
}
