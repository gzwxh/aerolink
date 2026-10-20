import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type ReactNode,
} from 'react'
import {
  Bold,
  ChevronDown,
  Code,
  Italic,
  Link2,
  RemoveFormatting,
  Strikethrough,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
  ANNOUNCEMENT_COLOR_ATTRIBUTE,
  announcementMarkupToHtml,
  htmlToAnnouncementMarkup,
  isAllowedLinkUrl,
} from '@/lib/announcement-editor'
import {
  ANNOUNCEMENT_COLOR_PALETTE,
  ANNOUNCEMENT_COLOR_SWATCHES,
  ANNOUNCEMENT_COLORS,
  type AnnouncementColor,
} from '@/lib/announcement-markup'
import { cn } from '@/lib/utils'

import { AnnouncementContent } from './announcement-content'

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

type InlineFormat = 'strong' | 'em' | 'del' | 'code'

/**
 * 编辑模式。
 *
 * `rich` 是所见即所得（元字符按字面量转义，敲 `**` 显示 `**`）；`markdown` 是源码模式，
 * 直接写/粘贴 Markdown 并按最终效果预览。两者互斥而不是「边打边解释」：后者会让输入区
 * 和展示侧对不上（见 plans/2026-09-21-顶部通知栏.md §12.13、plans/2026-10-20-…）。
 */
type EditorMode = 'rich' | 'markdown'

