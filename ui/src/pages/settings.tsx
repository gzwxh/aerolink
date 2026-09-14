import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useParams, useSearchParams } from 'react-router-dom'

import { usePageTitle } from '@/hooks/use-page-title'
import { getSettingsSections } from '@/components/settings/settings-sections'

const DEFAULT_SECTION = 'general'

/** Keeps the legacy `/settings?tab=<section>` links working. */
export function SettingsRedirect() {
  const [searchParams] = useSearchParams()
  const params = new URLSearchParams(searchParams)
  const section = params.get('tab') || DEFAULT_SECTION
  params.delete('tab')
  const query = params.toString()

  return (
    <Navigate to={`/settings/${section}${query ? `?${query}` : ''}`} replace />
  )
}

export function SettingsPage() {
  const { t } = useTranslation()
  const { section: sectionParam } = useParams()
  const sections = useMemo(() => getSettingsSections(t), [t])

  usePageTitle(t('settings.title', 'System Settings'))

  if (sectionParam && !sections.some((item) => item.value === sectionParam)) {
    return <Navigate to={`/settings/${DEFAULT_SECTION}`} replace />
  }

  const active =
    sections.find((item) => item.value === sectionParam) ?? sections[0]

  return (
    <div className="space-y-2">
      <div className="mb-4">
        <div className="flex items-center gap-3 mb-2">
          <h1 className="text-3xl">{t('settings.title', 'System Settings')}</h1>
        </div>
        <p className="text-muted-foreground">
          {t('settings.description', 'Manage clusters and system settings')}
        </p>
      </div>

      {active.render()}
    </div>
  )
}
