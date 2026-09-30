import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import {
  ANNOUNCEMENT_COLORS,
  parseAnnouncementMarkup,
  type AnnouncementSegment,
} from '@/lib/announcement-markup'

/**
 * 渲染一段公告正文（Markdown 子集 + 具名颜色标记）。横幅与管理页的预览共用它，
 * 保证「预览里什么样、线上就什么样」。
 *
 * 安全边界（见 plans/2026-09-21-顶部通知栏.md §5）：
 * - 不装 rehype-raw：正文里的 HTML 标签不会被当元素渲染；
 * - 不覆盖 urlTransform：react-markdown 默认只放行 https/mailto 等协议，
 *   `[x](javascript:...)` 会被清空成空链接；
 * - 元素白名单只留行内内容 + `p`（横幅是单行横幅，标题/列表/表格没有意义）；
 *   unwrapDisallowed 让被拒元素**保留文字**而不是整段消失。
 */
const markdownComponents: Components = {
  // 横幅是单行滚动，段落不能产生块级换行。
  p: 'span',
  // 只取用得到的属性：react-markdown 另外会传一个 mdast 的 node，
  // 写成 `({ node, ...props })` 再整体展开会把它抹到 DOM 上，
  // 而只用解构丢掉它又会触发 no-unused-vars。
  a: ({ href, title, children }) => (
    <a
      href={href}
      title={title}
      target="_blank"
      rel="noopener noreferrer"
      className="app-link"
    >
      {children}
    </a>
  ),
  code: ({ className, children }) => (
    <code
      className={`rounded bg-muted px-1 py-0.5 font-mono text-[0.9em] ${className ?? ''}`}
    >
      {children}
    </code>
  ),
}

const ALLOWED_ELEMENTS = ['p', 'strong', 'em', 'del', 'code', 'a', 'br']

/**
 * 横幅是单行输出，空行必须当作单个换行处理：
 * Markdown 里两个换行会切成两个段落，而段落被渲染成 `<span>`，
 * 相邻 span 之间没有空白，会把「第一段第二段」粘成一个词。
 *
 * 只合并空行、不裁掉段内空白：色段两端的空格是作者写的排版，
 * 应该保留（`a{warning} b{/warning}c` 不该变成 `abc`）。
 */
function collapseBlankLines(text: string): string {
  return text.replace(/\n{2,}/g, '\n')
}

/**
 * 递归渲染片段：色段里还可能套着色段（编辑器支持给一句话里的几个字再单独上色），
 * 所以这里按树展开，而不是只铺一层——一层的话内层标记会以字面量露出来。
 */
function renderSegments(segments: AnnouncementSegment[]): React.ReactNode {
  return segments.map((segment, index) => (
    <span
      key={index}
      className={segment.color ? ANNOUNCEMENT_COLORS[segment.color] : undefined}
    >
      {segment.children && segment.children.length > 0 ? (
        renderSegments(segment.children)
      ) : (
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          allowedElements={ALLOWED_ELEMENTS}
          unwrapDisallowed
          components={markdownComponents}
        >
          {collapseBlankLines(segment.text)}
        </ReactMarkdown>
      )}
    </span>
  ))
}

export function AnnouncementContent({
  content,
  className,
}: {
  content: string
  className?: string
}) {
  // 正文头尾的空白（textarea 里很容易留空行）整体裁一次，段内格式保持原样。
  const segments = parseAnnouncementMarkup(content.trim())
  return <span className={className}>{renderSegments(segments)}</span>
}