/** 「清除格式」要拆掉的行内包装（含颜色段与链接，文字本身保留）。 */
const FORMAT_SELECTOR = `strong, em, del, code, a, [${ANNOUNCEMENT_COLOR_ATTRIBUTE}]`

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
  // 编辑模式只在本次编辑会话里有效（不落库）：打开哪条公告都用默认的所见即所得。
  const [mode, setMode] = useState<EditorMode>('rich')
  // 链接面板：展开那一刻把选区存下来——面板里的输入框会抢走焦点，之后再取就没了。
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkHref, setLinkHref] = useState('')
  const linkPanelRef = useRef<HTMLDivElement>(null)
  const linkTriggerRef = useRef<HTMLButtonElement>(null)
  const linkRangeRef = useRef<Range | null>(null)

  // 点面板外面 / 按 Esc 收起取色板与链接面板。
  //
  // 用 pointerdown 而不是 click：click 要等到 mouseup 才触发，中间这段时间选区已经变了，
  // 会出现「面板还开着、颜色却没了」。Esc 是弹层的基本预期，一并处理。
  useEffect(() => {
    if (!paletteOpen && !linkOpen) {
      return
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (
        paletteRef.current?.contains(target) ||
        colorTriggerRef.current?.contains(target) ||
        linkPanelRef.current?.contains(target) ||
        linkTriggerRef.current?.contains(target)
      ) {
        return
      }
      setPaletteOpen(false)
      setLinkOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPaletteOpen(false)
        setLinkOpen(false)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [paletteOpen, linkOpen])

  // 首帧与「切回所见即所得」时铺内容，之后这棵子树由本组件自己管：不能交给 React 渲染
  // （用 dangerouslySetInnerHTML 时，父组件每次重渲染都会把它重置回初值，
  // 表现为「点加粗没反应」）。
  //
  // 依赖 `mode` 而不是空数组：模式切换会重挂载输入区，但组件本身没有卸载，空数组的
  // effect 不会再跑，输入区会是空白。这里读 `value` 而不是 `lastValueRef`——源码模式
  // 里的改动没经过 emitChange，ref 停在切过去之前的值。
  useLayoutEffect(() => {
    if (mode !== 'rich') {
      return
    }
    const node = editorRef.current
    if (!node) {
      return
    }
    node.innerHTML = announcementMarkupToHtml(value)
    lastValueRef.current = value
    // 只在换模式时重铺；value 的后续变化交给下面那个 effect（每敲一个字重设 innerHTML 会丢光标）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

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

  /** 切换编辑模式，顺手收起两个浮层（它们都锚在所见即所得工具栏上）。 */
  const switchMode = (next: EditorMode) => {
    if (next === mode) {
      return
    }
    setPaletteOpen(false)
    setLinkOpen(false)
    setMode(next)
  }

  /** 展开链接面板，并把当前选区存下来（面板里的输入框会抢焦点）。 */
  const openLinkPanel = () => {
    const node = editorRef.current
    const selection = window.getSelection()
    if (!node || !selection || selection.rangeCount === 0) {
      return
    }
    const range = selection.getRangeAt(0)
    const existing = findAncestor(
      range.startContainer,
      node,
      (element) => element.tagName.toLowerCase() === 'a'
    )
    linkRangeRef.current = range.cloneRange()
    // 光标本来就在链接里时预填地址：再点确定是改地址，而不是套一层新链接。
    setLinkHref(existing?.getAttribute('href') ?? '')
    setLinkOpen(true)
  }

  /** 把选区包成 `<a>`；选区为空（只点了光标）时用地址本身当文字。 */
  const applyLink = () => {
    const node = editorRef.current
    const range = linkRangeRef.current
    const href = linkHref.trim()
    if (!node || !range || !isAllowedLinkUrl(href)) {
      return
    }
    const existing = findAncestor(
      range.startContainer,
      node,
      (element) => element.tagName.toLowerCase() === 'a'
    )
    if (existing) {
      existing.setAttribute('href', href)
    } else {
      const link = document.createElement('a')
      link.setAttribute('href', href)
      link.setAttribute('target', '_blank')
      link.setAttribute('rel', 'noopener noreferrer')
      link.className = 'app-link'
      const contents = range.extractContents()
      if (contents.textContent?.trim()) {
        link.appendChild(contents)
      } else {
        link.appendChild(document.createTextNode(href))
      }
      range.insertNode(link)
    }
    emitChange()
    setLinkOpen(false)
    setLinkHref('')
    linkRangeRef.current = null
  }

  /** 摘掉选区里的所有行内格式（加粗/斜体/删除线/代码/颜色/链接），文字保留。 */
  const clearFormat = () => {
    const node = editorRef.current
    const selection = window.getSelection()
    if (!node || !selection || selection.rangeCount === 0) {
      return
    }
    const range = selection.getRangeAt(0)
    const targets = Array.from(node.querySelectorAll(FORMAT_SELECTOR)).filter(
      (element) => range.intersectsNode(element)
    )
    if (targets.length === 0) {
      return
    }
    // 嵌套时外层解包会把内层带到上层，`unwrap` 对已脱离文档的节点是空操作，因此无需排序。
    for (const element of targets) {
      unwrap(element)
    }
    emitChange()
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

  // 模式切换放在工具栏上面一行：它决定下面出现哪一套输入界面，不属于「格式」按钮。
  const modeToggle = (
    <div
      role="group"
      aria-label={t('notifications.announcements.toolbar.mode', '编辑模式')}
      className="flex w-max items-center gap-0.5 rounded-md border border-input p-0.5"
    >
      {(
        [
          [
            'rich',
            t('notifications.announcements.toolbar.richText', '所见即所得'),
          ],
          [
            'markdown',
            t('notifications.announcements.toolbar.markdown', 'Markdown'),
          ],
        ] as const
      ).map(([value, label]) => (
        <button
          key={value}
          type="button"
          disabled={disabled}
          onClick={() => switchMode(value)}
          aria-pressed={mode === value}
          className={cn(
            'rounded-sm px-2 py-0.5 text-xs transition-colors disabled:opacity-50',
            mode === value
              ? 'bg-accent text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          )}
          data-editor-mode={value}
        >
          {label}
        </button>
      ))}
    </div>
  )

  return (
    <div className="space-y-1.5">
      {modeToggle}
      {mode === 'rich' ? (
        // 两套界面靠 key 区分：不加的话 React 会把「输入区 div」和「预览 div」当成同一个
        // 节点复用，切回所见即所得时输入区里还留着预览的 DOM（或者反过来）。
        <div key="rich" className="space-y-1.5">
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
                title={t(
                  'notifications.announcements.toolbar.color',
                  '文字颜色'
                )}
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
                        aria-label={t(
                          `notifications.announcements.colors.${name}`
                        )}
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
                    <span
                      aria-hidden
                      className="size-4 rounded-sm bg-foreground"
                    />
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
            {toolbarButton(
              t('notifications.announcements.toolbar.code', '行内代码'),
              <Code className="size-3.5" />,
              'code'
            )}

            {/* 链接和「清除格式」是即时动作，不像加粗那样点第二次取消，所以不用 toolbarButton。 */}
            <div className="relative">
              <button
                ref={linkTriggerRef}
                type="button"
                disabled={disabled}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (linkOpen) {
                    setLinkOpen(false)
                    return
                  }
                  openLinkPanel()
                }}
                aria-label={t(
                  'notifications.announcements.toolbar.link',
                  '链接'
                )}
                aria-expanded={linkOpen}
                title={t('notifications.announcements.toolbar.link', '链接')}
                className="flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                data-link-trigger
              >
                <Link2 className="size-3.5" />
              </button>

              {linkOpen ? (
                <div
                  ref={linkPanelRef}
                  role="group"
                  aria-label={t(
                    'notifications.announcements.toolbar.link',
                    '链接'
                  )}
                  className="absolute top-full left-0 z-50 mt-1 w-64 rounded-md border bg-popover p-2 shadow-md"
                >
                  <label
                    className="text-xs text-muted-foreground"
                    htmlFor="announcement-link-url"
                  >
                    {t(
                      'notifications.announcements.toolbar.linkUrl',
                      '链接地址'
                    )}
                  </label>
                  <input
                    id="announcement-link-url"
                    value={linkHref}
                    autoFocus
                    placeholder="https://"
                    onChange={(event) => setLinkHref(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        applyLink()
                      }
                    }}
                    className="mt-1 w-full rounded-sm border border-input bg-transparent px-2 py-1 text-sm outline-none focus-visible:border-ring"
                    data-link-url
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t(
                      'notifications.announcements.toolbar.linkHint',
                      '只支持 http(s):// 与 mailto: 地址；没有选中文字时会把地址本身作为链接文字。'
                    )}
                  </p>
                  <div className="mt-2 flex justify-end gap-1">
                    <button
                      type="button"
                      onClick={() => setLinkOpen(false)}
                      className="rounded-sm px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent"
                    >
                      {t('common.actions.cancel', '取消')}
                    </button>
                    <button
                      type="button"
                      disabled={!isAllowedLinkUrl(linkHref)}
                      onClick={applyLink}
                      className="rounded-sm bg-primary px-2 py-1 text-xs text-primary-foreground transition-opacity disabled:opacity-50"
                    >
                      {t('common.actions.confirm', '确定')}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>

            <button
              type="button"
              disabled={disabled}
              onMouseDown={(event) => event.preventDefault()}
              onClick={clearFormat}
              aria-label={t(
                'notifications.announcements.toolbar.clear',
                '清除格式'
              )}
              title={t('notifications.announcements.toolbar.clear', '清除格式')}
              className="flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              data-clear-format
            >
              <RemoveFormatting className="size-3.5" />
            </button>
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
            // 编辑区里的链接点了不能跳转：一次误点就会把整页带走，链接的打开留给预览和顶栏。
            onClick={(event) => {
              if ((event.target as HTMLElement).closest('a')) {
                event.preventDefault()
              }
            }}
            className={cn(
              'min-h-28 rounded-md border border-input bg-transparent px-3 py-2 text-sm break-words whitespace-pre-wrap shadow-xs transition-[color,box-shadow] outline-none',
              'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
              disabled && 'cursor-not-allowed opacity-50'
            )}
          />
          <p className="text-xs text-muted-foreground">
            {t(
              'notifications.announcements.toolbar.hint',
              '选中文字后点上面的按钮即可加粗、斜体、改颜色、加链接或行内代码，「清除格式」会去掉选中的全部样式；输入区里直接看到效果。'
            )}
          </p>
        </div>
      ) : (
        <div key="markdown" className="space-y-1.5">
          <textarea
            id={id}
            aria-labelledby={labelledBy}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            disabled={disabled}
            spellCheck={false}
            className={cn(
              'min-h-28 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm break-words shadow-xs transition-[color,box-shadow] outline-none',
              'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
              disabled && 'cursor-not-allowed opacity-50'
            )}
            data-markdown-source
          />
          {/* 源码模式下预览是必需的：输入区里是标记本身，不再是最终效果。 */}
          <div className="rounded-md border border-dashed px-3 py-2">
            <p className="text-xs text-muted-foreground">
              {t('notifications.announcements.toolbar.preview', '预览')}
            </p>
            <div className="text-sm break-words whitespace-pre-wrap">
              {value.trim() ? (
                <AnnouncementContent content={value} />
              ) : (
                <span className="text-muted-foreground">
                  {t(
                    'notifications.announcements.toolbar.previewEmpty',
                    '上面写点什么，这里会显示顶栏里的效果。'
                  )}
                </span>
              )}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {t(
              'notifications.announcements.toolbar.markdownHint',
              '源码模式按 Markdown 渲染：**加粗**、*斜体*、~~删除~~、`代码`、[链接](https://example.com)、# 标题、- 列表、> 引用。横幅只有一行，标题与列表会被压成一行显示。'
            )}
          </p>
        </div>
      )}
    </div>
  )
}
