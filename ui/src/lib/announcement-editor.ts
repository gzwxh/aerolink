import {
  ANNOUNCEMENT_COLOR_NAMES,
  ANNOUNCEMENT_COLORS,
  parseAnnouncementMarkup,
  type AnnouncementSegment,
} from './announcement-markup'

/**
 * 公告正文在「存储用的标记」与「编辑器里的 HTML」之间互转。
 *
 * 存储侧始终是 `lib/announcement-markup.ts` 那套标记（`**加粗**`、`{warning}…{/warning}`），
 * 展示仍走同一条渲染链路；这里只服务于编辑器的所见即所得：进编辑器时把标记铺成带样式的
 * DOM，保存时再走回来。
 *
 * 两个方向都只认自己那一套标签：入编辑器时先转义文本（绝不用用户的 HTML），
 * 出编辑器时按标签白名单走、遇到不认识的元素只取文字。因此编辑器里无论怎么折腾，
 * 落库的永远是那套受控标记。
 */

/** 编辑器用来标记「这段是什么颜色」的属性名（序列化时据此还原成 `{color}`）。 */
export const ANNOUNCEMENT_COLOR_ATTRIBUTE = 'data-announcement-color'

const COLOR_NAMES = new Set<string>(ANNOUNCEMENT_COLOR_NAMES)

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * 会被 Markdown 解释成格式、或被我们自己的色标解析器认出来的字符。
 *
 * 编辑器里这些字符**都是能敲出来的普通字符**（星号、井号、花括号……），所以：进编辑器时
 * 要把 `\X` 还原成字面量，出编辑器时要把字面量转义成 `\X`。两条正则必须成对，否则往返
 * 一次内容就变样。
 */
// MARKDOWN_META_RE 特意带一层捕获组：替换串里的 `$1` 要引用它。没有捕获组时 `$1` 会原样
// 输出，落库内容直接变成 `\$1`（这个 bug 是被往返测试抓出来的）。
const MARKDOWN_META_RE = /([\\`*_~[\]{}|#])/g
const MARKDOWN_ESCAPE_RE = /\\([\\`*_~[\]{}|#])/g

/**
 * 文本节点里的元字符转义成 `\X`（CommonMark 的反斜杠转义）。
 *
 * 不做这一步，用户在编辑区敲的 `**`、`#`、`{warning}` 会被展示侧吃掉：编辑区显示星号，
 * 顶栏却显示加粗——「输入区里什么样、展示就什么样」这条要求最常在这里被破坏。
 * 转义后落库内容仍然是**可读的文本**（只是多了反斜杠，不是 HTML 实体）。
 */
function escapeMarkdown(text: string): string {
  return text.replace(MARKDOWN_META_RE, '\\$1')
}

/**
 * 链接标记 `[文字](地址)`。
 *
 * 负向后顾与其它行内标记一致：`\[文字\](地址)`（用户敲的字面方括号）不算链接。
 * 文字部分允许出现转义字符（`\\.`），否则带 `\]` 的标题会匹配不上。
 */
const LINK_MARKUP_RE = /(?<!\\)\[((?:\\.|[^\]\\])*)\]\(([^()\s]+)\)/g

/**
 * 只放行 http(s) 与 mailto，与 react-markdown 默认 `urlTransform` 同口径。
 *
 * 编辑器是把标记拼成 innerHTML 的，`javascript:` / `data:` 一律不生成 `<a>`：
 * 这类地址在顶栏会被 react-markdown 清空，与编辑区显示不一致，不如在写入时就不认。
 */
const ALLOWED_LINK_URL_RE = /^(https?:|mailto:)/i

export function isAllowedLinkUrl(url: string): boolean {
  return ALLOWED_LINK_URL_RE.test(url.trim())
}

/**
 * 行内标记 → HTML。文本先转义，插入的标签都是这里自己拼的。
 *
 * 标记匹配带**负向后顾** `(?<!\\)`：`\*\*`（用户敲的字面星号）不会被当成加粗。
 * 最后一步把 `\X` 还原成字面量 X —— 此时标签已经拼好，且标签里不含这些字符，不会误伤。
 *
 * 链接放在最后处理：一是标签文字里的 `**`/`` ` `` 能先按行内规则铺开，二是地址部分
 * 一旦并进 `href` 就不会再被后面的替换改形。
 */
function inlineMarkupToHtml(text: string): string {
  return escapeHtml(text)
    .replace(/\n/g, '<br>')
    .replace(/(?<!\\)\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\\)~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/(?<!\\)`([^`]+)`/g, '<code>$1</code>')
    .replace(/(?<!\\)\*([^*]+)\*/g, '<em>$1</em>')
    .replace(LINK_MARKUP_RE, (whole, label: string, url: string) =>
      // 引号也要挡掉：地址是直接拼进属性值的。
      isAllowedLinkUrl(url)
        ? `<a href="${url.replace(/"/g, '%22')}">${label}</a>`
        : whole
    )
    .replace(MARKDOWN_ESCAPE_RE, '$1')
}

