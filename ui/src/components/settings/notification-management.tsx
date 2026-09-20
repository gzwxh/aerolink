import { useEffect, useState } from 'react'
import { useSettingsSectionAccess } from '@/contexts/settings-section-context'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

import {
  runDailyNotificationChecks,
  sendTestNotification,
  updateNotificationSetting,
  useCreateNotificationSubscription,
  useDeleteNotificationSubscription,
  useNotificationSetting,
  useNotificationSubscriptions,
  useNotificationTemplates,
  useUpdateNotificationSubscription,
  useUpdateNotificationTemplate,
  type NotificationSetting,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { PasswordInput } from '@/components/password-input'

/**
 * 通知管理：邮件服务器、消息模板与消息订阅。
 * 事件策略（异地登录 / 不活跃禁用 / 密码过期）复用「安全管理」里的开关。
 */
export function NotificationManagement() {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab') ?? 'email'
  const tab = ['email', 'templates', 'subscriptions'].includes(tabParam)
    ? tabParam
    : 'email'

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {t('notifications.title', '通知管理')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs
          value={tab}
          onValueChange={(value) => setSearchParams({ tab: value })}
          className="flex flex-row gap-4 space-y-0 [&>[role=tabpanel]]:min-w-0 [&>[role=tabpanel]]:flex-1"
        >
          <TabsContent value="email">
            <MailSettings />
          </TabsContent>
          <TabsContent value="templates">
            <TemplateList />
          </TabsContent>
          <TabsContent value="subscriptions">
            <SubscriptionList />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}

function MailSettings() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  // 只读章节（只有 settings.notification 的读权限）时不渲染发送类入口。
  const { readOnly } = useSettingsSectionAccess()
  const { data, isLoading } = useNotificationSetting()
  const [form, setForm] = useState<NotificationSetting | null>(null)
  const [smtpPassword, setSmtpPassword] = useState('')
  const [testRecipient, setTestRecipient] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [running, setRunning] = useState(false)

  useEffect(() => {
    if (data?.setting) {
      setForm(data.setting)
    }
  }, [data])

  if (isLoading || !form) {
    return (
      <p className="text-sm text-muted-foreground">
        {t('common.messages.loading', '加载中...')}
      </p>
    )
  }

  const patch = <K extends keyof NotificationSetting>(
    key: K,
    value: NotificationSetting[K]
  ) =>
    setForm((previous) => (previous ? { ...previous, [key]: value } : previous))

  const handleSave = async () => {
    setSaving(true)
    try {
      await updateNotificationSetting({
        ...form,
        smtpPassword: smtpPassword || undefined,
      })
      setSmtpPassword('')
      await queryClient.invalidateQueries({
        queryKey: ['notification-setting'],
      })
      toast.success(t('notifications.messages.saved', '已保存'))
    } catch {
      // 失败已由 API 客户端统一写入站内信
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    try {
      await sendTestNotification(testRecipient)
      toast.success(t('notifications.messages.testSent', '测试邮件已发送'))
    } catch {
      // 失败已由 API 客户端统一写入站内信
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('notifications.email.title', '通知渠道')}</CardTitle>
          <CardDescription>
            {t(
              'notifications.email.description',
              '总开关关闭后不再产生任何通知；站内信与邮件可分别启用。'
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ToggleRow
            label={t('notifications.fields.inAppEnabled', '站内信')}
            hint={t(
              'notifications.fields.inAppEnabledHint',
              '在右上角通知中心展示消息'
            )}
            checked={form.inAppEnabled}
            onChange={(checked) => patch('inAppEnabled', checked)}
          />
          <ToggleRow
            label={t('notifications.fields.emailEnabled', '邮件通知')}
            hint={t(
              'notifications.fields.emailEnabledHint',
              '通过 SMTP 服务器发送邮件'
            )}
            checked={form.emailEnabled}
            onChange={(checked) => patch('emailEnabled', checked)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('notifications.smtp.title', '邮件服务器')}</CardTitle>
          <CardDescription>
            {t(
              'notifications.smtp.description',
              'SMTP 配置，保存后可发送测试邮件'
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="smtpHost">
                {t('notifications.fields.smtpHost', 'SMTP 服务器')}
              </Label>
              <Input
                id="smtpHost"
                value={form.smtpHost}
                placeholder="smtp.example.com"
                onChange={(event) => patch('smtpHost', event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="smtpPort">
                {t('notifications.fields.smtpPort', '端口')}
              </Label>
              <Input
                id="smtpPort"
                type="number"
                value={form.smtpPort}
                onChange={(event) =>
                  patch('smtpPort', Number(event.target.value) || 0)
                }
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="smtpUsername">
                {t('notifications.fields.smtpUsername', '账号')}
              </Label>
              <Input
                id="smtpUsername"
                value={form.smtpUsername}
                onChange={(event) => patch('smtpUsername', event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="smtpPassword">
                {t('notifications.fields.smtpPassword', '密码 / 授权码')}
              </Label>
              <PasswordInput
                id="smtpPassword"
                value={smtpPassword}
                placeholder={
                  data?.smtpPasswordConfigured
                    ? t(
                        'notifications.fields.smtpPasswordKeep',
                        '已配置，留空则不修改'
                      )
                    : ''
                }
                onChange={(event) => setSmtpPassword(event.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="smtpFrom">
                {t('notifications.fields.smtpFrom', '发件人邮箱')}
              </Label>
              <Input
                id="smtpFrom"
                value={form.smtpFrom}
                placeholder="noreply@example.com"
                onChange={(event) => patch('smtpFrom', event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="smtpSenderName">
                {t('notifications.fields.smtpSenderName', '发件人名称')}
              </Label>
              <Input
                id="smtpSenderName"
                value={form.smtpSenderName}
                placeholder="Kite"
                onChange={(event) =>
                  patch('smtpSenderName', event.target.value)
                }
              />
            </div>
            <div className="space-y-2">
              <Label>{t('notifications.fields.smtpTls', '加密方式')}</Label>
              <Select
                value={form.smtpTls}
                onValueChange={(value) =>
                  patch('smtpTls', value as NotificationSetting['smtpTls'])
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ssl">SSL / TLS</SelectItem>
                  <SelectItem value="starttls">STARTTLS</SelectItem>
                  <SelectItem value="none">
                    {t('notifications.fields.smtpTlsNone', '不加密')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <ToggleRow
            label={t('notifications.fields.smtpSkipVerify', '跳过证书校验')}
            hint={t(
              'notifications.fields.smtpSkipVerifyHint',
              '仅在自签名证书的测试环境使用'
            )}
            checked={form.smtpSkipVerify}
            onChange={(checked) => patch('smtpSkipVerify', checked)}
          />

          <div className="space-y-2">
            <Label htmlFor="passwordExpireNoticeDays">
              {t(
                'notifications.fields.passwordExpireNoticeDays',
                '密码过期提前提醒（天）'
              )}
            </Label>
            <Input
              id="passwordExpireNoticeDays"
              type="number"
              className="sm:w-40"
              value={form.passwordExpireNoticeDays}
              onChange={(event) =>
                patch(
                  'passwordExpireNoticeDays',
                  Number(event.target.value) || 0
                )
              }
            />
            <p className="text-xs text-muted-foreground">
              {t(
                'notifications.fields.passwordExpireNoticeDaysHint',
                '与「安全管理」中的密码过期天数配合使用，每天检查一次'
              )}
            </p>
          </div>

          <div className="flex justify-end gap-2">
            {!readOnly && (
              <Button
                variant="outline"
                disabled={running}
                onClick={async () => {
                  setRunning(true)
                  try {
                    await runDailyNotificationChecks()
                    toast.success(
                      t('notifications.messages.dailyRan', '每日检查已执行')
                    )
                  } catch {
                    // 失败已由 API 客户端统一写入站内信
                  } finally {
                    setRunning(false)
                  }
                }}
              >
                {running
                  ? t('notifications.actions.running', '执行中...')
                  : t('notifications.actions.runDaily', '立即执行每日检查')}
              </Button>
            )}
            <Button onClick={handleSave} disabled={readOnly || saving}>
              {saving
                ? t('notifications.actions.saving', '保存中...')
                : t('notifications.actions.save', '保存')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('notifications.test.title', '发送测试邮件')}</CardTitle>
          <CardDescription>
            {t(
              'notifications.test.description',
              '先保存配置，再向指定邮箱发送一封测试邮件'
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-2">
            <Label htmlFor="testRecipient">
              {t('notifications.fields.testRecipient', '收件人')}
            </Label>
            <Input
              id="testRecipient"
              value={testRecipient}
              placeholder="admin@example.com"
              onChange={(event) => setTestRecipient(event.target.value)}
            />
          </div>
          {!readOnly && (
            <Button
              variant="outline"
              onClick={handleTest}
              disabled={testing || !testRecipient}
            >
              {testing
                ? t('notifications.actions.sending', '发送中...')
                : t('notifications.actions.sendTest', '发送测试邮件')}
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function TemplateList() {
  const { t } = useTranslation()
  const { data, isLoading } = useNotificationTemplates()
  const updateTemplate = useUpdateNotificationTemplate()

  if (isLoading) {
    return (
      <p className="text-sm text-muted-foreground">
        {t('common.messages.loading', '加载中...')}
      </p>
    )
  }

  const templates = data?.templates ?? []
  if (templates.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t('notifications.templates.empty', '暂无模板')}
      </p>
    )
  }

  return (
    <div className="space-y-4">
      {templates.map((template) => (
        <TemplateCard
          key={template.event}
          event={template.event}
          subject={template.subject}
          body={template.body}
          enabled={template.enabled}
          variables={data?.variables?.[template.event] ?? []}
          saving={updateTemplate.isPending}
          onSave={(payload) =>
            updateTemplate.mutate(
              { event: template.event, data: payload },
              {
                onSuccess: () =>
                  toast.success(t('notifications.messages.saved', '已保存')),
              }
            )
          }
        />
      ))}
    </div>
  )
}

interface TemplateCardProps {
  event: string
  subject: string
  body: string
  enabled: boolean
  variables: string[]
  saving: boolean
  onSave: (payload: { subject: string; body: string; enabled: boolean }) => void
}

function TemplateCard(props: TemplateCardProps) {
  const { t } = useTranslation()
  const { readOnly } = useSettingsSectionAccess()
  const [subject, setSubject] = useState(props.subject)
  const [body, setBody] = useState(props.body)
  const [enabled, setEnabled] = useState(props.enabled)

  useEffect(() => {
    setSubject(props.subject)
    setBody(props.body)
    setEnabled(props.enabled)
  }, [props.subject, props.body, props.enabled])

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="text-base">
            {t(`notifications.events.${props.event}`, props.event)}
          </CardTitle>
          <CardDescription>
            {t('notifications.templates.variables', '可用变量')}：
            {props.variables.map((name) => `{{${name}}}`).join('、')}
          </CardDescription>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label={t('notifications.fields.templateEnabled', '启用')}
        />
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          <Label>{t('notifications.fields.subject', '标题')}</Label>
          <Input
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label>{t('notifications.fields.body', '内容')}</Label>
          <Textarea
            rows={7}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
        </div>
        <div className="flex justify-end">
          <Button
            size="sm"
            disabled={readOnly || props.saving}
            onClick={() => props.onSave({ subject, body, enabled })}
          >
            {t('notifications.actions.save', '保存')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function SubscriptionList() {
  const { t } = useTranslation()
  const { readOnly } = useSettingsSectionAccess()
  const { data: subscriptions, isLoading } = useNotificationSubscriptions()
  const createSubscription = useCreateNotificationSubscription()
  const updateSubscription = useUpdateNotificationSubscription()
  const deleteSubscription = useDeleteNotificationSubscription()

  // 事件列表来自「通知模板」接口（后端按 NotificationEventList 的顺序返回全部事件）：
  // 以前这里是前端硬编码的 4 个事件，新增事件（如 session_takeover）根本选不到。
  // 测试邮件不是真实业务事件，不参与订阅。
  const { data: templatePayload } = useNotificationTemplates()
  const eventOptions = (templatePayload?.templates ?? [])
    .map((template) => template.event as string)
    .filter((value) => value !== 'test')

  const [event, setEvent] = useState('')
  const [channel, setChannel] = useState<'inapp' | 'email'>('inapp')
  const [receiverType, setReceiverType] = useState<'user' | 'email'>('user')
  const [receiver, setReceiver] = useState('')

  // 模板还没加载完时先留空，拿到列表后默认选中第一个。
  useEffect(() => {
    if (!event && eventOptions.length > 0) {
      setEvent(eventOptions[0])
    }
  }, [event, eventOptions])

  const handleCreate = async () => {
    try {
      await createSubscription.mutateAsync({
        event,
        channel,
        receiverType,
        receiver,
      })
      setReceiver('')
      toast.success(t('notifications.messages.saved', '已保存'))
    } catch {
      // 失败已由 API 客户端统一写入站内信
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t('notifications.subscriptions.add', '新增订阅')}
          </CardTitle>
          <CardDescription>
            {t(
              'notifications.subscriptions.description',
              '选择需要通知的事件与接收人；用户需先在「用户」中配置邮箱才能用邮件接收'
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-4">
          <Select value={event} onValueChange={setEvent}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {eventOptions.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`notifications.events.${value}`, value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={receiverType}
            onValueChange={(value) =>
              setReceiverType(value as 'user' | 'email')
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="user">
                {t('notifications.receiverTypes.user', '用户')}
              </SelectItem>
              <SelectItem value="email">
                {t('notifications.receiverTypes.email', '邮箱地址')}
              </SelectItem>
            </SelectContent>
          </Select>

          <Select
            value={channel}
            onValueChange={(value) => setChannel(value as 'inapp' | 'email')}
            disabled={receiverType === 'email'}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inapp">
                {t('notifications.channels.inapp', '站内信')}
              </SelectItem>
              <SelectItem value="email">
                {t('notifications.channels.email', '邮件')}
              </SelectItem>
            </SelectContent>
          </Select>

          <Input
            value={receiver}
            placeholder={
              receiverType === 'user'
                ? t('notifications.fields.username', '用户名')
                : 'ops@example.com'
            }
            onChange={(event) => setReceiver(event.target.value)}
          />

          {!readOnly && (
            <div className="sm:col-span-4 flex justify-end">
              <Button
                onClick={handleCreate}
                disabled={createSubscription.isPending || !receiver || !event}
              >
                {t('notifications.actions.add', '添加')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t('notifications.subscriptions.existing', '已配置订阅')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {isLoading && (
            <p className="text-sm text-muted-foreground">
              {t('common.messages.loading', '加载中...')}
            </p>
          )}
          {!isLoading && (subscriptions?.subscriptions?.length ?? 0) === 0 && (
            <p className="text-sm text-muted-foreground">
              {t('notifications.subscriptions.empty', '暂无订阅')}
            </p>
          )}
          {subscriptions?.subscriptions?.map((subscription) => (
            <div
              key={subscription.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium">
                  {t(
                    `notifications.events.${subscription.event}`,
                    subscription.event
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {t(
                    `notifications.channels.${subscription.channel}`,
                    subscription.channel
                  )}
                  {' · '}
                  {subscription.receiver}
                </div>
              </div>
              {!readOnly && (
                <div className="flex items-center gap-3">
                  <Switch
                    checked={subscription.enabled}
                    onCheckedChange={(checked) =>
                      updateSubscription.mutate({
                        id: subscription.id,
                        enabled: checked,
                      })
                    }
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => deleteSubscription.mutate(subscription.id)}
                  >
                    {t('notifications.actions.delete', '删除')}
                  </Button>
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}

interface ToggleRowProps {
  label: string
  hint?: string
  checked: boolean
  onChange: (checked: boolean) => void
}

function ToggleRow({ label, hint, checked, onChange }: ToggleRowProps) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-0.5">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  )
}
