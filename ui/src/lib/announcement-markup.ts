/**
 * 通知栏公告正文的颜色标记，以及级别 / 色名到语义 token 的映射。
 *
 * 管理员在正文里写 `{warning}今晚停服{/warning}`，这里把它切成「带语义色的段」交给
 * ReactMarkdown 渲染。刻意不用 HTML、也不接受任意色值：
 *
 * - 没有 HTML 就没有注入面（渲染侧是 React 元素，不做 dangerouslySetInnerHTML）；
 * - 色名/级别名映射到既有语义 token，因此自动跟随 7 套配色主题与深浅色，
 *   并落在 theme-contrast.test.ts 断言的对比度范围内（见 AGENTS.md 的状态色规则）。
 *
 * 解析失败一律「按原文显示」，不报错也不丢内容：管理员写错标记时能在预览里直接看见。
 *
 * **支持嵌套**（2026-09-21 修正）：编辑器是 contentEditable，给一句话里几个字再单独上色时
 * 产生的就是严格嵌套的 DOM（`<span danger>A<span info>B</span>C</span>`）。早先的实现用
 * 非贪婪正则匹配「最近的同类闭合」，嵌套时会把内层标记当字面量显示出来——预览里直接看到
 * `{info}` 字样，与编辑器里的样子对不上。现在改为扫描 + 栈式配对，嵌套按树处理。
 */

/** 允许的具名颜色 → 语义 token 工具类。取值改动要同步 base.css 的 @theme 声明。 */
export const ANNOUNCEMENT_COLORS = {
  primary: 'text-primary',
  muted: 'text-muted-foreground',
  info: 'text-info',
  success: 'text-success',
  warning: 'text-warning',
  attention: 'text-attention',
  danger: 'text-destructive',
} as const

export type AnnouncementColor = keyof typeof ANNOUNCEMENT_COLORS

/**
 * 色名 → **背景**工具类，供取色板里的色块使用。
 *
 * 正文上色用的是 `ANNOUNCEMENT_COLORS`（前景 token），而色板要点出一块实心颜色给人挑，
 * 所以另立一份 `bg-*` 映射。两份都指向同一批语义 token，因此色块与上色结果**必然同色**，
 * 也不会在切换配色主题 / 深浅色时和正文对不上。
 *
 * `danger` 的前景 token 是 destructive，背景同样是 destructive：语义色里没有单独的
 * "danger" 变量，两处都引用它。
 */
export const ANNOUNCEMENT_COLOR_SWATCHES: Record<AnnouncementColor, string> = {
  primary: 'bg-primary',
  muted: 'bg-muted-foreground',
  info: 'bg-info',
  success: 'bg-success',
  warning: 'bg-warning',
  attention: 'bg-attention',
  danger: 'bg-destructive',
}

/**
 * 取色板里的排列顺序：按色相分组（暖 → 冷 → 中性），4 个一行刚好两行。
 *
 * 与 `ANNOUNCEMENT_COLOR_NAMES`（对象的键序，用于遍历）分开：键序是"加一个色名"的历史
 * 顺序，不适合当界面顺序——色板一眼扫过去时按色相走才找得到想用的颜色。
 */
export const ANNOUNCEMENT_COLOR_PALETTE: AnnouncementColor[] = [
  'danger',
  'warning',
  'success',
  'attention',
  'info',
  'primary',
  'muted',
]

/** 公告级别：只决定喇叭图标的颜色（与后端 model 一致）。 */
export type AnnouncementLevel = 'info' | 'warning' | 'danger'

/**
 * 级别 → 图标色的语义 token。
 *
 * 刻意不加底色/描边：通知栏是顶栏里的一行文字，外面套个色框会很抢眼（见
 * plans/2026-09-21-announcement-bar.md §12.7）；强度靠图标颜色区分就够。
 */
export const ANNOUNCEMENT_LEVEL_ICONS: Record<AnnouncementLevel, string> = {
  info: 'text-info',
  warning: 'text-warning',
  danger: 'text-destructive',
}

/** 供界面提示「可用标记」使用的色名清单（顺序即展示顺序）。 */
export const ANNOUNCEMENT_COLOR_NAMES = Object.keys(
  ANNOUNCEMENT_COLORS
) as AnnouncementColor[]

export interface AnnouncementSegment {
  /** 段内原文（未做任何改写，Markdown 与未识别的标记都保持原样）。 */
  text: string
  /** 该段的语义色；未标注时为 undefined（继承外层文字颜色）。 */
  color?: AnnouncementColor
  /**
   * 嵌套的子段：仅当「色段里还套着色段」时非空。此时 `text` 为空、内容全在 children 里，
   * 渲染侧递归展开，因此嵌套标记能正确着色而不是显示成字面量。
   */
  children?: AnnouncementSegment[]
}

/** 一个颜色标记 token（开或闭）。 */
interface MarkerToken {
  kind: 'open' | 'close'
  name: AnnouncementColor
  /** 标记在原文中的起止下标。 */
  start: number
  end: number
  /** 配对成功的另一端在 tokens 里的下标；未配对为 -1（按原文处理）。 */
  pair: number
}

function isAnnouncementColor(value: string): value is AnnouncementColor {
  return Object.prototype.hasOwnProperty.call(ANNOUNCEMENT_COLORS, value)
}

