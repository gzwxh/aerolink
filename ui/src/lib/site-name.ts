/**
 * 品牌名称的展示与长度约束。
 *
 * 侧边栏是固定宽度的（16rem），名称太长时会被 `overflow-hidden` 直接裁掉——
 * 不是省略号，是「后面的字看不见」。所以这里按显示宽度把名称折成两行，
 * 保证管理员填的名字能完整看到。
 */

/**
 * 品牌名称允许的字符数上限，与后端 `pkg/settings/handler.go` 的 `maxSiteNameLength`
 * 保持一致（两处都要改）。中文按 1 个字符算。
 */
export const SITE_NAME_MAX_LENGTH = 16

/**
 * 侧边栏一行大约能容纳的**半角**宽度：16rem 宽的侧栏扣掉左右内边距、logo（32px）
 * 与间距后约 190px，正文字号 16px，全角字符按 2 个半角算，所以约 22 个半角单位。
 * 留一点余量给不同字体与显示缩放（侧栏有 95% 之类的显示比例设置）。
 */
const SITE_NAME_LINE_WIDTH = 20

/** 估算显示宽度：全角（CJK、全角标点等）算 2，其余算 1。 */
function charWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0
  // 常见的全角区段：CJK 统一表意文字（含扩展）、全角标点、假名、韩文。
  const wide =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
  return wide ? 2 : 1
}

function displayWidth(value: string): number {
  let width = 0
  for (const char of value) {
    width += charWidth(char)
  }
  return width
}

/** 可以在这里断开、断在它后面更自然的字符（空格与常见分隔符）。 */
const BREAK_AFTER = /[\s·・\-_/|.]+$/
/** 更希望断在它前面的字符（收尾括号之类），命中时稍微扣分。 */
const BREAK_BEFORE = /^[)）】」』、，,.]/

/**
 * 把品牌名称折成 1～2 行：
 *
 * - 显示宽度够一行就原样返回；
 * - 否则在**中点附近**找最合适的断点：优先空格、`·`、`-` 这类分隔符（断在它后面），
 *   没有分隔符就按宽度对半分（中文名称很常见）。
 *
 * 只折两行：名称最多 16 个字符，两行必然放得下；折更多行侧边栏会被撑高。
 */
export function splitSiteName(name: string): string[] {
  const value = (name || '').trim()
  if (!value) {
    return ['']
  }
  if (displayWidth(value) <= SITE_NAME_LINE_WIDTH) {
    return [value]
  }

  const chars = Array.from(value)
  const totalWidth = displayWidth(value)
  let width = 0
  let bestIndex = 0
  let bestScore = Number.POSITIVE_INFINITY

  // 在 [1, chars.length-1] 之间挑断点：两行都不能是空的。
  for (let index = 1; index < chars.length; index += 1) {
    width += charWidth(chars[index - 1])
    const before = chars.slice(0, index).join('')
    const boundaryBonus = BREAK_AFTER.test(before)
      ? 0
      : BREAK_BEFORE.test(chars[index])
        ? 2
        : 6
    const score = Math.abs(width - totalWidth / 2) + boundaryBonus
    if (score < bestScore) {
      bestScore = score
      bestIndex = index
    }
  }

  const first = chars.slice(0, bestIndex).join('').trim()
  const second = chars.slice(bestIndex).join('').trim()
  return second ? [first, second] : [first]
}
