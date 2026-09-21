import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type ReactNode,
} from 'react'
import { Bold, ChevronDown, Italic, Strikethrough } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
  ANNOUNCEMENT_COLOR_ATTRIBUTE,
  announcementMarkupToHtml,
  htmlToAnnouncementMarkup,
} from '@/lib/announcement-editor'
import {
  ANNOUNCEMENT_COLOR_PALETTE,
  ANNOUNCEMENT_COLOR_SWATCHES,
  ANNOUNCEMENT_COLORS,
  type AnnouncementColor,
} from '@/lib/announcement-markup'
import { cn } from '@/lib/utils'

/**
 * 公告正文的编辑器：所见即所得。
 *
 * 管理员选中文字后点工具栏即可加粗/斜体/改颜色，输入区里直接看到效果，不必手写
 * `**…**` 与 `{warning}…{/warning}`。保存时由 `announcement-editor.ts` 把 DOM 序列化
 * 回那套受控标记，因此存储与展示链路没有变化（渲染侧仍是 announcement-content.tsx）。
 *
 * 这里刻意不用 `document.execCommand`（已废弃、各浏览器行为不一、jsdom 里没有实现）：
 * 加粗/颜色都是自己对选区做 Range 包裹，粘贴也自己插纯文本。带来的两个好处是行为可控
 * 且可单测——编辑器里能出现的标签只有下面这几个。
 */

type InlineFormat = 'strong' | 'em' | 'del'

/** 从选区起点向上找第一个满足条件的元素（不超过编辑器根节点）。 */
function findAncestor(
  node: Node,
  root: HTMLElement,
  matches: (element: Element) => boolean
): Element | null {
  let current: Node | null = node
  while (current && current !== root) {
    if (current.nodeType === Node.ELEMENT_NODE && matches(current as Element)) {
      return current as Element
    }
    current = current.parentNode
  }
  return null
}

function unwrap(element: Element) {
  const parent = element.parentNode
  if (!parent) {
    return
  }
  while (element.firstChild) {
    parent.insertBefore(element.firstChild, element)
  }
  parent.removeChild(element)
}

