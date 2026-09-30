import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { IconChevronDown, IconSpeakerphone } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import {
  ANNOUNCEMENT_LEVEL_ICONS,
  announcementPlainText,
  type AnnouncementLevel,
} from '@/lib/announcement-markup'
import { useAnnouncements } from '@/lib/api'
import {
  ANNOUNCEMENT_SCROLL_PAUSE_SECONDS,
  combinedScrollMode,
  pacedAnimationName,
} from '@/lib/announcement-scroll'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

import { AnnouncementContent } from './announcement-content'

/**
 * 顶栏通知栏：管理员发布的公告在这里滚动输出。
 *
 * - 渲染在顶栏里、集群徽章之前（见 SiteHeader），占一小块区域，**没有外框**：
 *   就是一行滚动文字 + 一个级别色的喇叭图标；
 * - 默认横向滚动（不论内容长短）：内容比这块窄时先重复铺满，否则循环会露出空隙；
 * - 三种「读全」的手段（滚动只是其中一种，消息很长时用户可能来不及看完）：
 *   鼠标悬停暂停、按住拖动（横向拖看前后文）、右侧展开全文；
 * - **不受** `prefers-reduced-motion` 影响：滚不滚只看公告自己的配置（理由见
 *   styles/base.css 里那段说明）——管理员已按条决定过，被客户端偏好静默否决会得到
 *   「勾了横向滚动却没滚、也没人解释为什么」，比不尊重偏好更糟；
 * - 同时有多条时按优先级顺序串成一条，图标颜色取其中最高的级别。
 *
 * 见 plans/2026-09-21-顶部通知栏.md。
 */

// 多条公告同时生效时，整条通知栏取其中最高的级别。
const LEVEL_RANK: Record<AnnouncementLevel, number> = {
  info: 0,
  warning: 1,
  danger: 2,
}

// 滚动速度按内容宽度换算（像素/秒），并且不低于这个时长，否则短内容一闪而过。
const SCROLL_PIXELS_PER_SECOND = 60
const MIN_SCROLL_DURATION_SECONDS = 15

