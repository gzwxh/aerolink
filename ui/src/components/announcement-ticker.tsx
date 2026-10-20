import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { IconSpeakerphone } from '@tabler/icons-react'

import {
  ANNOUNCEMENT_LEVEL_ICONS,
  announcementPlainText,
  type AnnouncementLevel,
} from '@/lib/announcement-markup'
import {
  ANNOUNCEMENT_MIN_SCROLL_SECONDS,
  combinedScrollParams,
  pacedAnimationName,
} from '@/lib/announcement-scroll'
import type { Announcement } from '@/lib/api/announcement'

import { AnnouncementContent } from './announcement-content'

/**
 * 通知栏的一行滚动输出（喇叭图标 + 滚动文字）。
 *
 * 顶栏与管理页的预览共用这一份：两处各写一遍测量/关键帧逻辑，预览就会与真实观感
 * 慢慢走偏，那时候「预览里好好的、顶栏上不对」就成了最难查的一类问题。
 *
 * 只负责渲染，不取数据：调用侧给公告列表（预览时给一条草稿）。
 */
export function AnnouncementTicker({
  items,
  level,
}: {
  items: Announcement[]
  /** 多条同时生效时取最高的级别，由调用侧算好（预览就是草稿自己的级别）。 */
  level: AnnouncementLevel
}) {
  const {
    mode: scrollMode,
    speed: scrollSpeed,
    pauseSeconds,
    displaySeconds,
  } = combinedScrollParams(items)
  const scrolling = scrollMode !== 'none'
  const viewportRef = useRef<HTMLDivElement>(null)
  const runRef = useRef<HTMLSpanElement>(null)
  // repeat 是「一份内容要重复几次才能铺满可视区」：内容比可视区窄时必须重复，
  // 否则 translateX(-50%) 的循环里会出现一段空白。
  const [repeat, setRepeat] = useState(1)
  const [duration, setDuration] = useState(ANNOUNCEMENT_MIN_SCROLL_SECONDS)
  // 「每轮停留」用的关键帧名，按这轮实际要滚多久生成（见 lib/announcement-scroll.ts）。
  // 空串 = 用 CSS 里的连续滚动关键帧。
  const [animationName, setAnimationName] = useState('')
  // 拖动查看：悬停时动画已经暂停，因此拖动的就是一份静止的内容，
  // 不会被动画推回去（状态里只记起点，不触发重渲染）。
  const dragRef = useRef<{ startX: number; startScroll: number } | null>(null)

  // 标题与正文都可能变化，用它作为重新测量的依据（id 相同的公告被编辑后要重新算宽度；
  // 预览里的草稿没有真实 id，所以内容本身也算进 key）。
  const contentKey = items
    .map((item) => `${item.id}:${item.updatedAt}:${item.title}:${item.content}`)
    .join('|')

  useEffect(() => {
    const viewport = viewportRef.current
    const run = runRef.current
    if (!viewport || !run) {
      return
    }
    const measure = () => {
      // 量的是第一份内容（不受 repeat 影响），因此这个值稳定、不会来回振荡。
      const runWidth = run.getBoundingClientRect().width
      // 可视区不可能宽过窗口；夹一下是为了防「容器宽度由轨道内容决定」时出现的
      // 「撑宽 → 多重复几份 → 更宽」正反馈（预览曾把轨道撑到 40 万像素、7000 多份）。
      const viewportWidth = Math.min(viewport.clientWidth, window.innerWidth)
      if (runWidth <= 0 || viewportWidth <= 0) {
        return
      }
      const copies = Math.max(1, Math.ceil(viewportWidth / runWidth))
      setRepeat(copies)
      // 一轮滚多久：管理员填了「显示时长」就按它（那是明确要求，不再套 15 秒下限）；
      // 留空则按内容宽度与这条公告的滚动速度换算，并保证不低于 15 秒，否则短内容一闪而过。
      const scrollSeconds =
        displaySeconds > 0
          ? displaySeconds
          : Math.max(
              ANNOUNCEMENT_MIN_SCROLL_SECONDS,
              Math.round((runWidth * copies) / scrollSpeed)
            )
      // 「每轮停留」= 滚动段 + 公告自己配的停顿时长：总时长直接相加，关键帧的停留点按
      // 同一比例生成，于是滚动速度与连续模式一致，而每轮结束都稳定停那么久。
      setDuration(
        scrollMode === 'paced' ? scrollSeconds + pauseSeconds : scrollSeconds
      )
      setAnimationName(
        scrollMode === 'paced'
          ? pacedAnimationName(scrollSeconds, pauseSeconds)
          : ''
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    observer.observe(run)
    return () => observer.disconnect()
  }, [contentKey, scrollMode, scrollSpeed, pauseSeconds, displaySeconds])

  // 供读屏与「展开全文」按钮复述的纯文本：标题可选，没填时不要留一个开头的冒号。
  const plainText = useMemo(
    () =>
      items
        .map((item) => {
          const title = item.title.trim()
          const content = announcementPlainText(item.content)
          return title === '' ? content : `${title}：${content}`
        })
        .join('　'),
    [items]
  )

  if (items.length === 0) {
    return null
  }

  const renderRun = () => (
    <>
      {items.map((item, index) => (
        <span key={item.id} className="announcement-item">
          {index > 0 ? (
            <span
              aria-hidden
              className="mx-3 text-muted-foreground/60 select-none"
            >
              •
            </span>
          ) : null}
          {/* 标题是可选的（见管理页的「（可选）」）：没填就只出内容，
              否则横幅开头会挂一个空加粗块加一个孤零零的冒号。 */}
          {item.title.trim() === '' ? null : (
            <>
              <span className="font-semibold">{item.title}</span>
              <span className="mx-1">：</span>
            </>
          )}
          <AnnouncementContent content={item.content} />
        </span>
      ))}
    </>
  )

  // 静止时只渲染一份（没有生效公告时整个组件不渲染），否则文字会出现两遍；
  // 滚动时渲染 repeat * 2 份：前 repeat 份铺满可视区，后 repeat 份用于 -50% 的无缝循环。
  const copies = scrolling ? repeat * 2 : 1

  // 拖动查看：按下后把指针位移反向加到 scrollLeft 上（可视区是 overflow: hidden，
  // 没有滚动条，但仍是可编程滚动的容器）。不捕获指针：拖到外面放开也不会粘住。
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current
    if (!viewport || event.button !== 0) {
      return
    }
    dragRef.current = {
      startX: event.clientX,
      startScroll: viewport.scrollLeft,
    }
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    const viewport = viewportRef.current
    if (!drag || !viewport) {
      return
    }
    viewport.scrollLeft = drag.startScroll - (event.clientX - drag.startX)
  }

  const endDrag = () => {
    dragRef.current = null
  }

  return (
    <>
      <IconSpeakerphone
        className={`size-4 shrink-0 ${ANNOUNCEMENT_LEVEL_ICONS[level]}`}
      />
      <div
        ref={viewportRef}
        title={plainText}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        // select-none：按住拖动时不能顺带选中文字；cursor-grab 是「可拖」的提示。
        className="announcement-viewport min-w-0 flex-1 cursor-grab overflow-hidden select-none active:cursor-grabbing"
      >
        <div
          className={`announcement-track${scrolling ? ' is-scrolling' : ''}${
            scrollMode === 'paced' ? ' is-paced' : ''
          }`}
          style={
            {
              '--announcement-duration': `${duration}s`,
              // 只在「每轮停留」时覆盖动画名，连续滚动沿用 CSS 默认的那份。
              ...(animationName
                ? { '--announcement-animation': animationName }
                : {}),
            } as CSSProperties
          }
        >
          {Array.from({ length: copies }, (_, index) => (
            <span
              key={index}
              // 第一份留着给测量用；其余都是循环用的副本，读屏器不该重复读。
              ref={index === 0 ? runRef : undefined}
              aria-hidden={index > 0 ? true : undefined}
              className="announcement-run"
            >
              {renderRun()}
            </span>
          ))}
        </div>
      </div>
    </>
  )
}
