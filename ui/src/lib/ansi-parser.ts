/* eslint-disable no-control-regex */
/**
 * 用于终端输出的简易 ANSI 转义序列解析器
 * 支持基础颜色码与格式
 */

// ANSI 颜色码映射
const ANSI_COLORS = {
  // 标准颜色（30-37、90-97）
  30: '#000000', // black
  31: '#cd3131', // red
  32: '#0dbc79', // green
  33: '#e5e510', // yellow
  34: '#2472c8', // blue
  35: '#bc3fbc', // magenta
  36: '#11a8cd', // cyan
  37: '#e5e5e5', // white

  // 高亮颜色（90-97）
  90: '#666666', // bright black (gray)
  91: '#f14c4c', // bright red
  92: '#23d18b', // bright green
  93: '#f5f543', // bright yellow
  94: '#3b8eea', // bright blue
  95: '#d670d6', // bright magenta
  96: '#29b8db', // bright cyan
  97: '#ffffff', // bright white
} as const

// 背景颜色（40-47、100-107）
const ANSI_BG_COLORS = {
  40: '#000000', // black
  41: '#cd3131', // red
  42: '#0dbc79', // green
  43: '#e5e510', // yellow
  44: '#2472c8', // blue
  45: '#bc3fbc', // magenta
  46: '#11a8cd', // cyan
  47: '#e5e5e5', // white

  100: '#666666', // bright black
  101: '#f14c4c', // bright red
  102: '#23d18b', // bright green
  103: '#f5f543', // bright yellow
  104: '#3b8eea', // bright blue
  105: '#d670d6', // bright magenta
  106: '#29b8db', // bright cyan
  107: '#ffffff', // bright white
} as const

export interface AnsiState {
  color?: string
  backgroundColor?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
}

interface ParsedSegment {
  text: string
  styles: AnsiState
}

/**
 * 解析字符串中的 ANSI 转义序列，并返回带样式的片段
 */
export function parseAnsi(
  text: string,
  initialState: AnsiState = {}
): { segments: ParsedSegment[]; finalState: AnsiState } {
  const segments: ParsedSegment[] = []
  let currentState: AnsiState = { ...initialState }
  let currentText = ''

  // 匹配 ANSI 转义序列的正则——使用 Unicode 转义而不是十六进制
  const ansiRegex = new RegExp('\u001b\\[([0-9;]*)m', 'g')
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = ansiRegex.exec(text)) !== null) {
    // 加入转义序列之前的文本
    const textBeforeEscape = text.slice(lastIndex, match.index)
    if (textBeforeEscape) {
      currentText += textBeforeEscape
    }

    // 处理该转义序列
    const codes = match[1] ? match[1].split(';').map(Number) : [0]
    const newState = processAnsiCodes(codes, { ...currentState })

    // 若已累积文本，则用之前的状态生成一个片段
    if (currentText) {
      segments.push({
        text: currentText,
        styles: { ...currentState },
      })
      currentText = ''
    }

    currentState = newState
    lastIndex = match.index + match[0].length
  }

  // 加入剩余文本
  const remainingText = text.slice(lastIndex)
  if (remainingText) {
    currentText += remainingText
  }

  // 若仍有文本，加入最后一个片段
  if (currentText) {
    segments.push({
      text: currentText,
      styles: { ...currentState },
    })
  }

  if (!text.includes('\b') && !text.includes('\r')) {
    return { segments, finalState: currentState }
  }

  const cells: ParsedSegment[] = []
  let cursor = 0
  let lineStart = 0

  for (const segment of segments) {
    for (const character of segment.text) {
      if (character === '\b') {
        cursor = Math.max(lineStart, cursor - 1)
        continue
      }
      if (character === '\r') {
        cursor = lineStart
        continue
      }
      if (character === '\n') {
        cells.push({ text: character, styles: segment.styles })
        cursor = cells.length
        lineStart = cursor
        continue
      }

      const cell = { text: character, styles: segment.styles }
      if (cursor < cells.length) {
        cells[cursor] = cell
      } else {
        cells.push(cell)
      }
      cursor++
    }
  }

  const normalizedSegments: ParsedSegment[] = []
  for (const cell of cells) {
    const previous = normalizedSegments[normalizedSegments.length - 1]
    if (
      previous &&
      previous.styles.color === cell.styles.color &&
      previous.styles.backgroundColor === cell.styles.backgroundColor &&
      previous.styles.bold === cell.styles.bold &&
      previous.styles.italic === cell.styles.italic &&
      previous.styles.underline === cell.styles.underline
    ) {
      previous.text += cell.text
    } else {
      normalizedSegments.push({ text: cell.text, styles: cell.styles })
    }
  }

  return { segments: normalizedSegments, finalState: currentState }
}

