import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { converter, parse } from 'culori'
import { describe, expect, it } from 'vitest'

/*
  配色主题的对比度契约。

  `src/styles/themes/*.css` 只有 CSS 变量，没有可断言的数据结构，之前调色全靠在
  浏览器里量计算样式（见 plans/2026-09-20-default-theme-contrast-retune.md）。这里把
  那套口径落成静态断言：读 CSS 变量 → 用 culori 转 sRGB → 算 WCAG 对比度。

  口算模型：颜色先落到 sRGB、越界截断（oklch 的 chroma 可以超出 sRGB 色域，
  例如 `oklch(0.577 0.245 27.325)` 转换后有个负分量）。这是对浏览器 gamut mapping
  的保守近似，阈值按此留了余量。半透明 token（如 emerald 的 --sidebar-accent、
  各暗色主题按百分比的 --border）会先与所在表面合成再计算。
*/

const STYLES_DIR = join(process.cwd(), 'src')
const THEMES_DIR = join(STYLES_DIR, 'styles/themes')

/** 正文/说明文字的最低要求：WCAG AA 对常规字号的要求。 */
const MIN_TEXT_CONTRAST = 4.5

/**
 * 描边分两层（口径见 plans/2026-09-20-default-theme-contrast-retune.md）：
 * `--border` 是分隔线，`--input` 是表单控件边界、需比分隔线更实。
 * 区间同时挡住两种退化：与卡片同色（看不见）和过重（比表单边界还抢眼）。
 */
const BORDER_CONTRAST_RANGE = [1.1, 2.6] as const
const INPUT_CONTRAST_RANGE = [1.3, 3.2] as const
const INPUT_OVER_BORDER = 0.05

type Tokens = Record<string, string>
type Modes = { light: Tokens; dark: Tokens }

const toRgb = converter('rgb')

function parseBlocks(rawCss: string): { selector: string; tokens: Tokens }[] {
  const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '')
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
    ([, selector, body]) => {
      const tokens: Tokens = {}
      for (const declaration of body.split(';')) {
        const colon = declaration.indexOf(':')
        if (colon === -1) continue
        const name = declaration.slice(0, colon).trim()
        if (!name.startsWith('--')) continue
        tokens[name.slice(2)] = declaration.slice(colon + 1).trim()
      }
      return { selector: selector.trim(), tokens }
    }
  )
}

function loadThemes(): Record<string, Modes> {
  const themes: Record<string, Modes> = {}
  for (const file of readdirSync(THEMES_DIR).filter((f) =>
    f.endsWith('.css')
  )) {
    const light: Tokens = {}
    const darkOverrides: Tokens = {}
    for (const { selector, tokens } of parseBlocks(
      readFileSync(join(THEMES_DIR, file), 'utf8')
    )) {
      // `.dark` 块覆盖同名的浅色值；主题作用域规则（如墨绿的表头）不带变量声明，会自然跳过。
      const isDark = selector
        .split(',')
        .some((part) => part.trim().startsWith('.dark'))
      Object.assign(isDark ? darkOverrides : light, tokens)
    }
    themes[file.replace(/\.css$/, '')] = {
      light,
      dark: { ...light, ...darkOverrides },
    }
  }
  return themes
}

function resolve(value: string, tokens: Tokens, depth = 0): string {
  if (depth > 6) return value
  const match = /^var\(--([a-z0-9-]+)\)$/.exec(value.trim())
  if (match && tokens[match[1]])
    return resolve(tokens[match[1]], tokens, depth + 1)
  return value
}

type Rgba = { r: number; g: number; b: number; a: number }

function toRgba(value: string, tokens: Tokens): Rgba | null {
  const parsed = parse(resolve(value, tokens))
  if (!parsed) return null
  const { r, g, b, alpha } = toRgb(parsed)
  const clamp = (channel: number) => Math.min(255, Math.max(0, channel * 255))
  return { r: clamp(r), g: clamp(g), b: clamp(b), a: alpha ?? 1 }
}

function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1,
  }
}

