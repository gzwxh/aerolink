import { useState, type FormEvent } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import {
  disableCurrentUserMFA,
  enableCurrentUserMFA,
  setupCurrentUserMFA,
  type MFASetupResponse,
} from '@/lib/api'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { PasswordInput } from '@/components/password-input'

/**
 * 「安全 → 动态码（MFA）」。
 *
 * 绑定流程要先输当前密码再显示二维码（相当于再认证，避免会话被盗后直接改绑定），
 * 停用则要求输入一次有效动态码。全局策略关掉 MFA 时所有按钮置灰并给出说明。
 */
export function MFASection() {
  const { t } = useTranslation()
  const { user, checkAuth, mfaEnabled } = useAuth()
  const [setup, setSetup] = useState<MFASetupResponse | null>(null)
  const [code, setCode] = useState('')
  const [confirmingPassword, setConfirmingPassword] = useState(false)
  const [confirmPassword, setConfirmPassword] = useState('')
  const [confirmError, setConfirmError] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  if (!user) {
    return null
  }

  const controlsDisabled = !mfaEnabled || saving

  const handleEnable = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSaving(true)
    setError('')

    try {
      await enableCurrentUserMFA(code)
      await checkAuth()
      setSetup(null)
      setCode('')
      toast.success(t('accountSettings.security.mfa.enabled', '已启用'))
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('accountSettings.security.mfa.enableError', '启用失败')
      )
    } finally {
      setSaving(false)
    }
  }

  const handleDisable = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSaving(true)
    setError('')

    try {
      await disableCurrentUserMFA(code)
      await checkAuth()
      setCode('')
      toast.success(t('accountSettings.security.mfa.disabled', '已停用'))
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('accountSettings.security.mfa.disableError', '停用失败')
      )
    } finally {
      setSaving(false)
    }
  }

  const closeConfirm = () => {
    setConfirmingPassword(false)
    setConfirmPassword('')
    setConfirmError('')
  }

  const handleConfirmPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSaving(true)
    setConfirmError('')

    try {
      setSetup(await setupCurrentUserMFA(confirmPassword))
      setCode('')
      closeConfirm()
    } catch (err) {
      setConfirmError(
        err instanceof Error
          ? err.message
          : t('accountSettings.security.mfa.setupError', '绑定失败')
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="h-4 w-4" />
            <span>MFA</span>
          </div>
          <Badge variant={user.mfa_enabled ? 'default' : 'secondary'}>
            {user.mfa_enabled
              ? t('accountSettings.enabled', '已启用')
              : t('common.fields.disabled', '已禁用')}
          </Badge>
        </div>

        <p className="text-xs text-muted-foreground">
          {t(
            'accountSettings.security.mfa.description',
            '绑定动态码后，登录与敏感操作会要求输入一次动态码。超级管理员账号建议始终绑定。'
          )}
        </p>

        {!mfaEnabled && (
          <Alert>
            <AlertDescription>
              {t(
                'accountSettings.security.mfa.policyDisabled',
                '当前安全策略已关闭动态码，需要在「安全管理」里启用后才能绑定。'
              )}
            </AlertDescription>
          </Alert>
        )}

        {setup && !user.mfa_enabled && (
          <div className="space-y-3 rounded-md border p-3 sm:max-w-md">
            <div className="flex justify-center">
              <img
                src={setup.qr_code}
                alt={t('accountSettings.security.mfa.qrCodeAlt', 'MFA 二维码')}
                className="size-48"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="account-mfa-otpauth-url">
                {t('accountSettings.security.mfa.otpauthUrl', 'otpauth 链接')}
              </Label>
              <Textarea
                id="account-mfa-otpauth-url"
                value={setup.otpauth_url}
                readOnly
                className="min-h-20 font-mono text-xs"
              />
            </div>
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {user.mfa_enabled ? (
          <form onSubmit={handleDisable} className="space-y-4 sm:max-w-md">
            <div className="space-y-2">
              <Label htmlFor="account-mfa-disable-code">
                {t('accountSettings.security.mfa.authCode', '认证码')}
              </Label>
              <Input
                id="account-mfa-disable-code"
                autoComplete="one-time-code"
                inputMode="numeric"
                required
                disabled={!mfaEnabled}
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </div>
            <div className="flex justify-end">
              <Button
                type="submit"
                variant="outline"
                disabled={controlsDisabled}
              >
                {saving
                  ? t('common.actions.saving', '保存中...')
                  : t('accountSettings.security.mfa.disableButton', '停用 MFA')}
              </Button>
            </div>
          </form>
        ) : setup ? (
          <form onSubmit={handleEnable} className="space-y-4 sm:max-w-md">
            <div className="space-y-2">
              <Label htmlFor="account-mfa-enable-code">
                {t('accountSettings.security.mfa.authCode', '认证码')}
              </Label>
              <Input
                id="account-mfa-enable-code"
                autoComplete="one-time-code"
                inputMode="numeric"
                required
                disabled={!mfaEnabled}
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </div>
            <div className="flex justify-end">
              <Button type="submit" disabled={controlsDisabled}>
                {saving
                  ? t('common.actions.saving', '保存中...')
                  : t('accountSettings.security.mfa.enableButton', '启用 MFA')}
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              disabled={controlsDisabled}
              onClick={() => {
                setError('')
                setConfirmingPassword(true)
              }}
            >
              {t('accountSettings.security.mfa.setupButton', '绑定 MFA')}
            </Button>
          </div>
        )}
      </div>

      <Dialog
        open={confirmingPassword}
        onOpenChange={(next) => {
          if (!next && !saving) {
            closeConfirm()
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t('accountSettings.security.confirmPassword.title', '确认密码')}
            </DialogTitle>
            <DialogDescription>
              {t(
                'accountSettings.security.confirmPassword.description',
                '输入当前密码以确认身份'
              )}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleConfirmPassword} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="account-security-current-password">
                {t('accountSettings.password.currentPassword', '当前密码')}
              </Label>
              <PasswordInput
                id="account-security-current-password"
                autoComplete="current-password"
                required
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
            </div>
            {confirmError && (
              <Alert variant="destructive">
                <AlertDescription>{confirmError}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={closeConfirm}
              >
                {t('common.actions.cancel', '取消')}
              </Button>
              <Button type="submit" disabled={saving}>
                {saving
                  ? t('common.actions.saving', '保存中...')
                  : t('common.actions.continue', '继续')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