/**
 * 处理 ANSI 码并更新状态
 */
function processAnsiCodes(codes: number[], currentState: AnsiState): AnsiState {
  let newState = { ...currentState }

  for (const code of codes) {
    switch (code) {
      case 0: // Reset all
        newState = {}
        break

      case 1: // Bold
        newState.bold = true
        break

      case 3: // Italic
        newState.italic = true
        break

      case 4: // Underline
        newState.underline = true
        break

      case 22: // Normal intensity (not bold)
        newState.bold = false
        break

      case 23: // Not italic
        newState.italic = false
        break

      case 24: // Not underlined
        newState.underline = false
        break

      case 39: // Default foreground color
        delete newState.color
        break

      case 49: // Default background color
        delete newState.backgroundColor
        break

      default:
        // 前景色
        if (ANSI_COLORS[code as keyof typeof ANSI_COLORS]) {
          newState.color = ANSI_COLORS[code as keyof typeof ANSI_COLORS]
        }
        // 背景色
        else if (ANSI_BG_COLORS[code as keyof typeof ANSI_BG_COLORS]) {
          newState.backgroundColor =
            ANSI_BG_COLORS[code as keyof typeof ANSI_BG_COLORS]
        }
        break
    }
  }

  return newState
}

/**
 * 把 AnsiState 转换为 CSS 样式
 */
export function ansiStateToCss(state: AnsiState): React.CSSProperties {
  const styles: React.CSSProperties = {}

  if (state.color) {
    styles.color = state.color
  }

  if (state.backgroundColor) {
    styles.backgroundColor = state.backgroundColor
  }

  if (state.bold) {
    styles.fontWeight = 'bold'
  }

  if (state.italic) {
    styles.fontStyle = 'italic'
  }

  if (state.underline) {
    styles.textDecoration = 'underline'
  }

  return styles
}

/**
 * 从文本中剥离 ANSI 转义序列
 */
export function stripAnsi(text: string): string {
  return text.replace(new RegExp('\u001b\\[[0-9;]*m', 'g'), '')
}

/**
 * 为 AnsiState 生成 CSS 类名
 */
export function getAnsiClassNames(state: AnsiState): string {
  const classes: string[] = []

  if (state.color) {
    // 查找该颜色对应的码
    const code = Object.entries(ANSI_COLORS).find(
      ([, value]) => value === state.color
    )?.[0]
    if (code) classes.push(`ansi-fg-${code}`)
  }

  if (state.backgroundColor) {
    const code = Object.entries(ANSI_BG_COLORS).find(
      ([, value]) => value === state.backgroundColor
    )?.[0]
    if (code) classes.push(`ansi-bg-${code}`)
  }

  if (state.bold) classes.push('ansi-bold')
  if (state.italic) classes.push('ansi-italic')
  if (state.underline) classes.push('ansi-underline')

  return classes.join(' ')
}

/**
 * 为所有 ANSI 类生成 CSS 样式
 */
export function generateAnsiCss(): string {
  let css = ''

  // 前景色
  Object.entries(ANSI_COLORS).forEach(([code, color]) => {
    css += `.ansi-fg-${code} { color: ${color} !important; }\n`
  })

  // 背景色
  Object.entries(ANSI_BG_COLORS).forEach(([code, color]) => {
    css += `.ansi-bg-${code} { background-color: ${color} !important; }\n`
  })

  // 样式
  css += '.ansi-bold { font-weight: bold !important; }\n'
  css += '.ansi-italic { font-style: italic !important; }\n'
  css += '.ansi-underline { text-decoration: underline !important; }\n'

  return css
}