/** 标记 → 编辑器 HTML（颜色段与渲染侧用同一个解析器切分，两侧口径一致，含嵌套）。 */
export function announcementMarkupToHtml(content: string): string {
  const render = (segments: AnnouncementSegment[]): string =>
    segments
      .map((segment) => {
        const inner =
          segment.children && segment.children.length > 0
            ? render(segment.children)
            : inlineMarkupToHtml(segment.text)
        // class 不能省：颜色段必须自己带样式，编辑区里才看得见颜色。
        //
        // 只写 data 属性时，**重新打开一条已有公告**的文字会是黑的——工具栏点色块那条
        // 路径是自己设 class 的（见 applyFormat），所以只有「打开旧内容」时才会露馅，
        // 表现为「编辑区没颜色、顶栏却有颜色」，两条路径必须都上色。
        return segment.color
          ? `<span ${ANNOUNCEMENT_COLOR_ATTRIBUTE}="${segment.color}" class="${ANNOUNCEMENT_COLORS[segment.color]}">${inner}</span>`
          : inner
      })
      .join('')
  return render(parseAnnouncementMarkup(content))
}

function colorOf(element: Element): string | null {
  const value = element.getAttribute(ANNOUNCEMENT_COLOR_ATTRIBUTE)
  return value && COLOR_NAMES.has(value) ? value : null
}

/**
 * 地址里会破坏 `[文字](地址)` 解析的字符转成百分号编码。
 *
 * `(`、`)` 会让配对的括号提前结束；`|` 会被 Markdown 当表格分隔（且它本身也是被转义的
 * 元字符）；空白根本进不了标记。都是编码而不是丢弃，地址还原后仍然可用。
 */
function encodeLinkUrl(href: string): string {
  return href
    .trim()
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\|/g, '%7C')
    .replace(/\s/g, '%20')
}

function serializeChildren(node: Node): string {
  return Array.from(node.childNodes).map(serializeNode).join('')
}

/** 编辑器 HTML → 标记：标签白名单，未知元素只保留文字。 */
function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return escapeMarkdown(node.nodeValue ?? '')
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return ''
  }
  const element = node as Element
  const inner = () => serializeChildren(element)
  switch (element.tagName.toLowerCase()) {
    case 'br':
      return '\n'
    case 'strong':
    case 'b':
      return `**${inner()}**`
    case 'em':
    case 'i':
      return `*${inner()}*`
    case 'del':
    case 's':
    case 'strike':
      return `~~${inner()}~~`
    case 'code':
      return `\`${inner()}\``
    case 'a': {
      const href = element.getAttribute('href') ?? ''
      // 不允许的协议（javascript:、空地址……）只保留文字：顶栏反正不会渲染这个链接。
      return isAllowedLinkUrl(href)
        ? `[${inner()}](${encodeLinkUrl(href)})`
        : inner()
    }
    // 回车在 contenteditable 里生成的是 div（部分浏览器是 p）：当作换行。
    case 'div':
    case 'p':
      return `\n${inner()}`
    case 'span':
    case 'font': {
      const color = colorOf(element)
      return color ? `{${color}}${inner()}{/${color}}` : inner()
    }
    default:
      return inner()
  }
}

export function htmlToAnnouncementMarkup(root: Node): string {
  // 块级元素会在每段前带一个换行（为了区分「段落之间」与「段落内部」），
  // 首尾多余的换行在这里收掉。
  return serializeChildren(root).replace(/^\n+/, '').replace(/\n+$/, '')
}
