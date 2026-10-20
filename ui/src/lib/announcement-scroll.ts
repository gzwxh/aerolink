import type {
  Announcement,
  AnnouncementScrollMode,
} from '@/lib/api/announcement'

/**
 * 滚动参数（速度 / 每轮停留 / 显示时长）的默认值与允许区间。
 *
 * 默认值就是升级前写死在这里的常量：速度 60px/s、停留 2 秒、时长按内容宽度换算。
 * 因此「公告没配过这些参数」与「升级前的观感」完全一致。
 *
 * 后端（pkg/model/announcement.go）有同一套常量与区间，两边必须一起改。
 */
export const ANNOUNCEMENT_DEFAULT_SCROLL_SPEED = 60
export const ANNOUNCEMENT_SCROLL_SPEED_MIN = 10
export const ANNOUNCEMENT_SCROLL_SPEED_MAX = 300
export const ANNOUNCEMENT_DEFAULT_PAUSE_SECONDS = 2
export const ANNOUNCEMENT_PAUSE_SECONDS_MAX = 60
export const ANNOUNCEMENT_DISPLAY_SECONDS_MIN = 3
export const ANNOUNCEMENT_DISPLAY_SECONDS_MAX = 600

/**
 * 「显示时长」留空（= 自动）时，一轮至少走这么久。
 *
 * 按宽度与速度算出来的时长可能只有一两秒，短内容会一闪而过；这个下限保证
 * 每轮都够看清。手动填了显示时长就以填的为准——那是管理员明确要求的。
 */
export const ANNOUNCEMENT_MIN_SCROLL_SECONDS = 15

/**
 * 一条公告的滚动参数（合并成轨道之前的口径）。
 *
 * displaySeconds 为 0 表示自动（按宽度与速度换算），不是「0 秒」。
 */
export interface AnnouncementScrollParams {
  mode: AnnouncementScrollMode
  /** 滚动速度（像素/秒）。 */
  speed: number
  /** 「每轮停留」的秒数，只在 mode = paced 时生效。 */
  pauseSeconds: number
  /** 一轮滚完的秒数；0 表示自动。 */
  displaySeconds: number
}

/** 参数来源：老数据可能缺字段，所以全部可选。 */
export type AnnouncementScrollSource = Pick<
  Partial<Announcement>,
  'scroll' | 'scrollMode' | 'scrollSpeed' | 'pauseSeconds' | 'displaySeconds'
>

/**
 * 取一条公告的滚动方式。
 *
 * 优先新的三态字段；老数据/老接口只有 `scroll`（bool）时按它推导：
 * false = 不滚动，true = 连续滚动（历史行为）。
 */
export function announcementScrollMode(
  item: Pick<Announcement, 'scroll' | 'scrollMode'>
): AnnouncementScrollMode {
  if (item.scrollMode) {
    return item.scrollMode
  }
  return item.scroll === false ? 'none' : 'continuous'
}

/**
 * 取一条公告的滚动参数，缺字段/非法值一律回落到默认值。
 *
 * 回落到默认值而不是报错：这些都是展示侧的参数，一条脏数据不该让整条通知栏消失。
 */
export function announcementScrollParams(
  item: AnnouncementScrollSource
): AnnouncementScrollParams {
  const speed = item.scrollSpeed
  const pauseSeconds = item.pauseSeconds
  const displaySeconds = item.displaySeconds
  return {
    mode: announcementScrollMode(
      item as Pick<Announcement, 'scroll' | 'scrollMode'>
    ),
    speed:
      typeof speed === 'number' && speed > 0
        ? speed
        : ANNOUNCEMENT_DEFAULT_SCROLL_SPEED,
    pauseSeconds:
      typeof pauseSeconds === 'number' && pauseSeconds > 0
        ? pauseSeconds
        : ANNOUNCEMENT_DEFAULT_PAUSE_SECONDS,
    displaySeconds:
      typeof displaySeconds === 'number' && displaySeconds > 0
        ? displaySeconds
        : 0,
  }
}

const SCROLL_MODE_RANK: Record<AnnouncementScrollMode, number> = {
  none: 0,
  continuous: 1,
  paced: 2,
}

/**
 * 多条公告串成同一条轨道，没法一半一种方式，所以取「最强」的那一种：
 * paced > continuous > none —— 只要有公告选了「每轮之间停留」，整条就按停留走。
 *
 * 取舍口径与「级别取最高」、以及原先「任一条要求滚动就滚动」保持一致。
 */
