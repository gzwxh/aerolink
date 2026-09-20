import { useState, type FormEvent } from 'react'
import { KeyRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { changeCurrentUserPassword } from '@/lib/api'
import { buildPasswordRules, isPasswordRulesValid } from '@/lib/password-rules'
import { translateError } from '@/lib/utils'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { PasswordInput } from '@/components/password-input'
import { PasswordRulesPanel } from '@/components/password-rules-panel'

/**
 * 「安全 → 修改密码」。
 *
 * 需要先输入当前密码（相当于一次再认证，防止会话被盗后直接改密码），新密码的实时
 * 规则提示用默认策略（8~30 位 + 至少三类字符）；管理员调高策略时由后端兜底，
 * 错误经 translateError 显示。目录用户的密码由身份源管理，不显示本区块。
 */
export function PasswordSection() {
  const { t } = useTranslation()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [newPasswordFocused, setNewPasswordFocused] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const passwordRules = buildPasswordRules(newPassword, t)
  const passwordValid = isPasswordRulesValid(passwordRules)
  const passwordTouched = newPassword.length > 0
  const confirmMismatch =
    confirmPassword.length > 0 && confirmPassword !== newPassword

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')

    // 密码要求与两次一致性由输入框旁实时提示，不满足时直接拦截提交。
    if (!passwordValid || confirmMismatch) {
      return
    }

    setSaving(true)
    try {
      await changeCurrentUserPassword(currentPassword, newPassword)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      toast.success(t('accountSettings.password.changed', '密码已修改'))
    } catch (err) {
      setError(
        translateError(err, t) ||
          t('accountSettings.password.error', '修改失败')
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="flex items-center gap-2 text-sm font-medium">
        <KeyRound className="h-4 w-4" />
        <span>{t('common.fields.password', '密码')}</span>
      </div>

      <div className="space-y-2 sm:max-w-md">
        <Label htmlFor="account-current-password">
          {t('accountSettings.password.currentPassword', '当前密码')}
        </Label>
        <PasswordInput
          id="account-current-password"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
        />
      </div>

      <div className="relative space-y-2 sm:max-w-md">
        <Label htmlFor="account-new-password">
          {t('accountSettings.password.newPassword', '新密码')}
        </Label>
        <PasswordInput
          id="account-new-password"
          autoComplete="new-password"
          required
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          onFocus={() => setNewPasswordFocused(true)}
          onBlur={() => setNewPasswordFocused(false)}
          aria-invalid={passwordTouched && !passwordValid}
          className={
            passwordTouched && !passwordValid
              ? 'border-red-500 focus-visible:ring-red-500'
              : undefined
          }
        />
        <PasswordRulesPanel
          rules={passwordRules}
          touched={passwordTouched}
          focused={newPasswordFocused}
        />
      </div>

      <div className="space-y-2 sm:max-w-md">
        <Label htmlFor="account-confirm-password">
          {t('accountSettings.password.confirmNewPassword', '确认新密码')}
        </Label>
        <PasswordInput
          id="account-confirm-password"
          autoComplete="new-password"
          required
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          aria-invalid={confirmMismatch}
          className={
            confirmMismatch
              ? 'border-red-500 focus-visible:ring-red-500'
              : undefined
          }
        />
        {/* 两次密码不一致：内联提示在确认密码框正下方 */}
        {confirmMismatch && (
          <p className="text-xs text-red-600">
            {t('accountSettings.password.mismatch', '两次输入的密码不一致')}
          </p>
        )}
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex justify-end sm:max-w-md">
        <Button type="submit" disabled={saving}>
          {saving
            ? t('common.actions.saving', '保存中...')
            : t('accountSettings.password.changeButton', '修改密码')}
        </Button>
      </div>
    </form>
  )
}
