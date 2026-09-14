import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { createPasswordUser, fetchSecuritySetting } from '@/lib/api'
import { fetchAPI } from '@/lib/api/shared'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/**
 * 创建密码用户（独立页面）：/settings/users/create
 * 分「账户 / 认证 / 其它」三段；提交成功后回到 /settings/users。
 */
export function UserCreatePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: knownGroups = [] } = useQuery({
    queryKey: ['known-groups'],
    queryFn: async () => {
      const result = await fetchAPI<unknown>('/admin/groups')
      const list = Array.isArray(result)
        ? result
        : ((result as { groups?: unknown[] }).groups ?? [])
      return list
        .map((item) =>
          typeof item === 'string'
            ? item
            : ((item as { name?: string }).name ?? '')
        )
        .filter(Boolean)
    },
    staleTime: 60000,
  })
  const { data: securitySetting } = useQuery({
    queryKey: ['security-setting'],
    queryFn: fetchSecuritySetting,
    staleTime: 60000,
  })
  const mfaPolicy =
    (securitySetting as { mfaPolicy?: string } | undefined)?.mfaPolicy ??
    'disabled'

  const [form, setForm] = useState({
    username: '',
    name: '',
    password: '',
    email: '',
    phone: '',
    wechat: '',
    remark: '',
    expiresAt: '',
    groups: [] as string[],
    // MFA 级别：启用=跟随全局策略；禁用=该账号不受策略强制。
    mfaDisabled: false,
  })
  const [saving, setSaving] = useState(false)

  const randomPassword = () => {
    const charset =
      'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*'
    const values = new Uint32Array(16)
    crypto.getRandomValues(values)
    return Array.from(values, (value) => charset[value % charset.length]).join(
      ''
    )
  }

  const toggleGroup = (value: string) => {
    setForm((previous) => {
      const selected = previous.groups.includes(value)
      return {
        ...previous,
        groups: selected
          ? previous.groups.filter((item) => item !== value)
          : [...previous.groups, value],
      }
    })
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setSaving(true)
    try {
      await createPasswordUser({
        username: form.username,
        name: form.name || undefined,
        password: form.password,
        email: form.email || undefined,
        phone: form.phone || undefined,
        wechat: form.wechat || undefined,
        remark: form.remark || undefined,
        expiresAt: form.expiresAt || undefined,
        groups: form.groups,
        mfaDisabled: form.mfaDisabled,
      } as Parameters<typeof createPasswordUser>[0])
      await queryClient.invalidateQueries({ queryKey: ['user-list'] })
      toast.success(t('common.messages.created', { defaultValue: 'User created' }))
      navigate('/settings/user?tab=users')
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t('common.messages.failedToCreate', { defaultValue: '创建失败' })
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('createUser.sections.account', '账户')}</CardTitle>
          <CardDescription>
            {t('createUser.accountHint', '登录名在全部来源中必须唯一')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="username">
                {t('common.fields.username', '用户名')}
              </Label>
              <Input
                id="username"
                required
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="name">{t('common.fields.name', '名称')}</Label>
              <Input
                id="name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">{t('common.fields.email', '邮箱')}</Label>
            <Input
              id="email"
              type="email"
              placeholder="user@example.com"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label>{t('userManagement.fields.groups', '用户组')}</Label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" className="w-full justify-between">
                  {form.groups.length > 0
                    ? `${t('userManagement.fields.groups', '用户组')}：${form.groups.join('、')}`
                    : t('createUser.selectGroups', '选择用户组（可多选）')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="max-h-64 w-72 overflow-y-auto">
                {knownGroups.length === 0 && (
                  <p className="px-2 py-3 text-xs text-muted-foreground">
                    {t('createUser.noGroups', '暂无可选用户组')}
                  </p>
                )}
                {knownGroups.map((group) => (
                  <DropdownMenuCheckboxItem
                    key={group}
                    checked={form.groups.includes(group)}
                    onCheckedChange={() => toggleGroup(group)}
                    onSelect={(event) => event.preventDefault()}
                  >
                    {group}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            {t('createUser.sections.authentication', '认证')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">
                {t('common.fields.password', '密码')}
              </Label>
              <button
                type="button"
                className="text-xs text-primary hover:underline"
                onClick={() => setForm({ ...form, password: randomPassword() })}
              >
                {t('createUser.randomPassword', '随机生成')}
              </button>
            </div>
            <Input
              id="password"
              required
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label>{t('createUser.fields.mfaLevel', 'MFA 级别')}</Label>
            <Select
              value={form.mfaDisabled ? 'disabled' : 'enabled'}
              onValueChange={(value) =>
                setForm({ ...form, mfaDisabled: value === 'disabled' })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="enabled">
                  {t('createUser.mfaLevels.enabled', '启用（跟随全局策略）')}
                </SelectItem>
                <SelectItem value="disabled">
                  {t('createUser.mfaLevels.disabled', '禁用')}
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t(
                'createUser.mfaLevelHint',
                '当前全局策略：'
              )}
              {t(
                `createUser.mfaPolicy.${mfaPolicy}`,
                mfaPolicy === 'required'
                  ? '强制'
                  : mfaPolicy === 'optional'
                    ? '启用（可选）'
                    : '禁用'
              )}
              {t(
                'createUser.mfaLevelHintSuffix',
                '；选择「禁用」的账号不受策略强制'
              )}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('createUser.sections.other', '其它')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="phone">{t('common.fields.phone', '手机')}</Label>
            <Input
              id="phone"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="wechat">{t('common.fields.wechat', '微信')}</Label>
            <Input
              id="wechat"
              value={form.wechat}
              onChange={(e) => setForm({ ...form, wechat: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="remark">{t('common.fields.remark', '备注')}</Label>
            <Input
              id="remark"
              value={form.remark}
              onChange={(e) => setForm({ ...form, remark: e.target.value })}
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => navigate('/settings/user?tab=users')}
        >
          {t('common.actions.cancel', '取消')}
        </Button>
        <Button type="submit" disabled={saving}>
          {saving
            ? t('common.messages.creating', '创建中...')
            : t('common.actions.create', '创建')}
        </Button>
      </div>
    </form>
  )
}