export function AnnouncementBar() {
  const { t } = useTranslation()
  const { data } = useAnnouncements()
  // 用 useMemo 固定引用：直接写 `data?.items ?? []` 会让下面几个 Hook 的依赖每次渲染都变。
  const items = useMemo(() => data?.items ?? [], [data])
  // 是否滚动**只看公告自己的配置**，不再叠加 `prefers-reduced-motion`。
  //
  // 取舍的来由（真机反馈）：管理员勾了「横向滚动」却没滚，而且界面上没有任何解释——
  // 因为系统级的减弱动效在背后把它否决了。公告的滚动是**内容呈现要求**，管理员已经按
  // 每条公告逐个决定过，优先级高于客户端偏好；被客户端静默推翻是最糟的结果（既没滚，
  // 也不知道为什么）。速度本身也很慢（60px/s），静态时仍有拖动与「展开全文」兜底。
  //
  // 多条公告串成**一条**轨道输出，没法一半滚一半不滚，所以取「最强」的那一种方式
  // ——与「级别取最高」同一套取舍（判定见 lib/announcement-scroll.ts）。
  const scrollMode = combinedScrollMode(items)
  const scrolling = scrollMode !== 'none'
  const viewportRef = useRef<HTMLDivElement>(null)
  const runRef = useRef<HTMLSpanElement>(null)
  // repeat 是「一份内容要重复几次才能铺满可视区」：内容比可视区窄时必须重复，
  // 否则 translateX(-50%) 的循环里会出现一段空白。
  const [repeat, setRepeat] = useState(1)
  const [duration, setDuration] = useState(MIN_SCROLL_DURATION_SECONDS)
  // 「每轮停留」用的关键帧名，按这轮实际要滚多久生成（见 lib/announcement-scroll.ts）。
  // 空串 = 用 CSS 里的连续滚动关键帧。
  const [animationName, setAnimationName] = useState('')
  // 拖动查看：悬停时动画已经暂停，因此拖动的就是一份静止的内容，
  // 不会被动画推回去（状态里只记起点，不触发重渲染）。
  const dragRef = useRef<{ startX: number; startScroll: number } | null>(null)

  // 标题与正文都可能变化，用它作为重新测量的依据（id 相同的公告被编辑后要重新算宽度）。
  const contentKey = items
    .map((item) => `${item.id}:${item.updatedAt}`)
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
      const viewportWidth = viewport.clientWidth
      if (runWidth <= 0 || viewportWidth <= 0) {
        return
      }
      const copies = Math.max(1, Math.ceil(viewportWidth / runWidth))
      setRepeat(copies)
      const scrollSeconds = Math.max(
        MIN_SCROLL_DURATION_SECONDS,
        Math.round((runWidth * copies) / SCROLL_PIXELS_PER_SECOND)
      )
      // 「每轮停留」= 滚动段（按内容宽度算，所以每轮时长随公告长短变化）+ 固定 2 秒停留：
      // 总时长直接相加，关键帧的停留点按同一比例生成，于是滚动速度与连续模式一致，
      // 而每轮结束都稳定停 2 秒。
      setDuration(
        scrollMode === 'paced'
          ? scrollSeconds + ANNOUNCEMENT_SCROLL_PAUSE_SECONDS
          : scrollSeconds
      )
      setAnimationName(
        scrollMode === 'paced' ? pacedAnimationName(scrollSeconds) : ''
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    observer.observe(run)
    return () => observer.disconnect()
  }, [contentKey, scrollMode])

  const plainText = useMemo(
    () =>
      items
        .map((item) => `${item.title}：${announcementPlainText(item.content)}`)
        .join('　'),
    [items]
  )

  if (items.length === 0) {
    return null
  }

  const level = items.reduce<AnnouncementLevel>(
    (highest, item) =>
      LEVEL_RANK[item.level] > LEVEL_RANK[highest] ? item.level : highest,
    'info'
  )

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
          <span className="font-semibold">{item.title}</span>
          <span className="mx-1">：</span>
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
    <div
      role="region"
      aria-label={t('notifications.announcements.barLabel', '通知栏')}
      // 顶栏里的一行文字：没有外框、没有底色，只有级别色的喇叭图标；
      // 宽度有上限但可收缩，不会把顶栏挤变形。
      // 小屏顶栏本来就挤（语言/主题/铃铛都隐藏了），这里一并隐藏。
      // 宽度**跟着可用空间走**：`flex-1`（basis 0 + grow 1）吃掉面包屑之外的剩余宽度，
      // 所以屏幕越宽它越长、挤的时候自动变短；`max-w-*` 只是上限，避免超宽屏拉到离谱，
      // `min-w-0` 让它能被压到很窄而不是把顶栏撑变形。
      className="hidden min-w-0 flex-1 items-center gap-1 text-sm sm:flex sm:max-w-md lg:max-w-xl xl:max-w-2xl"
    >
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
      {/* 「读全」的最后一道保险：展开成可换行的全文，不受顶栏单行与滚动速度限制，
          键盘与读屏器也能直接用（拖动那套只对鼠标友好）。 */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t('notifications.announcements.expand', '展开全文')}
            title={t('notifications.announcements.expand', '展开全文')}
            className="flex shrink-0 items-center justify-center rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            <IconChevronDown className="size-4" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="max-h-80 w-80 overflow-y-auto">
          <p className="mb-2 text-sm font-medium">
            {t('notifications.announcements.barLabel', '通知栏')}
          </p>
          <div className="space-y-3">
            {items.map((item) => (
              <div key={item.id} className="flex items-start gap-2">
                <IconSpeakerphone
                  className={`mt-0.5 size-4 shrink-0 ${ANNOUNCEMENT_LEVEL_ICONS[item.level]}`}
                />
                <div className="min-w-0 space-y-0.5">
                  <p className="text-sm font-semibold break-words">
                    {item.title}
                  </p>
                  {/* 这里不加 nowrap：弹层里就是要换行完整显示。 */}
                  <div className="text-sm text-muted-foreground">
                    <AnnouncementContent content={item.content} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
