import { useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { Minus, PanelLeftOpen, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useAppearance } from '@/components/appearance-provider'
import { ColorTheme, colorThemes } from '@/components/color-theme-provider'
import { FontOption } from '@/components/font-provider'
import { SidebarCustomizer } from '@/components/sidebar-customizer'

const DISPLAY_SCALE_MIN = 80
const DISPLAY_SCALE_MAX = 120
const DISPLAY_SCALE_STEP = 5

const FONTS: FontOption[] = ['system', 'maple', 'jetbrains', 'serif', 'kai']

type ThemeMode = 'light' | 'dark' | 'system'

const THEME_MODES: ThemeMode[] = ['light', 'dark', 'system']

/**
 * 「外观」：主题、字体、显示缩放与侧边栏定制。
 *
 * 主题 / 字体 / 缩放都存在浏览器本地（localStorage），改完立即生效，不需要保存；
 * 侧边栏定制是一个弹窗（既可从本页打开，也可从头像菜单打开）。
 */
export function AppearanceSection() {
  const { t } = useTranslation()
  const { user } = useAuth()
  const {
    theme,
    setTheme,
    colorTheme,
    setColorTheme,
    displayScale,
    setDisplayScale,
    font,
    setFont,
  } = useAppearance()
  const [scaleInput, setScaleInput] = useState(String(displayScale))

  const handleDisplayScaleChange = (nextDisplayScale: number) => {
    const clampedDisplayScale = Math.min(
      DISPLAY_SCALE_MAX,
      Math.max(DISPLAY_SCALE_MIN, nextDisplayScale)
    )
    const normalizedDisplayScale =
      Math.round(clampedDisplayScale / DISPLAY_SCALE_STEP) * DISPLAY_SCALE_STEP
    setScaleInput(String(normalizedDisplayScale))
    setDisplayScale(normalizedDisplayScale)
  }

  const commitScaleInput = () => {
    if (scaleInput.trim() === '') {
      setScaleInput(String(displayScale))
      return
    }

    const nextDisplayScale = Number(scaleInput)

    if (!Number.isFinite(nextDisplayScale)) {
      setScaleInput(String(displayScale))
      return
    }

    handleDisplayScaleChange(nextDisplayScale)
  }

  return (
    <div className="space-y-6 sm:max-w-xl">
      <div className="space-y-2">
        <Label htmlFor="appearance-theme-mode">
          {t('userMenu.themeMode', '外观模式')}
        </Label>
        <Select
          value={theme}
          onValueChange={(value) => setTheme(value as ThemeMode)}
        >
          <SelectTrigger id="appearance-theme-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {THEME_MODES.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {t(`userMenu.themeModes.${mode}`, mode)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="appearance-color-theme">
          {t('userMenu.colorTheme', '主题')}
        </Label>
        <Select
          value={colorTheme}
          onValueChange={(value) => setColorTheme(value as ColorTheme)}
        >
          <SelectTrigger id="appearance-color-theme">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(colorThemes) as ColorTheme[]).map((key) => (
              <SelectItem key={key} value={key}>
                {/* 色块直接套该配色的类名取 --primary，免得在 JS 里再抄一份颜色。 */}
                <span
                  aria-hidden="true"
                  className={`color-${key} size-3 shrink-0 rounded-full border border-border bg-primary`}
                />
                {t(`userMenu.colorThemes.${key}`, key)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="appearance-font">{t('userMenu.font', '字体')}</Label>
        <Select
          value={font}
          onValueChange={(value) => setFont(value as FontOption)}
        >
          <SelectTrigger id="appearance-font">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FONTS.map((option) => (
              <SelectItem key={option} value={option}>
                {t(`userMenu.fonts.${option}`, option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="appearance-display-scale">
          {t('userMenu.displayScale', '显示缩放')}
        </Label>
        <div className="flex items-center gap-2">
          <Button
            aria-label={t('userMenu.decreaseDisplayScale', '减小显示缩放')}
            className="size-9"
            disabled={displayScale <= DISPLAY_SCALE_MIN}
            size="icon"
            type="button"
            variant="outline"
            onClick={() =>
              handleDisplayScaleChange(displayScale - DISPLAY_SCALE_STEP)
            }
          >
            <Minus className="h-4 w-4" />
          </Button>
          <Input
            id="appearance-display-scale"
            aria-label={t('userMenu.displayScalePercent', '显示缩放百分比')}
            className="h-9 w-24 text-center tabular-nums"
            type="number"
            min={DISPLAY_SCALE_MIN}
            max={DISPLAY_SCALE_MAX}
            step={DISPLAY_SCALE_STEP}
            value={scaleInput}
            onBlur={commitScaleInput}
            onChange={(event) => setScaleInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commitScaleInput()
                event.currentTarget.blur()
              }
            }}
          />
          <Button
            aria-label={t('userMenu.increaseDisplayScale', '增大显示缩放')}
            className="size-9"
            disabled={displayScale >= DISPLAY_SCALE_MAX}
            size="icon"
            type="button"
            variant="outline"
            onClick={() =>
              handleDisplayScaleChange(displayScale + DISPLAY_SCALE_STEP)
            }
          >
            <Plus className="h-4 w-4" />
          </Button>
          <span className="text-sm text-muted-foreground">%</span>
        </div>
      </div>

      {/* 与头像菜单一致：个人布局优先，设了全局布局也保留这个入口。 */}
      {user && (
        <div className="space-y-2 border-t pt-6">
          <Label>{t('common.actions.customizeSidebar', '自定义侧边栏')}</Label>
          <div>
            <SidebarCustomizer
              trigger={
                <Button type="button" variant="outline">
                  <PanelLeftOpen className="h-4 w-4" />
                  {t('common.actions.customizeSidebar', '自定义侧边栏')}
                </Button>
              }
            />
          </div>
        </div>
      )}
    </div>
  )
}
