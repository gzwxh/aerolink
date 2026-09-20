/* eslint-disable react-refresh/only-export-components */
import { useMemo, type ReactNode } from 'react'

import type { ColorTheme } from './color-theme-provider'
import { ColorThemeProvider, useColorTheme } from './color-theme-provider'
import { DisplayScaleProvider, useDisplayScale } from './display-scale-provider'
import { FontProvider, useFont } from './font-provider'
import { ThemeProvider, useTheme } from './theme-provider'

type AppearanceProviderProps = {
  children: ReactNode
  // 主题
  defaultTheme?: 'dark' | 'light' | 'system'
  themeStorageKey?: string
  // 配色主题
  defaultColorTheme?: ColorTheme
  colorThemeStorageKey?: string
  // 字体
  defaultFont?: 'system' | 'maple' | 'jetbrains'
  fontStorageKey?: string
  // 显示缩放
  defaultDisplayScale?: number
  displayScaleStorageKey?: string
}

export function AppearanceProvider({
  children,
  defaultTheme = 'system',
  themeStorageKey = 'vite-ui-theme',
  defaultColorTheme = 'default',
  colorThemeStorageKey = 'vite-ui-color-theme',
  defaultFont = 'maple',
  fontStorageKey = 'vite-ui-font',
  defaultDisplayScale = 95,
  displayScaleStorageKey = 'vite-ui-display-scale',
}: AppearanceProviderProps) {
  return (
    <ThemeProvider defaultTheme={defaultTheme} storageKey={themeStorageKey}>
      <ColorThemeProvider
        defaultColorTheme={defaultColorTheme}
        storageKey={colorThemeStorageKey}
      >
        <DisplayScaleProvider
          defaultDisplayScale={defaultDisplayScale}
          storageKey={displayScaleStorageKey}
        >
          <FontProvider defaultFont={defaultFont} storageKey={fontStorageKey}>
            {children}
          </FontProvider>
        </DisplayScaleProvider>
      </ColorThemeProvider>
    </ThemeProvider>
  )
}

export default AppearanceProvider

// 统一读取/更新所有外观设置的 hook。
export function useAppearance() {
  const { theme, actualTheme, setTheme } = useTheme()
  const { colorTheme, setColorTheme } = useColorTheme()
  const { displayScale, setDisplayScale } = useDisplayScale()
  const { font, setFont } = useFont()

  return useMemo(
    () => ({
      theme,
      actualTheme,
      setTheme,
      colorTheme,
      setColorTheme,
      displayScale,
      setDisplayScale,
      font,
      setFont,
    }),
    [
      theme,
      actualTheme,
      colorTheme,
      displayScale,
      font,
      setTheme,
      setColorTheme,
      setDisplayScale,
      setFont,
    ]
  )
}
