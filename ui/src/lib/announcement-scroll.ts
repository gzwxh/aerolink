import type { Announcement, AnnouncementScrollMode } from '@/lib/api/announcement'

/**
 * 「每轮之间停留」的停顿时长（秒）。
 *
 * 固定 2 秒，**不随内容长短变化**：滚动段仍按内容宽度算（恒定 60px/s），走完停 2 秒
 * 再开始下一轮。用固定秒数而不是固定比例，是因为公告长短差别很大——比例制下长公告要
 * 停十几秒、短公告又几乎感觉不到，两头都不符合「看完喘口气」的预期。
 *
 * 关键帧的停留点 = 滚动秒数 /（滚动秒数 + 停留秒数），所以必须在运行时按每一条实际宽度
 * 生成（见 pacedAnimationName）：CSS 的 keyframe 选择器不接受 var()。
 */
export const ANNOUNCEMENT_SCROLL_PAUSE_SECONDS = 2

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
  items: Array<Pick<Announcement, 'scroll' | 'scrollMode'>>
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
 * 于是「每轮滚多久」由内容宽度决定（长短不一），「每轮停多久」固定 2 秒。
 */
export function pacedAnimationName(
  scrollSeconds: number,
  pauseSeconds = ANNOUNCEMENT_SCROLL_PAUSE_SECONDS
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
