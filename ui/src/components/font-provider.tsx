/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useMemo, useState } from 'react'

export type FontOption = 'system' | 'maple' | 'jetbrains' | 'serif' | 'kai'

// 中文选项把自带子集放在字体栈最前（西文与数字一并走同一套字形），
// 后面接系统自带同名族，最后是通用兜底；未安装子集时仍能出衬线/楷体效果。
const FONT_STACKS: Record<FontOption, string> = {
  system: 'var(--font-sans)',
  maple: "'Maple Mono', var(--font-sans)",
  jetbrains: "'JetBrains Mono', var(--font-sans)",
  serif: "'Kite Song SC', 'Songti SC', SimSun, 'Noto Serif CJK SC', serif",
  kai: "'Kite Kai', 'Kaiti SC', KaiTi, STKaiti, serif",
}

type FontProviderProps = {
  children: React.ReactNode
  defaultFont?: FontOption
  storageKey?: string
}

type FontProviderState = {
  font: FontOption
  setFont: (font: FontOption) => void
}

const initialState: FontProviderState = {
  font: 'maple',
  setFont: () => null,
}

const FontProviderContext = createContext<FontProviderState>(initialState)

export function FontProvider({
  children,
  defaultFont = 'maple',
  storageKey = 'vite-ui-font',
  ...props
}: FontProviderProps) {
  const [font, setFont] = useState<FontOption>(() => {
    // 存过的值可能来自已经没有的选项，这里按可用项校验一次再回落到默认值。
    const stored = localStorage.getItem(storageKey)
    return stored && stored in FONT_STACKS
      ? (stored as FontOption)
      : defaultFont
  })

  useEffect(() => {
    const root = window.document.documentElement
    root.style.setProperty('--app-font-sans', FONT_STACKS[font])
    localStorage.setItem(storageKey, font)
  }, [font, storageKey])

  const value = useMemo(
    () => ({
      font,
      setFont: (f: FontOption) => setFont(f),
    }),
    [font]
  )

  return (
    <FontProviderContext.Provider {...props} value={value}>
      {children}
    </FontProviderContext.Provider>
  )
}

export const useFont = () => {
  const context = useContext(FontProviderContext)
  if (context === undefined)
    throw new Error('useFont must be used within a FontProvider')
  return context
}
