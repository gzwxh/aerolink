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
import {
  isMFAReauthRequired,
  mfaEnrollmentNeedsPassword,
} from '@/lib/mfa-enrollment'
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
 * 显示二维码前要先做一次再认证（避免会话被盗后直接改绑定）：本地密码账号提交当前密码；
 * LDAP 账号没有本地口令，后端要求「最近 5 分钟内重新登录过」，因此这里直接发起绑定，
 * 失败时按 `mfa_reauth_required` 提示重新登录一次。停用则要求输入一次有效动态码。
 *
 * 通用设置关掉动态码功能时按钮置灰并给出说明——安全策略只决定「谁必须绑定」，
 * 不影响自愿绑定，所以这里不再看策略。
 */
export function MFASection() {
  const { t } = useTranslation()
  const { user, checkAuth, mfaAvailable, logout } = useAuth()
  const [setup, setSetup] = useState<MFASetupResponse | null>(null)
  const [code, setCode] = useState('')
  const [confirmingPassword, setConfirmingPassword] = useState(false)
  const [confirmPassword, setConfirmPassword] = useState('')
  const [confirmError, setConfirmError] = useState('')
  const [reauthRequired, setReauthRequired] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  if (!user) {
    return null
  }

  const needsPassword = mfaEnrollmentNeedsPassword(user)
  const controlsDisabled = !mfaAvailable || saving

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

  /** 发起绑定；成功返回 null，失败返回要展示的错误文案。 */
  const startSetup = async (password?: string): Promise<string | null> => {
    setSaving(true)
    setError('')
    setReauthRequired(false)

    try {
      setSetup(await setupCurrentUserMFA(password))
      setCode('')
      return null
    } catch (err) {
      if (isMFAReauthRequired(err)) {
        // 目录账号没有可提交的口令：这里只能让用户重新登录一次，换一个新鲜的会话。
        setReauthRequired(true)
        return t(
          'accountSettings.security.mfa.reauthRequired',
          '为确认是本人操作，绑定动态码需要你在 5 分钟内重新登录过。请退出后重新登录，再回来绑定。'
        )
      }
      return err instanceof Error
        ? err.message
        : t('accountSettings.security.mfa.setupError', '绑定失败')
    } finally {
      setSaving(false)
    }
  }

  const handleConfirmPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setConfirmError('')

    const message = await startSetup(confirmPassword)
    if (message) {
      setConfirmError(message)
      return
    }
    setConfirmPassword('')
    closeConfirm()
  }

  const handleStartEnrollment = async () => {
    setError('')
    setReauthRequired(false)

    // 本地密码账号先确认密码（弹窗里输入）；目录账号直接发起，由后端判定登录新鲜度。
    if (needsPassword) {
      setConfirmingPassword(true)
      return
    }
    const message = await startSetup()
    if (message) {
      setError(message)
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

        {!mfaAvailable && (
          <Alert>
            <AlertDescription>
              {t(
                'accountSettings.security.mfa.featureDisabled',
                '当前部署已在「设置 → 通用」里关闭动态码功能，无法绑定；需要管理员启用后才能使用。'
              )}
            </AlertDescription>
          </Alert>
        )}

        {!needsPassword && !user.mfa_enabled && (
          <p className="text-xs text-muted-foreground">
            {t(
              'accountSettings.security.mfa.directoryHint',
              '目录账号（LDAP）没有本地密码，Kite 以你最近一次登录作为本人确认；若最近没有重新登录过，请先退出并重新登录，再回来绑定。'
            )}
          </p>
        )}

        {reauthRequired && (
          <Alert>
            <AlertDescription className="flex flex-col items-start gap-2">
              <span>
                {t(
                  'accountSettings.security.mfa.reauthRequired',
                  '为确认是本人操作，绑定动态码需要你在 5 分钟内重新登录过。请退出后重新登录，再回来绑定。'
                )}
              </span>
              <Button size="sm" variant="outline" onClick={() => void logout()}>
                {t(
                  'accountSettings.security.mfa.reauthAction',
                  '退出并重新登录'
                )}
              </Button>
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
                disabled={!mfaAvailable}
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
                disabled={!mfaAvailable}
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
                void handleStartEnrollment()
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
