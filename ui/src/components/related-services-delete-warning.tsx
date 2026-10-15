import { useTranslation } from 'react-i18next'

/**
 * 删除工作负载弹窗里的联动提醒：列出将随工作负载一并删除的关联 Service。
 * 名单由调用方按「Service 的选择器指向该工作负载」算出并做权限过滤，
 * 空名单不渲染。
 */
export function RelatedServicesDeleteWarning({ names }: { names: string[] }) {
  const { t } = useTranslation()
  if (!names.length) return null
  return (
    <div className="rounded-lg border border-warning/25 bg-warning/10 p-4 text-sm">
      <p className="font-medium text-warning-foreground">
        {t('deleteConfirmation.relatedServicesTitle')}
      </p>
      <ul className="mt-2 list-disc space-y-0.5 pl-5">
        {names.map((name) => (
          <li key={name} className="font-mono text-warning-foreground">
            {name}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">
        {t('deleteConfirmation.relatedServicesHint')}
      </p>
    </div>
  )
}