/**
 * 扫描出所有颜色标记，并用栈把配对关系标注出来。
 *
 * 严格嵌套才算配对（只认栈顶同名）：这样 `{a}x{/b}`、`{a}x{b}y{/a}z{/b}` 这类手写错的
 * 交叉标记会**整体按原文显示**，而不是被硬凑成一个跨区间的色段——后者会让管理员以为
 * 标记生效了，实际结构已经乱了。contentEditable 产出的 DOM 天然是树，永远满足严格嵌套，
 * 因此正常路径不受这条限制影响。
 */
function scanMarkers(content: string): MarkerToken[] {
  const tokens: MarkerToken[] = []
  // 负向后顾：`\{warning}` 是用户敲的字面花括号（编辑器序列化时会转义），不是色标。
  const pattern = /(?<!\\)\{(\/?)([a-z][a-z-]*)\}/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(content)) !== null) {
    const name = match[2]
    // 未登记的色名（含写错的）：整段标记按原文保留，不能只留下内容而吃掉标记，
    // 否则管理员看不到自己写错了什么。
    if (!isAnnouncementColor(name)) {
      continue
    }
    tokens.push({
      kind: match[1] === '/' ? 'close' : 'open',
      name,
      start: match.index,
      end: match.index + match[0].length,
      pair: -1,
    })
  }

  const stack: number[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.kind === 'open') {
      stack.push(i)
      continue
    }
    const top = stack[stack.length - 1]
    if (top === undefined || tokens[top].name !== token.name) {
      // 闭标记和栈顶不是同一个色名：交叉或多余的闭合，留给「按原文显示」处理。
      continue
    }
    token.pair = top
    tokens[top].pair = i
    stack.pop()
  }
  return tokens
}

/** 递归构造 `[from, to)` 区间内的片段树。 */
function buildSegments(
  content: string,
  tokens: MarkerToken[],
  from: number,
  to: number
): AnnouncementSegment[] {
  const segments: AnnouncementSegment[] = []
  let cursor = from

  for (const token of tokens) {
    if (token.kind !== 'open' || token.pair < 0) {
      continue
    }
    const close = tokens[token.pair]
    // 只处理完整落在当前区间里、且还没被消费掉的配对。
    if (token.start < cursor || close.end > to) {
      continue
    }

    if (token.start > cursor) {
      segments.push({ text: content.slice(cursor, token.start) })
    }

    const children = buildSegments(content, tokens, token.end, close.start)
    // 内层没有嵌套时省掉一层容器，让结果与「不支持嵌套」时代保持同形（调用方与快照更稳）。
    if (children.length === 1 && !children[0].color) {
      segments.push({ text: children[0].text, color: token.name })
    } else {
      segments.push({ text: '', color: token.name, children })
    }
    cursor = close.end
  }

  if (cursor < to) {
    segments.push({ text: content.slice(cursor, to) })
  }
  return segments.filter(
    (segment) => segment.text !== '' || (segment.children?.length ?? 0) > 0
  )
}

/**
 * 段文本里残留的「已登记色标」= 配对失败的孤儿标记。
 *
 * `buildSegments` 只把**配对成功**的标记切成了色段，所以留在文本里的已登记标记必然是没配上的
 * （交叉嵌套、反复上色/取消留下的畸形数据）。它们不该以字面 `{danger}` 出现在编辑区或顶栏里
 * ——那不是管理员写的内容；更要紧的是，编辑器再保存一次会把这个字面量**转义**成 `\{danger\}`，
 * 让数据越修越脏，所以必须在解析这一步就吃掉。
 *
 * **未登记的色名保持原样**（如 `{rainbow}`）：那是管理员自己写错的，要让他看得见。
 */
const ORPHAN_COLOR_MARKER_RE = new RegExp(
  `(?<!\\\\)\\{/?(${ANNOUNCEMENT_COLOR_NAMES.join('|')})\\}`,
  'g'
)

/** 递归剔除段树里的孤儿色标（只在有值时带 color / children，保持段的形状不变）。 */
function stripOrphanColorMarkers(
  segments: AnnouncementSegment[]
): AnnouncementSegment[] {
  return segments.map((segment) => {
    const next: AnnouncementSegment = {
      text: segment.text.replace(ORPHAN_COLOR_MARKER_RE, ''),
    }
    if (segment.color) {
      next.color = segment.color
    }
    if (segment.children) {
      next.children = stripOrphanColorMarkers(segment.children)
    }
    return next
  })
}

/** 把带颜色标记的正文切成若干段（支持嵌套）；不含标记时返回单个纯文本段。 */
export function parseAnnouncementMarkup(
  content: string
): AnnouncementSegment[] {
  // 剔除孤儿标记后可能空掉（例如整段就是 `{danger}{/danger}`），再滤一次。
  return stripOrphanColorMarkers(
    buildSegments(content, scanMarkers(content), 0, content.length)
  ).filter(
    (segment) => segment.text !== '' || (segment.children?.length ?? 0) > 0
  )
}

/**
 * 把正文压成一行纯文本：去掉颜色标记、合并空白。
 * 用于滚动条目的 `title` 全文提示，以及无障碍标签。
 */
export function announcementPlainText(content: string): string {
  const collect = (segments: AnnouncementSegment[]): string =>
    segments
      .map(
        (segment) =>
          segment.text + (segment.children ? collect(segment.children) : '')
      )
      .join('')
  return collect(parseAnnouncementMarkup(content)).replace(/\s+/g, ' ').trim()
}