export function combinedScrollMode(
  items: ReadonlyArray<Pick<Announcement, 'scroll' | 'scrollMode'>>
): AnnouncementScrollMode {
  let mode: AnnouncementScrollMode = 'none'
  for (const item of items) {
    const next = announcementScrollMode(item)
    if (SCROLL_MODE_RANK[next] > SCROLL_MODE_RANK[mode]) {
      mode = next
    }
  }
  return mode
}

/**
 * 合并成整条轨道的那一套参数。
 *
 * 一条轨道只能有一个速度、一次停留、一个循环时长，所以逐项取「最保守」的那个：
 * - 方式取最强（paced > continuous > none）；
 * - 速度取**最慢**：快的那条盖掉慢的，长内容就来不及读了；
 * - 每轮停留取**最长**、显示时长取**最长**：都是为了让内容更充分地被看到。
 *
 * 与「级别取最高」同一套思路：任何一条公告提出的要求都不会被另一条悄悄降级。
 * 正因为会这样合并，管理界面必须把「被谁盖过」写出来，否则就成了用户反馈里的
 * 「滚动方式选了不生效」。
 */
export function combinedScrollParams(
  items: ReadonlyArray<AnnouncementScrollSource>
): AnnouncementScrollParams {
  // 默认值不能当作「第一条公告」参与比较：那样 60px/s 会盖掉管理员填的 100，
  // 2 秒会盖掉他填的 1 秒，表现就是「设了不生效」。所以先遍历真实取值再合并。
  const combined: AnnouncementScrollParams = {
    mode: 'none',
    speed: Number.MAX_SAFE_INTEGER,
    pauseSeconds: 0,
    displaySeconds: 0,
  }
  for (const item of items) {
    const next = announcementScrollParams(item)
    if (SCROLL_MODE_RANK[next.mode] > SCROLL_MODE_RANK[combined.mode]) {
      combined.mode = next.mode
    }
    if (next.speed < combined.speed) {
      combined.speed = next.speed
    }
    if (next.pauseSeconds > combined.pauseSeconds) {
      combined.pauseSeconds = next.pauseSeconds
    }
    if (next.displaySeconds > combined.displaySeconds) {
      combined.displaySeconds = next.displaySeconds
    }
  }
  if (combined.speed === Number.MAX_SAFE_INTEGER) {
    combined.speed = ANNOUNCEMENT_DEFAULT_SCROLL_SPEED
  }
  if (combined.pauseSeconds === 0) {
    combined.pauseSeconds = ANNOUNCEMENT_DEFAULT_PAUSE_SECONDS
  }
  return combined
}

/** 已注入的关键帧名：同一个比例只插一次 <style>，不随渲染次数堆积。 */
const injectedPacedKeyframes = new Set<string>()

/**
 * 按「滚动 scrollSeconds 秒 + 停 pauseSeconds 秒」生成带停留的关键帧，并返回动画名。
 *
 * 停留点必须在运行时按这条公告的实际宽度算（CSS 的关键帧选择器不接受 var()），
 * 因此这里按需往 <head> 注入一段 <style>；动画名由停留点的百分比编码而来，
 * 比例相同就复用同一份。组件把它交给 `--announcement-animation`
 * （见 styles/base.css 的 .announcement-track.is-scrolling）。
 *
 * 于是「每轮滚多久」由公告自己的显示时长或内容宽度决定，「每轮停多久」由公告自己的
 * 「每轮停留」决定。
 */
export function pacedAnimationName(
  scrollSeconds: number,
  pauseSeconds = ANNOUNCEMENT_DEFAULT_PAUSE_SECONDS
): string {
  const total = scrollSeconds + pauseSeconds
  // 保留 4 位小数：足够精确，又不会让关键帧里出现一长串浮点尾巴。
  const percent = Math.round((scrollSeconds / total) * 1000000) / 10000
  const name = `announcement-scroll-paced-${String(percent).replace('.', '')}`
  if (typeof document !== 'undefined' && !injectedPacedKeyframes.has(name)) {
    const style = document.createElement('style')
    style.dataset.announcementKeyframes = name
    style.textContent = `@keyframes ${name}{0%{transform:translateX(0)}${percent}%{transform:translateX(-50%)}100%{transform:translateX(-50%)}}`
    document.head.appendChild(style)
    injectedPacedKeyframes.add(name)
  }
  return name
}
