import { Activity, Boxes, ExternalLink, ShieldCheck, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import aboutDetail from '@/assets/about-detail.webp'
import aboutOverview from '@/assets/about-overview.webp'
import { Button } from '@/components/ui/button'
import { useBranding } from '@/contexts/branding-context'
import { usePageTitle } from '@/hooks/use-page-title'
import { useVersionInfo } from '@/lib/api/system'

/** 能力卡：文案在 i18n 的 about.capabilities.* 下。 */
const CAPABILITIES = [
  { key: 'workspace', icon: Boxes },
  { key: 'insight', icon: Activity },
  { key: 'governance', icon: ShieldCheck },
  { key: 'assistant', icon: Sparkles },
] as const

/**
 * 关于页：`/_clusters/<slug>/about`，入口在头像菜单。
 *
 * 内容与文档站的「关于」页（docs/about.md）保持一致，但这里是控制台内的精简版：
 * 产品定位、能力清单、两张真实界面截图、版本与开源声明。
 * 截图取自本项目实际运行界面，放在 ui/src/assets/about-*.webp。
 */
export function AboutPage() {
  const { t } = useTranslation()
  const { siteName, logoUrl, helpUrl } = useBranding()
  const { data: version } = useVersionInfo()
  usePageTitle(t('about.pageTitle'))

  return (
    <div className="mx-auto w-full max-w-5xl space-y-10 p-6">
      <header className="space-y-4">
        <div className="flex items-center gap-4">
          <img src={logoUrl} alt={`${siteName} Logo`} className="h-12 w-12" />
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold">{siteName}</h1>
            <p className="text-sm text-muted-foreground">{t('about.tagline')}</p>
          </div>
        </div>
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
          {t('about.description')}
        </p>
        {version && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>{t('about.version', { version: version.version })}</span>
            {version.buildDate && (
              <span>{t('about.buildDate', { date: version.buildDate })}</span>
            )}
            {version.commitId && (
              <span className="font-mono">{version.commitId.slice(0, 8)}</span>
            )}
          </div>
        )}
      </header>

      <section className="space-y-4">
        <h2 className="text-base font-semibold">{t('about.capabilitiesTitle')}</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {CAPABILITIES.map(({ key, icon: Icon }) => (
            <div key={key} className="rounded-lg border p-4">
              <div className="flex items-center gap-2">
                <Icon className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-medium">
                  {t(`about.capabilities.${key}.title`)}
                </h3>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {t(`about.capabilities.${key}.description`)}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-base font-semibold">{t('about.screenshotsTitle')}</h2>
        <div className="space-y-6">
          <figure className="space-y-2">
            <img
              src={aboutOverview}
              alt={t('about.screenshots.overview')}
              loading="lazy"
              className="w-full rounded-lg border"
            />
            <figcaption className="text-xs text-muted-foreground">
              {t('about.screenshots.overview')}
            </figcaption>
          </figure>
          <figure className="space-y-2">
            <img
              src={aboutDetail}
              alt={t('about.screenshots.detail')}
              loading="lazy"
              className="w-full rounded-lg border"
            />
            <figcaption className="text-xs text-muted-foreground">
              {t('about.screenshots.detail')}
            </figcaption>
          </figure>
        </div>
      </section>

      <footer className="flex flex-wrap items-center justify-between gap-4 border-t pt-6">
        <p className="text-xs text-muted-foreground">{t('about.openSource')}</p>
        {helpUrl && (
          <Button variant="outline" size="sm" asChild>
            <a href={helpUrl} target="_blank" rel="noreferrer">
              {t('about.help')}
              <ExternalLink className="ml-1 h-3.5 w-3.5" />
            </a>
          </Button>
        )}
      </footer>
    </div>
  )
}