function luminance({ r, g, b }: Rgba): number {
  const channel = (value: number) => {
    const scaled = value / 255
    return scaled <= 0.03928
      ? scaled / 12.92
      : ((scaled + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(foreground: Rgba, background: Rgba): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort(
    (a, b) => b - a
  )
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * 前景 / 背景的对比度。背景或前景带 alpha 时先与 `baseName` 指向的表面合成
 * （默认页面底色），这样 `rgba(255,255,255,.09)` 这类叠加填充也能量。
 */
function ratio(
  tokens: Tokens,
  foregroundName: string,
  backgroundName: string,
  baseName = 'background'
): number | null {
  const backgroundRaw = toRgba(tokens[backgroundName] ?? '', tokens)
  const foregroundRaw = toRgba(tokens[foregroundName] ?? '', tokens)
  if (!backgroundRaw || !foregroundRaw) return null
  const base = toRgba(tokens[baseName] ?? tokens.background ?? '', tokens)
  if (!base) return null
  const background =
    backgroundRaw.a >= 1 ? backgroundRaw : over(backgroundRaw, base)
  const foreground =
    foregroundRaw.a >= 1 ? foregroundRaw : over(foregroundRaw, background)
  return contrast(foreground, background)
}

/** 文字类 token 对：全部要求 ≥ AA。 */
const TEXT_PAIRS: [
  label: string,
  foreground: string,
  background: string,
  base?: string,
][] = [
  ['正文 / 页面底', 'foreground', 'background'],
  ['说明文字 / 页面底', 'muted-foreground', 'background'],
  ['说明文字 / 卡片', 'muted-foreground', 'card'],
  ['说明文字 / 沉底填充（表头、斑马行）', 'muted-foreground', 'muted'],
  ['主按钮文字 / 主按钮底', 'primary-foreground', 'primary'],
  ['次要文字 / 次按钮底', 'secondary-foreground', 'secondary'],
  ['选中项文字 / 选中底', 'accent-foreground', 'accent'],
  ['侧边栏文字 / 侧边栏底', 'sidebar-foreground', 'sidebar'],
  ['侧边栏选中文字 / 选中底', 'sidebar-primary-foreground', 'sidebar-primary'],
  [
    '侧边栏悬浮文字 / 悬浮底',
    'sidebar-accent-foreground',
    'sidebar-accent',
    'sidebar',
  ],
  ['错误提示色 / 页面底', 'destructive', 'background'],
  ['错误提示色 / 卡片', 'destructive', 'card'],
  ['危险底上的文字 / 危险底', 'destructive-foreground', 'destructive'],
]

const themes = loadThemes()
const themeNames = Object.keys(themes)
const cases = themeNames.flatMap((theme) =>
  (['light', 'dark'] as const).map((mode) => ({
    theme,
    mode,
    tokens: themes[theme][mode],
  }))
)

/** 状态色：success 正常/就绪、info 进行中、warning 需留意、attention 过渡/销毁中。 */
const STATUS_TOKENS = ['success', 'info', 'warning', 'attention'] as const
const SEMANTIC_TOKENS = [
  'destructive-foreground',
  ...STATUS_TOKENS,
  ...STATUS_TOKENS.map((token) => `${token}-foreground`),
]

/** 状态色作文字/图标时压的三类底色。 */
const STATUS_SURFACES: [label: string, token: string][] = [
  ['页面底', 'background'],
  ['卡片', 'card'],
  ['沉底填充（表头、斑马行）', 'muted'],
]

/** 软徽标的 10% 底色、25% 描边至少要看得出来（不能与卡片同色）。 */
const TINT_ALPHA = 0.1
const LINE_ALPHA = 0.25
const MIN_TINT_CONTRAST = 1.04
const MIN_LINE_CONTRAST = 1.12

/** 取某个 token 合成后的不透明色；带 alpha 时叠在 `baseName` 指向的表面上。 */
function colorOf(
  tokens: Tokens,
  name: string,
  baseName = 'background'
): Rgba | null {
  const raw = toRgba(tokens[name] ?? '', tokens)
  if (!raw) return null
  if (raw.a >= 1) return raw
  const base = colorOf(tokens, baseName)
  return base ? over(raw, base) : null
}

/** 把 token 按 alpha 叠到某个表面上（对应 `bg-success/10`、`border-success/25`）。 */
function tintOf(
  tokens: Tokens,
  name: string,
  alpha: number,
  baseName = 'card'
): Rgba | null {
  const raw = toRgba(tokens[name] ?? '', tokens)
  const base = colorOf(tokens, baseName)
  if (!raw || !base) return null
  return over({ ...raw, a: raw.a * alpha }, base)
}

describe('配色主题的 token 契约', () => {
  it.each(SEMANTIC_TOKENS)('base.css 把 --%s 映射成 --color-%s', (token) => {
    // 少这一条，组件里的 `text-success` / `hover:text-destructive-foreground` 就是死类：
    // Tailwind 只在 @theme 里声明过的命名空间下生成工具类，主题文件里写了变量也没人读。
    const base = readFileSync(join(STYLES_DIR, 'styles/base.css'), 'utf8')
    expect(base).toMatch(new RegExp(`--color-${token}:\\s*var\\(--${token}\\)`))
  })

  it.each(cases)('$theme / $mode 定义了全部语义色', ({ tokens }) => {
    expect(SEMANTIC_TOKENS.filter((token) => !tokens[token])).toEqual([])
  })

  it.each(cases)(
    '$theme / $mode 的文字对比度不低于 AA',
    ({ tokens, theme, mode }) => {
      const failures = TEXT_PAIRS.map(
        ([label, foreground, background, base]) => ({
          label,
          value: ratio(tokens, foreground, background, base),
        })
      ).filter(({ value }) => value === null || value < MIN_TEXT_CONTRAST)
      expect(
        failures.map(({ label, value }) =>
          value === null
            ? `${label}: token 未定义`
            : `${label}: ${value.toFixed(2)}`
        ),
        `${theme}/${mode} 有文字对比度不达标（要求 ≥ ${MIN_TEXT_CONTRAST}）`
      ).toEqual([])
    }
  )

  it.each(cases)(
    '$theme / $mode 的状态色可读且软底可见',
    ({ tokens, theme, mode }) => {
      const card = colorOf(tokens, 'card')
      const problems: string[] = []

      for (const status of STATUS_TOKENS) {
        const ink = colorOf(tokens, status)
        if (!ink || !card) {
          problems.push(`--${status}: token 未定义`)
          continue
        }

        // 1. 作文字/图标：压在页面底、卡片、沉底填充，以及自己的 10% 软底上
        const surfaces: [string, Rgba | null][] = [
          ...STATUS_SURFACES.map(
            ([label, token]) =>
              [label, colorOf(tokens, token)] as [string, Rgba | null]
          ),
          ['自己的软底（bg-X/10）', tintOf(tokens, status, TINT_ALPHA)],
        ]
        for (const [label, surface] of surfaces) {
          if (!surface) {
            problems.push(`${status} / ${label}: 底色未定义`)
            continue
          }
          const value = contrast(ink, surface)
          if (value < MIN_TEXT_CONTRAST) {
            problems.push(`${status} / ${label}: ${value.toFixed(2)}`)
          }
        }

        // 2. 实底徽标上的字（text-success-foreground 压 bg-success）
        const onSolid = ratio(tokens, `${status}-foreground`, status)
        if (onSolid === null || onSolid < MIN_TEXT_CONTRAST) {
          problems.push(
            `${status}-foreground / ${status}: ${onSolid === null ? '未定义' : onSolid.toFixed(2)}`
          )
        }

        // 3. 软徽标本身要看得出来：10% 底与 25% 描边不能与卡片同色
        const tint = tintOf(tokens, status, TINT_ALPHA)
        const line = tintOf(tokens, status, LINE_ALPHA)
        if (tint && contrast(tint, card) < MIN_TINT_CONTRAST) {
          problems.push(
            `软底 ${status}/10 与卡片对比度 ${contrast(tint, card).toFixed(3)} 过低`
          )
        }
        if (line && contrast(line, card) < MIN_LINE_CONTRAST) {
          problems.push(
            `软描边 ${status}/25 与卡片对比度 ${contrast(line, card).toFixed(3)} 过低`
          )
        }
      }

      expect(problems, `${theme}/${mode} 的状态色不达标`).toEqual([])
    }
  )

  it.each(cases)('$theme / $mode 的描边分两层', ({ tokens, theme, mode }) => {
    const border = ratio(tokens, 'border', 'card', 'card')
    const input = ratio(tokens, 'input', 'card', 'card')
    const label = `${theme}/${mode}`

    expect(border, `${label} --border 未定义`).not.toBeNull()
    expect(input, `${label} --input 未定义`).not.toBeNull()
    expect(
      border!,
      `${label} --border 与卡片底的对比度 ${border?.toFixed(2)} 不在 ${BORDER_CONTRAST_RANGE.join('~')}（过低看不见，过高比分隔线还重）`
    ).toBeGreaterThanOrEqual(BORDER_CONTRAST_RANGE[0])
    expect(border!).toBeLessThanOrEqual(BORDER_CONTRAST_RANGE[1])
    expect(
      input!,
      `${label} --input 与卡片底的对比度 ${input?.toFixed(2)} 不在 ${INPUT_CONTRAST_RANGE.join('~')}`
    ).toBeGreaterThanOrEqual(INPUT_CONTRAST_RANGE[0])
    expect(input!).toBeLessThanOrEqual(INPUT_CONTRAST_RANGE[1])
    expect(
      input!,
      `${label} --input 必须比 --border 更实（表单边界要看得出来）`
    ).toBeGreaterThanOrEqual(border! + INPUT_OVER_BORDER)
  })
})
