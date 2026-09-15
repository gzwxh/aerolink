import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { apiClient } from '../api-client'
import { fetchAPI } from './shared'

export type NotificationChannel = 'inapp' | 'email'
export type NotificationReceiverType = 'user' | 'email'
export type NotificationEvent =
  | 'remote_login'
  | 'password_expiring'
  | 'password_expired'
  | 'inactive_user_disabled'
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

export const notificationEvents: NotificationEvent[] = [
  'remote_login',
  'password_expiring',
  'password_expired',
  'inactive_user_disabled',
]

/* ------------------------------------------------------------------ setting */

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
  return apiClient.put<NotificationSettingPayload>(
    '/admin/notification-setting/',
    data
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

/* ---------------------------------------------------------------- templates */

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

/* ------------------------------------------------------------ subscriptions */

export const fetchNotificationSubscriptions = async (event?: string) => {
  const query = event ? `?event=${encodeURIComponent(event)}` : ''
  return fetchAPI<{ subscriptions: NotificationSubscription[] }>(
    `/admin/notification-subscriptions/${query}`
  )
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

/* -------------------------------------------------------------------- inbox */

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
      queryClient.invalidateQueries({ queryKey: ['notifications-unread-count'] })
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
