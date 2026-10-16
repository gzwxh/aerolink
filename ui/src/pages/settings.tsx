import { useMemo } from 'react'
import { useAuth } from '@/contexts/auth-context'
import {
  SettingsSectionProvider,
  useSettingsSectionAccess,
} from '@/contexts/settings-section-context'
import { IconEye } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { useParams, useSearchParams } from 'react-router-dom'

import { usePageTitle } from '@/hooks/use-page-title'
import { ClusterNavigate } from '@/components/cluster-link'
import { RequireSettingsAccess } from '@/components/require-admin'
import {
  getSettingsSections,
  settingsSectionRegistry,
  settingsSubTabs,
} from '@/components/settings/settings-sections'

// 只读章节的提示：说明「能看不能改」的原因，避免用户以为是页面坏了（等保三级三权
// 分立下很常见：审计管理员只有 settings.audit 的读权限）。
function ReadOnlyNotice() {
  const { t } = useTranslation()
  const { readOnly } = useSettingsSectionAccess()
  if (!readOnly) {
    return null
  }
  return (
    <div className="mb-4 flex items-start gap-2 rounded-md border border-dashed p-3 text-xs text-muted-foreground">
      <IconEye className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        {t(
          'settings.readOnlyNotice',
          '当前角色只有本章节的查看权限，因此修改类操作已被隐藏或禁用。如需修改，请联系对应的管理员。'
        )}
      </span>
    </div>
  )
}

const DEFAULT_SECTION = 'general'

/**
 * 保持旧的 `/settings?tab=<section>` 链接可用，并把
 * 没有系统设置权限的用户送到他们可以打开的第一个分区。
 */
export function SettingsRedirect() {
  const { t } = useTranslation()
  const [searchParams] = useSearchParams()
  const { user } = useAuth()
  const params = new URLSearchParams(searchParams)
  const sections = getSettingsSections(
    t,
    (section) => user?.canViewSettingsSection(section) ?? false
  )
  const section = params.get('tab') || sections[0]?.value || DEFAULT_SECTION
  params.delete('tab')
  const query = params.toString()

  return (
    <ClusterNavigate
      to={`/settings/${section}${query ? `?${query}` : ''}`}
      replace
    />
  )
}

export function SettingsPage() {
  const { t } = useTranslation()
  const { user } = useAuth()
  const { section: sectionParam } = useParams()
  const [searchParams] = useSearchParams()
  const sections = useMemo(
    () =>
      getSettingsSections(
        t,
        (section) => user?.canViewSettingsSection(section) ?? false
      ),
    [t, user]
  )

  const requested = settingsSectionRegistry.find(
    (item) => item.value === sectionParam
  )
  const active = requested ?? sections[0]

  // 页头跟随选中的分区（及其子页面），而不是始终
  // 描述整个设置区。
  const sectionLabel = active
    ? t(active.labelKey, active.defaultLabel)
    : t('settings.title', 'System Settings')
  const subTabs = active ? settingsSubTabs[active.value] : undefined
  const currentSubTab = subTabs?.tabs.find(
    (tab) =>
      tab.value === (searchParams.get(subTabs.param) ?? subTabs.tabs[0]?.value)
  )
  const subTabLabel = currentSubTab
    ? t(currentSubTab.labelKey, currentSubTab.defaultLabel)
    : undefined
  // 子页签打开的具体记录（如某个用户组）：作为面包屑最后一段。由该页签自己写入 URL。
  const detailLabel = currentSubTab?.detailParam
    ? (searchParams.get(currentSubTab.detailParam)?.trim() ?? '')
    : ''
  usePageTitle(
    `${t('settings.title', 'System Settings')} / ${sectionLabel}${
      subTabLabel ? ` / ${subTabLabel}` : ''
    }${detailLabel ? ` / ${detailLabel}` : ''}`
  )

  if (sectionParam && !requested) {
    return (
      <ClusterNavigate
        to={`/settings/${sections[0]?.value || DEFAULT_SECTION}`}
        replace
      />
    )
  }

  if (!active) {
    return <ClusterNavigate to="/" replace />
  }

  return (
    <div className="space-y-2">
      <div className="mb-4">
        <h1 className="mb-2 flex flex-wrap items-baseline gap-2 text-3xl">
          <span className="text-muted-foreground">
            {t('settings.title', 'System Settings')}
          </span>
          <span className="text-muted-foreground/60">/</span>
          <span className={subTabLabel ? 'text-muted-foreground' : undefined}>
            {sectionLabel}
          </span>
          {subTabLabel && (
            <>
              <span className="text-muted-foreground/60">/</span>
              <span
                className={detailLabel ? 'text-muted-foreground' : undefined}
              >
                {subTabLabel}
              </span>
            </>
          )}
          {detailLabel && (
            <>
              <span className="text-muted-foreground/60">/</span>
              <span>{detailLabel}</span>
            </>
          )}
        </h1>
        <p className="text-muted-foreground">
          {t(active.descriptionKey, active.defaultDescription)}
        </p>
      </div>

      {/* 每个设置章节都按自己的章节级授权把关（与接口门禁一致）：直接输入 URL 时
          没有该章节权限的用户看到的是拒绝页，而不是内容。页面里承载了多个章节时
          （见 SettingsSectionDefinition.extraSections），持有其中之一即可打开。 */}
      <RequireSettingsAccess
        section={[active.section, ...(active.extraSections ?? [])]}
      >
        <SettingsSectionProvider section={active.section}>
          <ReadOnlyNotice />
          {active.render()}
        </SettingsSectionProvider>
      </RequireSettingsAccess>
    </div>
  )
}
