import { useCallback, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { createPasswordUser, fetchSecuritySetting } from '@/lib/api'
import { fetchAPI } from '@/lib/api/shared'
import {
  buildPasswordRules,
  DEFAULT_PASSWORD_LIMITS,
  isPasswordRulesValid,
} from '@/lib/password-rules'
import { translateError } from '@/lib/utils'
import {
  useDraftDirty,
  useUnsavedChangesGuard,
} from '@/hooks/use-unsaved-changes-guard'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import { PasswordInput } from '@/components/password-input'
import { PasswordRulesPanel } from '@/components/password-rules-panel'
import { UnsavedChangesConfirmDialog } from '@/components/unsaved-changes-confirm-dialog'

/**
 * 新建密码用户（弹窗）：与角色 / 权限绑定的编辑弹窗保持同一套交互。
 * 分「账户 / 认证 / 其它」三段，创建成功后关闭弹窗并刷新用户列表。
 */
export function UserFormDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
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
    remark: '',
    groups: [] as string[],
    // MFA 级别：启用=跟随全局策略；禁用=该账号不受策略强制。
    mfaDisabled: false,
  })
  const [saving, setSaving] = useState(false)
  const [passwordFocused, setPasswordFocused] = useState(false)
  // 草稿就在本组件里（弹窗仅在打开时挂载，首帧空表单即基线）；
  // 由 useUnsavedChangesGuard 统一拦截遮罩点击 / Esc / 右上角 X / 取消按钮。
  const isDirty = useDraftDirty(form)
  const close = useCallback(() => onClose(), [onClose])
  const guard = useUnsavedChangesGuard({ dirty: isDirty, onClose: close })

  // 密码实时校验：策略值来自安全设置，与后端 ValidatePassword 保持一致。
  const passwordLimits = {
    minLength:
      (securitySetting as { passwordMinLength?: number } | undefined)
        ?.passwordMinLength ?? DEFAULT_PASSWORD_LIMITS.minLength,
    maxLength: DEFAULT_PASSWORD_LIMITS.maxLength,
    minClasses:
      (securitySetting as { passwordMinClasses?: number } | undefined)
        ?.passwordMinClasses ?? DEFAULT_PASSWORD_LIMITS.minClasses,
  }
  const passwordRules = buildPasswordRules(form.password, t, passwordLimits)
  const passwordValid = isPasswordRulesValid(passwordRules)
  const passwordTouched = form.password.length > 0

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
    // 密码要求由输入框旁的面板实时提示，不满足时直接拦截提交。
    if (!passwordValid) {
      toast.error(
        t('createUser.passwordInvalid', '密码要求未满足，请按提示调整密码。')
      )
      return
    }
    setSaving(true)
    try {
      await createPasswordUser({
        username: form.username,
        name: form.name || undefined,
        password: form.password,
        email: form.email || undefined,
        phone: form.phone || undefined,
        remark: form.remark || undefined,
        groups: form.groups,
        mfaDisabled: form.mfaDisabled,
      })
      await queryClient.invalidateQueries({ queryKey: ['user-list'] })
      toast.success(
        t('common.messages.created', {
          resource: t('common.fields.user', 'User'),
          defaultValue: '用户已创建',
        })
      )
      close()
    } catch (error) {
      // 弹窗保留以便修改后重试，同时给一次即时反馈。
      toast.error(translateError(error, t))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Dialog open onOpenChange={guard.handleOpenChange}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t('createUser.title', '新建用户')}</DialogTitle>
            <DialogDescription>
              {t('createUser.accountHint', '登录名在全部来源中必须唯一')}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* 账户 */}
            <div className="space-y-3 rounded-md border p-3">
              <div className="font-medium">
                {t('createUser.sections.account', '账户')}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="user-username">
                    {t('common.fields.username', '用户名')} *
                  </Label>
                  <Input
                    id="user-username"
                    required
                    value={form.username}
                    onChange={(e) =>
                      setForm({ ...form, username: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="user-name">
                    {t('common.fields.name', '名称')}
                  </Label>
                  <Input
                    id="user-name"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="user-email">
                    {t('common.fields.email', '邮箱')}
                  </Label>
                  <Input
                    id="user-email"
                    type="email"
                    placeholder="user@example.com"
                    value={form.email}
                    onChange={(e) =>
                      setForm({ ...form, email: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label>{t('userManagement.fields.groups', '用户组')}</Label>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        className="w-full justify-between font-normal"
                      >
                        {form.groups.length > 0
                          ? `${t('userManagement.fields.groups', '用户组')}：${form.groups.join('、')}`
                          : t(
                              'createUser.selectGroups',
                              '选择用户组（可多选）'
                            )}
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
                  <p className="text-xs text-muted-foreground">
                    {t(
                      'createUser.groupsHint',
                      '新用户会加入所选用户组；用户组可同时包含本地与 LDAP / OIDC 账号。'
                    )}
                  </p>
                </div>
              </div>
            </div>

            {/* 认证 */}
            <div className="space-y-3 rounded-md border p-3">
              <div className="font-medium">
                {t('createUser.sections.authentication', '认证')}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="user-password">
                      {t('common.fields.password', '密码')} *
                    </Label>
                    <button
                      type="button"
                      className="text-xs text-primary hover:underline"
                      onClick={() =>
                        setForm({ ...form, password: randomPassword() })
                      }
                    >
                      {t('createUser.randomPassword', '随机生成')}
                    </button>
                  </div>
                  <div className="relative">
                    <PasswordInput
                      id="user-password"
                      required
                      value={form.password}
                      onChange={(e) =>
                        setForm({ ...form, password: e.target.value })
                      }
                      onFocus={() => setPasswordFocused(true)}
                      onBlur={() => setPasswordFocused(false)}
                      aria-invalid={passwordTouched && !passwordValid}
                      className={
                        passwordTouched && !passwordValid
                          ? 'border-destructive focus-visible:ring-destructive'
                          : undefined
                      }
                    />
                    <PasswordRulesPanel
                      rules={passwordRules}
                      touched={passwordTouched}
                      focused={passwordFocused}
                    />
                  </div>
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
                        {t(
                          'createUser.mfaLevels.enabled',
                          '启用（跟随全局策略）'
                        )}
                      </SelectItem>
                      <SelectItem value="disabled">
                        {t('createUser.mfaLevels.disabled', '禁用')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {t('createUser.mfaLevelHint', '当前全局策略：')}
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
              </div>
            </div>

            {/* 其它 */}
            <div className="space-y-3 rounded-md border p-3">
              <div className="font-medium">
                {t('createUser.sections.other', '其它')}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="user-phone">
                    {t('common.fields.phone', '手机')}
                  </Label>
                  <Input
                    id="user-phone"
                    value={form.phone}
                    onChange={(e) =>
                      setForm({ ...form, phone: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="user-remark">
                    {t('common.fields.remark', '备注')}
                  </Label>
                  <Input
                    id="user-remark"
                    value={form.remark}
                    onChange={(e) =>
                      setForm({ ...form, remark: e.target.value })
                    }
                  />
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => guard.handleOpenChange(false)}
                disabled={saving}
              >
                {t('common.actions.cancel', '取消')}
              </Button>
              <Button type="submit" disabled={saving}>
                {saving
                  ? t('common.actions.creating', '创建中...')
                  : t('common.actions.create', '创建')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <UnsavedChangesConfirmDialog {...guard.confirmDialogProps} />
    </>
  )
}

export default UserFormDialog
