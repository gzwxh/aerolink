import { useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { IconLoader2, IconTrash, IconUpload } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import {
  deleteCurrentUserAvatar,
  updateCurrentUser,
  uploadCurrentUserAvatar,
} from '@/lib/api'
import { AVATAR_MAX_BYTES, prepareAvatarFile } from '@/lib/avatar-upload'
import { normalizeAvatarUrl, resolveAvatarSrc } from '@/lib/avatar-url'
import { statusBadge } from '@/lib/status-badge'
import { formatBytes, formatDate, translateError } from '@/lib/utils'
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
    // 地址栏只表示「外链」：上传的头像地址（/api/...）不放进输入框显示。
    avatar_url: (user?.avatar_url ?? '').startsWith('/api/')
      ? ''
      : (user?.avatar_url ?? ''),
  })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [avatarBusy, setAvatarBusy] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  if (!user) {
    return null
  }

  // 上传的头像由服务端写入 avatar_url（/api/users/<id>/avatar?v=<n>），
  // 所以「当前是不是上传的头像」看这个前缀即可（与 lib/avatar-url 的解析一致）。
  const hasUploadedAvatar = (user.avatar_url ?? '').startsWith('/api/')

  const handleAvatarUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    // 清空 input：否则再次选择同一个文件不会触发 change。
    event.target.value = ''
    if (!file) {
      return
    }

    setAvatarBusy(true)
    setError('')
    try {
      // 在浏览器里裁方、缩放、重编码，随后才上传（限制说明见 avatar-upload.ts）。
      const prepared = await prepareAvatarFile(file)
      await uploadCurrentUserAvatar(prepared)
      await checkAuth()
      // 重新取一次用户对象里的 avatar_url，让预览立刻用上新地址。
      setForm((prev) => ({ ...prev, avatar_url: '' }))
      toast.success(t('accountSettings.profile.avatarUploadSuccess'))
    } catch (err) {
      setError(
        translateError(err, t) ||
          t('accountSettings.profile.avatarUploadFailed')
      )
    } finally {
      setAvatarBusy(false)
    }
  }

  const handleAvatarRemove = async () => {
    setAvatarBusy(true)
    setError('')
    try {
      await deleteCurrentUserAvatar()
      await checkAuth()
      setForm((prev) => ({ ...prev, avatar_url: '' }))
      toast.success(t('accountSettings.profile.avatarRemoveSuccess'))
    } catch (err) {
      setError(translateError(err, t))
    } finally {
      setAvatarBusy(false)
    }
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
      // 头像三态：填了外链就以它为准；否则保留上传的头像（地址栏是空的，
      // 不能当成「清空」提交，后端会按不变式删掉上传的字节行）；两者都没有就清空。
      const typedUrl = normalizeAvatarUrl(form.avatar_url)
      const avatarPayload = typedUrl
        ? { avatar_url: typedUrl }
        : hasUploadedAvatar
          ? { avatar_url: user.avatar_url ?? '' }
          : { avatar_url: '' }
      const payload = externalUser
        ? avatarPayload
        : {
            name: form.name.trim(),
            email: form.email.trim(),
            phone: form.phone.trim(),
            ...avatarPayload,
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
        <div className="flex items-start gap-4">
          <Avatar className="size-16">
            <AvatarImage
              /* 上传的头像即时生效（已落库），未上传时按表单里的外链预览。 */
              src={
                hasUploadedAvatar
                  ? resolveAvatarSrc(user.avatar_url)
                  : resolveAvatarSrc(form.avatar_url)
              }
              alt={user.name || user.username}
            />
            <AvatarFallback className="bg-primary text-lg text-primary-foreground">
              {getInitials(user.name || user.username)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={avatarBusy}
                onClick={() => fileInputRef.current?.click()}
              >
                {avatarBusy ? (
                  <IconLoader2 className="size-4 animate-spin" />
                ) : (
                  <IconUpload className="size-4" />
                )}
                {avatarBusy
                  ? t('accountSettings.profile.avatarUploading')
                  : t('accountSettings.profile.avatarUpload')}
              </Button>
              {hasUploadedAvatar && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={avatarBusy}
                  onClick={() => void handleAvatarRemove()}
                >
                  <IconTrash className="size-4" />
                  {t('accountSettings.profile.avatarRemove')}
                </Button>
              )}
              {/* 真正的 file input 藏在按钮后面：原生控件样式与界面不统一。 */}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => void handleAvatarUpload(event)}
              />
            </div>
            {hasUploadedAvatar && (
              <p className="text-xs text-muted-foreground">
                {t('accountSettings.profile.avatarUploadedHint')}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {t('accountSettings.profile.avatarUploadHint', {
                limit: formatBytes(AVATAR_MAX_BYTES),
              })}
            </p>
            <div className="space-y-1.5 pt-1">
              <Label htmlFor="profile-avatar-url">
                {t('accountSettings.profile.avatarUrlLabel')}
              </Label>
              <Input
                id="profile-avatar-url"
                value={form.avatar_url}
                placeholder="https://…"
                autoComplete="off"
                onChange={(event) => patch('avatar_url', event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t('accountSettings.profile.avatarUrlHint')}
              </p>
            </div>
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
            <Badge {...statusBadge('warning')}>
              {t('common.fields.disabled', '已禁用')}
            </Badge>
          ) : (
            <Badge {...statusBadge('success')}>
              {t('common.fields.active', '正常')}
            </Badge>
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
