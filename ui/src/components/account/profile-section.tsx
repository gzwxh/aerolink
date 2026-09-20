import { useState, type FormEvent } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { updateCurrentUser } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

function getInitials(value: string) {
  return value
    .split(' ')
    .map((part) => part[0])
    .filter(Boolean)
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

function InfoRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1 py-2 sm:flex-row sm:items-baseline sm:gap-4">
      <div className="text-sm text-muted-foreground sm:w-40 sm:shrink-0">
        {label}
      </div>
      <div className="min-w-0 text-sm">{children}</div>
    </div>
  )
}

/**
 * 「基础信息」：可改的本地字段 + 只读的账号信息。
 *
 * 字段归属：目录用户（LDAP / OIDC）的昵称 / 邮箱 / 手机由身份源管辖，同步时
 * 会被目录值覆盖，因此这些输入框置灰；头像仍是纯本地字段（同步不回写），两种用户
 * 都可改。后端对目录用户也只接受 avatar_url，其余字段静默忽略。
 */
export function ProfileSection() {
  const { t } = useTranslation()
  const { user, checkAuth } = useAuth()
  const [form, setForm] = useState({
    name: user?.name ?? '',
    email: user?.email ?? '',
    phone: user?.phone ?? '',
    avatar_url: user?.avatar_url ?? '',
  })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  if (!user) {
    return null
  }

  const provider = user.provider || 'password'
  const externalUser = provider !== 'password'
  const groups = user.oidc_groups ?? []

  const patch = (key: keyof typeof form, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSaving(true)
    setError('')

    try {
      // 目录用户只提交头像：其余字段后端会忽略，界面也就不去假装它们可改。
      const payload = externalUser
        ? { avatar_url: form.avatar_url.trim() }
        : {
            name: form.name.trim(),
            email: form.email.trim(),
            phone: form.phone.trim(),
            avatar_url: form.avatar_url.trim(),
          }
      await updateCurrentUser(payload)
      await checkAuth()
      toast.success(t('accountSettings.profile.saved', '已保存'))
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('accountSettings.profile.error', '保存失败')
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="flex items-center gap-4">
          <Avatar className="size-16">
            <AvatarImage
              src={form.avatar_url || undefined}
              alt={user.name || user.username}
            />
            <AvatarFallback className="bg-primary text-lg text-primary-foreground">
              {getInitials(user.name || user.username)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1 space-y-2">
            <Label htmlFor="profile-avatar-url">
              {t('common.fields.avatarUrl', '头像 URL')}
            </Label>
            <Input
              id="profile-avatar-url"
              value={form.avatar_url}
              placeholder="https://…"
              autoComplete="off"
              onChange={(event) => patch('avatar_url', event.target.value)}
            />
          </div>
        </div>

        {externalUser && (
          <Alert>
            <AlertDescription>
              {t(
                'accountSettings.info.externalHint',
                '你的账号由 {{provider}} 管理：昵称、邮箱等字段以目录为准，这里只能修改头像。',
                { provider }
              )}
            </AlertDescription>
          </Alert>
        )}

        <div className="space-y-2">
          <Label htmlFor="profile-name">
            {t('accountSettings.profile.nickname', '昵称')}
          </Label>
          <Input
            id="profile-name"
            autoComplete="name"
            disabled={externalUser}
            value={form.name}
            onChange={(event) => patch('name', event.target.value)}
          />
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="profile-email">
              {t('accountSettings.profile.email', '邮箱')}
            </Label>
            <Input
              id="profile-email"
              type="email"
              autoComplete="email"
              disabled={externalUser}
              value={form.email}
              onChange={(event) => patch('email', event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t(
                'accountSettings.profile.emailHint',
                '用于接收邮件通知，请填写可正常收信的地址。'
              )}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="profile-phone">
              {t('accountSettings.profile.phone', '手机')}
            </Label>
            <Input
              id="profile-phone"
              autoComplete="tel"
              disabled={externalUser}
              value={form.phone}
              onChange={(event) => patch('phone', event.target.value)}
            />
          </div>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="flex justify-end">
          <Button type="submit" disabled={saving}>
            {saving
              ? t('common.actions.saving', '保存中...')
              : t('accountSettings.profile.saveButton', '保存')}
          </Button>
        </div>
      </form>

      {/* 只读信息：由系统维护，只展示不可改。 */}
      <div className="divide-y rounded-lg border px-4 py-2">
        <InfoRow label={t('common.fields.username', '用户名')}>
          <span className="font-mono">{user.username}</span>
        </InfoRow>
        <InfoRow label={t('common.fields.provider', '认证方式')}>
          <span className="capitalize">{provider}</span>
        </InfoRow>
        <InfoRow label={t('common.fields.roles', '角色')}>
          {user.roles && user.roles.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {user.roles.map((role) => (
                <Badge key={role.name} variant="secondary">
                  {role.name}
                </Badge>
              ))}
            </div>
          ) : (
            <span className="text-muted-foreground">-</span>
          )}
        </InfoRow>
        <InfoRow label={t('accountSettings.info.groups', '所属用户组')}>
          {groups.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {groups.map((group) => (
                <Badge key={group} variant="secondary">
                  {group}
                </Badge>
              ))}
            </div>
          ) : (
            <span className="text-muted-foreground">-</span>
          )}
        </InfoRow>
        <InfoRow label={t('common.fields.status', '状态')}>
          {user.enabled === false ? (
            <Badge variant="destructive">
              {t('common.fields.disabled', '已禁用')}
            </Badge>
          ) : (
            <Badge variant="default">{t('common.fields.active', '正常')}</Badge>
          )}
        </InfoRow>
        <InfoRow label={t('common.fields.createdAt', '创建时间')}>
          <span className="text-muted-foreground">
            {user.createdAt ? formatDate(user.createdAt) : '-'}
          </span>
        </InfoRow>
        <InfoRow label={t('common.fields.lastLoginAt', '最后登录')}>
          <span className="text-muted-foreground">
            {user.lastLoginAt ? formatDate(user.lastLoginAt) : '-'}
          </span>
        </InfoRow>
        <InfoRow
          label={t('accountSettings.info.passwordUpdatedAt', '密码修改时间')}
        >
          <span className="text-muted-foreground">
            {user.password_updated_at
              ? formatDate(user.password_updated_at)
              : '-'}
          </span>
        </InfoRow>
      </div>
    </div>
  )
}
