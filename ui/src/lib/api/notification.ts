import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { apiClient } from '../api-client'
import { encryptRequestBody } from '../transport-envelope'
import { fetchAPI } from './shared'

export type NotificationChannel = 'inapp' | 'email'
// all_users 是「全体用户」：不绑定具体账号，投递时展开成当时的所有已启用账号。
export type NotificationReceiverType = 'user' | 'email' | 'all_users'
// NotificationEvent 与后端 model.NotificationEventList() 保持一致；事件列表不在前端硬编码，
// 订阅下拉直接取「通知模板」接口返回的事件（见 SubscriptionList）。
export type NotificationEvent =
  | 'remote_login'
  | 'password_expiring'
  | 'password_expired'
  | 'inactive_user_disabled'
  | 'password_reset_by_admin'
  | 'mfa_reset_by_admin'
  | 'account_disabled'
  | 'account_enabled'
  | 'account_expiring'
  | 'role_assigned'
  | 'role_unassigned'
  | 'session_takeover'
  | 'mail_delivery_failed'
  | 'test'

export interface NotificationSetting {
  emailEnabled: boolean
  inAppEnabled: boolean
  smtpHost: string
  smtpPort: number
  smtpUsername: string
  smtpFrom: string
  smtpSenderName: string
  smtpTls: 'none' | 'starttls' | 'ssl'
  smtpSkipVerify: boolean
  passwordExpireNoticeDays: number
}

export interface NotificationSettingPayload {
  setting: NotificationSetting
  smtpPasswordConfigured: boolean
}

export interface NotificationTemplate {
  id: number
  event: NotificationEvent
  subject: string
  body: string
  enabled: boolean
}

export interface NotificationTemplatePayload {
  templates: NotificationTemplate[]
  variables: Record<string, string[]>
}

export interface NotificationSubscription {
  id: number
  event: NotificationEvent
  channel: NotificationChannel
  receiverType: NotificationReceiverType
  receiverId: number
  receiver: string
  enabled: boolean
}

export interface InAppNotification {
  id: number
  userId: number
  event: string
  title: string
  content: string
  read: boolean
  createdAt: string
}

export interface NotificationListPayload {
  items: InAppNotification[]
  total: number
  page: number
  size: number
}

/* ------------------------------------------------------------- 设置 */

export const fetchNotificationSetting = async () => {
  return fetchAPI<NotificationSettingPayload>('/admin/notification-setting/')
}

export const useNotificationSetting = () => {
  return useQuery({
    queryKey: ['notification-setting'],
    queryFn: fetchNotificationSetting,
    staleTime: 30000,
  })
}

export interface UpdateNotificationSettingPayload extends Partial<NotificationSetting> {
  smtpPassword?: string
  clearSmtpPassword?: boolean
}

export const updateNotificationSetting = async (
  data: UpdateNotificationSettingPayload
) => {
  // SMTP 口令在这段请求体里，整包走信封加密。
  return apiClient.put<NotificationSettingPayload>(
    '/admin/notification-setting/',
    await encryptRequestBody(data)
  )
}

export const sendTestNotification = async (to: string) => {
  return apiClient.post<{ message: string }>(
    '/admin/notification-setting/test-mail',
    { to }
  )
}

export const runDailyNotificationChecks = async () => {
  return apiClient.post<{ message: string }>(
    '/admin/notification-setting/run-daily-checks'
  )
}

/* ------------------------------------------------------------- 模板 */

export const useNotificationTemplates = () => {
  return useQuery({
    queryKey: ['notification-templates'],
    queryFn: () =>
      fetchAPI<NotificationTemplatePayload>('/admin/notification-templates/'),
    staleTime: 30000,
  })
}

export const updateNotificationTemplate = async (
  event: string,
  data: { subject: string; body: string; enabled: boolean }
) => {
  return apiClient.put<{ message: string }>(
    `/admin/notification-templates/${event}`,
    data
  )
}

export const useUpdateNotificationTemplate = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      event,
      data,
    }: {
      event: string
      data: { subject: string; body: string; enabled: boolean }
    }) => updateNotificationTemplate(event, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notification-templates'] })
    },
  })
}

/* --------------------------------------------------------- 订阅关系 */

