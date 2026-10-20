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
 * - 元素白名单只留行内内容与可退化成一行的块（见下），
 *   unwrapDisallowed 让被拒元素**保留文字**而不是整段消失。
 *
 * 块级元素（标题/列表/引用/分割线/表格）是「行内化」处理的，不是放行原标签：横幅是
 * 一行动画轨道，`<h1>`、`<ul>`、`<p>` 都会强行断行、撑高顶栏。于是标题退化成加粗、
 * 列表项加 `•` 前缀、引用变斜体、分割线变 `——`；块与块之间补一个空格，否则相邻块的
 * 文字会粘成一个词（`# 标题\n正文` 里的换行不产生空白）。
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
  h1: ({ children }) => (
    <>
      <strong>{children}</strong>{' '}
    </>
  ),
  h2: ({ children }) => (
    <>
      <strong>{children}</strong>{' '}
    </>
  ),
  h3: ({ children }) => (
    <>
      <strong>{children}</strong>{' '}
    </>
  ),
  h4: ({ children }) => (
    <>
      <strong>{children}</strong>{' '}
    </>
  ),
  h5: ({ children }) => (
    <>
      <strong>{children}</strong>{' '}
    </>
  ),
  h6: ({ children }) => (
    <>
      <strong>{children}</strong>{' '}
    </>
  ),
  // 列表容器本身不能留 `ul`/`ol` 标签：块级元素会断行，这里只当前缀（项由 li 处理）。
  ul: ({ children }) => <>{children}</>,
  ol: ({ children }) => <>{children}</>,
  // 有序列表也用点号：一行里连续写 `1. 2. 3.` 反而更难读，且列表可能被拆到不同位置。
  li: ({ children }) => (
    <>
      {'• '}
      {children}{' '}
    </>
  ),
  blockquote: ({ children }) => <span className="italic">{children} </span>,
  hr: () => <>—— </>,
  // 表格的边框/表头全丢掉，只留「单元格 + 空格」，至少不会把内容糊成一团。
  td: ({ children }) => <>{children} </>,
  th: ({ children }) => <>{children} </>,
}

const ALLOWED_ELEMENTS = [
  'p',
  'strong',
  'em',
  'del',
  'code',
  'a',
  'br',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'hr',
  'td',
  'th',
]

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