export function AnnouncementEditor({
  id,
  value,
  onChange,
  disabled,
  labelledBy,
}: {
  id?: string
  value: string
  onChange: (next: string) => void
  disabled?: boolean
  labelledBy?: string
}) {
  const { t } = useTranslation()
  const editorRef = useRef<HTMLDivElement>(null)
  // 记住最近一次「自己产出的」值：外部值与之不同（打开另一条公告、清空）时才重建 DOM，
  // 否则每敲一个字都重设 innerHTML 会把光标顶回开头。
  const lastValueRef = useRef(value)
  // 取色板：展开态 + 展开那一刻选区所在的色名（null = 没上色 = 默认颜色）。
  // 用来画 A 按钮下的那条色线，以及色板里当前色的高亮。
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [activeColor, setActiveColor] = useState<AnnouncementColor | null>(null)
  const paletteRef = useRef<HTMLDivElement>(null)
  const colorTriggerRef = useRef<HTMLButtonElement>(null)

  // 点面板外面 / 按 Esc 收起取色板。
  //
  // 用 pointerdown 而不是 click：click 要等到 mouseup 才触发，中间这段时间选区已经变了，
  // 会出现「面板还开着、颜色却没了」。Esc 是弹层的基本预期，一并处理。
  useEffect(() => {
    if (!paletteOpen) {
      return
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (
        paletteRef.current?.contains(target) ||
        colorTriggerRef.current?.contains(target)
      ) {
        return
      }
      setPaletteOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPaletteOpen(false)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [paletteOpen])

  // 首帧只铺一次内容，之后这棵子树由本组件自己管：不能交给 React 渲染
  // （用 dangerouslySetInnerHTML 时，父组件每次重渲染都会把它重置回初值，
  // 表现为「点加粗没反应」）。
  useLayoutEffect(() => {
    const node = editorRef.current
    if (node) {
      node.innerHTML = announcementMarkupToHtml(lastValueRef.current)
    }
  }, [])

  useEffect(() => {
    const node = editorRef.current
    if (!node || value === lastValueRef.current) {
      return
    }
    lastValueRef.current = value
    node.innerHTML = announcementMarkupToHtml(value)
  }, [value])

  const emitChange = useCallback(() => {
    const node = editorRef.current
    if (!node) {
      return
    }
    const markup = htmlToAnnouncementMarkup(node)
    lastValueRef.current = markup
    onChange(markup)
  }, [onChange])

  /** 选区里已有的同类格式元素；没有则返回 null（用于决定是加格式还是取消格式）。 */
  const findExistingFormat = (
    range: Range,
    matches: (element: Element) => boolean
  ) => {
    const node = editorRef.current
    if (!node) {
      return null
    }
    const start = findAncestor(range.startContainer, node, matches)
    const end = findAncestor(range.endContainer, node, matches)
    if (start && start === end) {
      return start
    }
    // 选区边界就落在编辑器根上（Ctrl+A / 全选）：此时往上找不到格式元素，
    // 但内容确实整体在里面，只有一个匹配的子元素就当作已有格式。
    if (range.startContainer === node && range.endContainer === node) {
      const children = Array.from(node.children)
      if (children.length === 1 && matches(children[0])) {
        return children[0]
      }
    }
    return null
  }

  /** 用 wrapper 包住当前选区；选区已整体处在同类格式里时改为取消该格式。 */
  const applyFormat = (
    kind: InlineFormat | AnnouncementColor,
    isColor: boolean
  ) => {
    const node = editorRef.current
    const selection = window.getSelection()
    if (!node || !selection || selection.rangeCount === 0) {
      return
    }
    const range = selection.getRangeAt(0)
    if (range.collapsed) {
      return
    }
    const matches = (element: Element) =>
      isColor
        ? element.getAttribute(ANNOUNCEMENT_COLOR_ATTRIBUTE) === kind
        : element.tagName.toLowerCase() === kind
    const existing = findExistingFormat(range, matches)
    if (existing) {
      unwrap(existing)
    } else {
      const wrapper = document.createElement(isColor ? 'span' : kind)
      if (isColor) {
        wrapper.setAttribute(ANNOUNCEMENT_COLOR_ATTRIBUTE, kind)
        wrapper.className = ANNOUNCEMENT_COLORS[kind as AnnouncementColor]
      }
      wrapper.appendChild(range.extractContents())
      range.insertNode(wrapper)
      // 保留选中状态：连续点「加粗 → 变红」时第二次要有选区可用。
      const next = document.createRange()
      next.selectNodeContents(wrapper)
      selection.removeAllRanges()
      selection.addRange(next)
    }
    emitChange()
  }

  /** 选区起点所在文字的色名；没上色返回 null（即「默认颜色」）。 */
  const colorAtSelection = (): AnnouncementColor | null => {
    const node = editorRef.current
    const selection = window.getSelection()
    if (!node || !selection || selection.rangeCount === 0) {
      return null
    }
    const colored = findAncestor(
      selection.getRangeAt(0).startContainer,
      node,
      (element) => element.hasAttribute(ANNOUNCEMENT_COLOR_ATTRIBUTE)
    )
    const name = colored?.getAttribute(ANNOUNCEMENT_COLOR_ATTRIBUTE)
    return name && name in ANNOUNCEMENT_COLORS
      ? (name as AnnouncementColor)
      : null
  }

  /** 「默认颜色」：摘掉选区里的颜色标记，文字原样保留。 */
  const clearColor = () => {
    const node = editorRef.current
    const selection = window.getSelection()
    if (!node || !selection || selection.rangeCount === 0) {
      return
    }
    const range = selection.getRangeAt(0)
    const colored = Array.from(
      node.querySelectorAll(`[${ANNOUNCEMENT_COLOR_ATTRIBUTE}]`)
    ).filter((element) => range.intersectsNode(element))
    if (colored.length === 0) {
      return
    }
    // 嵌套时内层会被外层带着解包，`unwrap` 对已脱离文档的节点是空操作，因此无需排序。
    for (const element of colored) {
      unwrap(element)
    }
    emitChange()
  }

  /**
   * 从色板里选一个颜色；选「默认颜色」（null）或再点当前色 = 取消上色。
   *
   * 与工具栏的加粗/斜体保持同一套语义：点当前样式是取消，而不是叠加一层没用的同名 span。
   */
  const pickColor = (name: AnnouncementColor | null) => {
    // 先读当前色：下面两个分支都会改动 DOM，改完再读就不是展开前的颜色了。
    const current = colorAtSelection()
    if (name === null || name === current) {
      clearColor()
      setActiveColor(null)
    } else {
      applyFormat(name, true)
      setActiveColor(name)
    }
    setPaletteOpen(false)
  }

  // 粘贴走纯文本：否则会把表格、字体、样式一并带进来（序列化时虽会丢掉，
  // 但编辑器里会先显示成一段无法解释的内容）。
  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault()
    const text = event.clipboardData.getData('text/plain')
    if (!text) {
      return
    }
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) {
      return
    }
    const range = selection.getRangeAt(0)
    range.deleteContents()
    const textNode = document.createTextNode(text)
    range.insertNode(textNode)
    range.setStartAfter(textNode)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    emitChange()
  }

  const toolbarButton = (
    label: string,
    icon: ReactNode,
    kind: InlineFormat
  ) => (
    <button
      type="button"
      disabled={disabled}
      // preventDefault：否则点击按钮会先把输入区的选区丢掉，格式就无从施加。
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => applyFormat(kind, false)}
      aria-label={label}
      title={label}
      className="flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
      data-format={kind}
    >
      {icon}
    </button>
  )

  return (
    <div className="space-y-1.5">
      <div
        role="toolbar"
        aria-label={t('notifications.announcements.toolbar.label', '格式')}
        className="relative flex items-center gap-0.5 rounded-md border border-input px-1 py-0.5"
      >
        {toolbarButton(
          t('notifications.announcements.toolbar.bold', '加粗'),
          <Bold className="size-3.5" />,
          'strong'
        )}

        {/* 颜色收进「A + 色线下拉」再弹色板，而不是把 7 个彩色 A 平铺在工具栏上：
            平铺会把工具栏撑得很长，也看不出色相顺序；色板里还能标出当前色与「默认颜色」。 */}
        <div className="relative">
          <button
            ref={colorTriggerRef}
            type="button"
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (paletteOpen) {
                setPaletteOpen(false)
                return
              }
              // 展开的那一刻读选区：此时还没有任何操作破坏它。
              setActiveColor(colorAtSelection())
              setPaletteOpen(true)
            }}
            aria-label={t(
              'notifications.announcements.toolbar.color',
              '文字颜色'
            )}
            aria-expanded={paletteOpen}
            title={t('notifications.announcements.toolbar.color', '文字颜色')}
            className="flex h-7 items-center gap-0.5 rounded-sm px-1.5 transition-colors hover:bg-accent disabled:opacity-50"
            data-color-trigger
          >
            {/* 常用文字处理器里的「A + 色线」：A 下面那条线就是当前颜色。 */}
            <span className="relative text-sm leading-none font-semibold">
              A
              <span
                aria-hidden
                className={cn(
                  'absolute inset-x-0 -bottom-1 h-[2px] rounded-full',
                  activeColor
                    ? ANNOUNCEMENT_COLOR_SWATCHES[activeColor]
                    : 'bg-foreground'
                )}
              />
            </span>
            <ChevronDown className="size-3 text-muted-foreground" />
          </button>

          {paletteOpen ? (
            <div
              ref={paletteRef}
              role="group"
              aria-label={t(
                'notifications.announcements.toolbar.colorPalette',
                '选择颜色'
              )}
              className="absolute top-full left-0 z-50 mt-1 w-max rounded-md border bg-popover p-2 shadow-md"
            >
              <div className="grid grid-cols-4 gap-1">
                {ANNOUNCEMENT_COLOR_PALETTE.map((name) => (
                  <button
                    key={name}
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => pickColor(name)}
                    aria-label={t(`notifications.announcements.colors.${name}`)}
                    aria-pressed={activeColor === name}
                    title={t(`notifications.announcements.colors.${name}`)}
                    className={cn(
                      'size-5 rounded-sm ring-offset-2 ring-offset-popover transition-shadow',
                      ANNOUNCEMENT_COLOR_SWATCHES[name],
                      activeColor === name && 'ring-2 ring-ring'
                    )}
                    data-swatch={name}
                  />
                ))}
              </div>
              <div className="my-1.5 h-px bg-border" />
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pickColor(null)}
                aria-pressed={activeColor === null}
                className="flex w-full items-center gap-1.5 rounded-sm px-1 py-0.5 text-xs transition-colors hover:bg-accent"
                data-swatch="default"
              >
                {/* 黑方块 = 不额外上色（跟随正文颜色，深浅色下自动反过来）。 */}
                <span aria-hidden className="size-4 rounded-sm bg-foreground" />
                {t(
                  'notifications.announcements.toolbar.colorDefault',
                  '默认颜色'
                )}
              </button>
            </div>
          ) : null}
        </div>

        {toolbarButton(
          t('notifications.announcements.toolbar.italic', '斜体'),
          <Italic className="size-3.5" />,
          'em'
        )}
        {toolbarButton(
          t('notifications.announcements.toolbar.strikethrough', '删除线'),
          <Strikethrough className="size-3.5" />,
          'del'
        )}
      </div>

      <div
        id={id}
        ref={editorRef}
        role="textbox"
        aria-multiline="true"
        aria-labelledby={labelledBy}
        contentEditable={!disabled}
        suppressContentEditableWarning
        onInput={emitChange}
        onPaste={handlePaste}
        onBlur={emitChange}
        className={cn(
          'min-h-28 rounded-md border border-input bg-transparent px-3 py-2 text-sm break-words whitespace-pre-wrap shadow-xs transition-[color,box-shadow] outline-none',
          'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
          disabled && 'cursor-not-allowed opacity-50'
        )}
      />
      <p className="text-xs text-muted-foreground">
        {t(
          'notifications.announcements.toolbar.hint',
          '选中文字后点上面的按钮即可加粗、斜体或改颜色，输入区里直接看到效果。'
        )}
      </p>
    </div>
  )
}