export const fetchNotificationSubscriptions = async (event?: string) => {
  const query = event ? `?event=${encodeURIComponent(event)}` : ''
  return fetchAPI<{
    subscriptions: NotificationSubscription[]
    /**
     * 「管理员必收、无法取消」的事件清单。由后端下发（`model.mandatoryAdminEvents`），
     * 界面据此上锁，不另抄一份。
     */
    mandatoryEvents: string[]
    /**
     * 「当事人必收」的事件清单（`model.targetUserEvents`）：这些事件描述的是当事人自己
     * 账号的状态/凭据变化，投递时一定会发给本人，与订阅无关。界面据此标注，
     * 否则管理员会以为自己必须为这些事件配订阅才有人收到。
     */
    targetUserEvents: string[]
  }>(`/admin/notification-subscriptions/${query}`)
}

export const useNotificationSubscriptions = (enabled = true) => {
  return useQuery({
    queryKey: ['notification-subscriptions'],
    queryFn: () => fetchNotificationSubscriptions(),
    staleTime: 15000,
    enabled,
  })
}

export interface CreateNotificationSubscriptionPayload {
  event: string
  channel: NotificationChannel
  receiverType: NotificationReceiverType
  receiverId?: number
  receiver?: string
}

export const createNotificationSubscription = async (
  data: CreateNotificationSubscriptionPayload
) => {
  return apiClient.post<NotificationSubscription>(
    '/admin/notification-subscriptions/',
    data
  )
}

export interface BatchNotificationSubscriptionPayload {
  events: string[]
  channel: NotificationChannel
  receiverType: NotificationReceiverType
  receiverId?: number
  receiver?: string
}

export interface BatchNotificationSubscriptionResult {
  created: NotificationSubscription[]
  /** 已存在完全相同订阅、被跳过的事件。 */
  skipped: string[]
}

/** 「全选」：一次为多个事件建同一套接收者（已存在的由后端跳过）。 */
export const createNotificationSubscriptionsBatch = async (
  data: BatchNotificationSubscriptionPayload
) => {
  return apiClient.post<BatchNotificationSubscriptionResult>(
    '/admin/notification-subscriptions/batch',
    data
  )
}

export const useCreateNotificationSubscriptionsBatch = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: createNotificationSubscriptionsBatch,
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['notification-subscriptions'],
      })
    },
  })
}

export const useCreateNotificationSubscription = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: createNotificationSubscription,
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['notification-subscriptions'],
      })
    },
  })
}

export const useUpdateNotificationSubscription = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      apiClient.put<NotificationSubscription>(
        `/admin/notification-subscriptions/${id}`,
        { enabled }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['notification-subscriptions'],
      })
    },
  })
}

export const useDeleteNotificationSubscription = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) =>
      apiClient.delete<void>(`/admin/notification-subscriptions/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['notification-subscriptions'],
      })
    },
  })
}

/* ------------------------------------------------------------- 收件箱 */

export const fetchNotifications = async (page = 1, size = 20) => {
  return fetchAPI<NotificationListPayload>(
    `/notifications?page=${page}&size=${size}`
  )
}

export const useNotifications = (
  page: number,
  size: number,
  enabled: boolean
) => {
  return useQuery({
    queryKey: ['notifications', page, size],
    queryFn: () => fetchNotifications(page, size),
    enabled,
    staleTime: 10000,
  })
}

export const fetchUnreadNotificationCount = async () => {
  return fetchAPI<{ count: number }>('/notifications/unread-count')
}

export const useUnreadNotificationCount = (enabled: boolean) => {
  return useQuery({
    queryKey: ['notifications-unread-count'],
    queryFn: fetchUnreadNotificationCount,
    enabled,
    refetchInterval: 60000,
    staleTime: 15000,
  })
}

export const markNotificationsRead = async (payload: {
  id?: number
  all?: boolean
}) => {
  return apiClient.post<{ message: string }>('/notifications/read', payload)
}

export const clearNotifications = async () => {
  return apiClient.post<{ message: string }>('/notifications/clear')
}

export const useClearNotifications = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: clearNotifications,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] })
      queryClient.invalidateQueries({
        queryKey: ['notifications-unread-count'],
      })
    },
  })
}

export const useMarkNotificationsRead = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: markNotificationsRead,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] })
      queryClient.invalidateQueries({
        queryKey: ['notifications-unread-count'],
      })
    },
  })
}
