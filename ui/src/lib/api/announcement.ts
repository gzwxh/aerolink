import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { apiClient } from '../api-client'
import { fetchAPI } from './shared'

/** 公告级别：只决定横幅整体的强调方式（左侧色条 + 图标 + 淡底）。 */
export type AnnouncementLevel = 'info' | 'warning' | 'danger'

export interface Announcement {
  id: number
  title: string
  /**
   * Markdown 子集 + 具名颜色标记（`{warning}文字{/warning}`）。
   * 允许的标记见 lib/announcement-markup.ts，与后端一样不接受原始 HTML。
   */
  content: string
  level: AnnouncementLevel
  priority: number
  enabled: boolean
  /**
   * 是否在顶栏横向滚动。后端默认 true（与历史行为一致）；
   * 旧数据或老接口没有这个字段时按 true 处理。
   *
   * 新代码请用 `scrollMode`：它是三态口径，这个布尔只是给老客户端读的兼容字段
   * （后端写入时两者会被同步维护）。判定统一走 lib/announcement-scroll.ts。
   */
  scroll: boolean
  /** 滚动方式：不滚动 / 连续 / 每轮之间停留（见 pkg/model/announcement.go 的常量）。 */
  scrollMode?: AnnouncementScrollMode
  /**
   * 滚动速度（像素/秒），旧数据缺字段时按 60 处理。
   *
   * 参数「每条公告各配」；顶栏同一时间只展示启用的那一条，所以写的就是实际生效的值。
   */
  scrollSpeed?: number
  /** 「每轮停留」的秒数，只在 scrollMode = paced 时生效；缺省 2。 */
  pauseSeconds?: number
  /** 一轮滚完的秒数，0 或缺省表示按速度自动算（不短于 15 秒）。 */
  displaySeconds?: number
  startAt?: string
  endAt?: string
  creatorId: number
  createdAt: string
  updatedAt: string
}

/**
 * 顶栏通知栏的滚动方式（与 pkg/model/announcement.go 的常量一一对应）：
 *   none       不滚动，静态展示；
 *   continuous 连续滚动，一轮接一轮（历史行为）；
 *   paced      每轮走完先停一会儿，再开始下一轮。
 */
export type AnnouncementScrollMode = 'none' | 'continuous' | 'paced'

export interface AnnouncementPayload {
  title: string
  content: string
  level: AnnouncementLevel
  priority: number
  enabled: boolean
  /** 是否在顶栏横向滚动（后端在该字段缺省时按 true 处理）。 */
  scroll: boolean
  /** 滚动方式；后端以它为准，并据此同步维护上面的 scroll。 */
  scrollMode: AnnouncementScrollMode
  /** 滚动速度（像素/秒，10~300）。 */
  scrollSpeed: number
  /** 「每轮停留」秒数（1~60，仅 paced 生效）。 */
  pauseSeconds: number
  /** 一轮滚完的秒数；0 = 自动。 */
  displaySeconds: number
  /** 空串表示「立即生效 / 永不过期」（后端按可空时间解析）。 */
  startAt: string
  endAt: string
}

/* ------------------------------------------------------- 通知栏（所有人读） */

export const fetchAnnouncements = async () => {
  return fetchAPI<{ items: Announcement[] }>('/announcements')
}

/**
 * 当前生效的公告。横幅是全局的，不按用户区分，因此只按时间做 5 分钟陈旧窗口 +
 * 窗口重新聚焦时刷新，不做轮询：到点消失依赖下一次查询，不追求秒级。
 */
export const useAnnouncements = () => {
  return useQuery({
    queryKey: ['announcements', 'active'],
    queryFn: fetchAnnouncements,
    staleTime: 5 * 60 * 1000,
  })
}

/* --------------------------------------------------------- 管理端（读写） */

export const fetchAllAnnouncements = async () => {
  return fetchAPI<{ items: Announcement[] }>('/admin/announcements/')
}

export const useAllAnnouncements = (enabled = true) => {
  return useQuery({
    queryKey: ['announcements', 'all'],
    queryFn: fetchAllAnnouncements,
    staleTime: 15000,
    enabled,
  })
}

/** 增删改都会改变横幅内容，因此所有写操作都同时失效「生效中」与「全部」两份缓存。 */
const useInvalidateAnnouncements = () => {
  const queryClient = useQueryClient()
  return () => {
    queryClient.invalidateQueries({ queryKey: ['announcements'] })
  }
}

export const createAnnouncement = async (data: AnnouncementPayload) => {
  return apiClient.post<Announcement>('/admin/announcements/', data)
}

export const useCreateAnnouncement = () => {
  const invalidate = useInvalidateAnnouncements()
  return useMutation({ mutationFn: createAnnouncement, onSuccess: invalidate })
}

export const updateAnnouncement = async (
  id: number,
  data: AnnouncementPayload
) => {
  return apiClient.put<Announcement>(`/admin/announcements/${id}`, data)
}

export const useUpdateAnnouncement = () => {
  const invalidate = useInvalidateAnnouncements()
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: AnnouncementPayload }) =>
      updateAnnouncement(id, data),
    onSuccess: invalidate,
  })
}

export const useDeleteAnnouncement = () => {
  const invalidate = useInvalidateAnnouncements()
  return useMutation({
    mutationFn: (id: number) =>
      apiClient.delete<void>(`/admin/announcements/${id}`),
    onSuccess: invalidate,
  })
}
