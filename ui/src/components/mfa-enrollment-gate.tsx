import { useState, type FormEvent, type ReactNode } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { IconShieldLock } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import {
  enableCurrentUserMFA,
  setupCurrentUserMFA,
  type MFASetupResponse,
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
import { PasswordInput } from '@/components/password-input'

/**
 * 当安全策略要求已登录用户注册 MFA 时阻塞应用。
 * 在注册完成之前，后端会以 `mfa_setup_required` 拒绝其它请求，
 * 因此该关卡不可关闭。
 */
export function MFAEnrollmentGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const [setup, setSetup] = useState<MFASetupResponse | null>(null)
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [isPending, setIsPending] = useState(false)

  const needsEnrollment = Boolean(user?.mfa_required) && !user?.mfa_enabled
  if (!needsEnrollment) {
    return <>{children}</>
  }

  const handleStart = async (event: FormEvent) => {
    event.preventDefault()
    if (!password.trim()) {
      setError(
        t(
          'mfaEnrollment.errors.passwordRequired',
          'Current password is required'
        )
      )
      return
    }

    setIsPending(true)
    setError('')
    try {
      setSetup(await setupCurrentUserMFA(password))
      setPassword('')
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('mfaEnrollment.errors.loadFailed', 'Failed to start MFA setup')
      )
    } finally {
      setIsPending(false)
    }
  }

  const handleEnable = async (event: FormEvent) => {
    event.preventDefault()
    setIsPending(true)
    setError('')
    try {
      await enableCurrentUserMFA(code)
      toast.success(t('mfaEnrollment.success', 'MFA enabled'))
      // 绑定生效的瞬间，页面上其他在途请求仍可能被 mfa_setup_required
      // 拒绝；整页重载以确保以最新身份状态干净加载。
      window.location.reload()
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('mfaEnrollment.errors.enableFailed', 'Failed to enable MFA')
      )
    } finally {
      setIsPending(false)
    }
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <IconShieldLock className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-center">
            {t(
              'mfaEnrollment.title',
              'Multi-factor authentication is required'
            )}
          </CardTitle>
          <CardDescription className="text-center">
            {t(
              'mfaEnrollment.description',
              'An administrator requires MFA for your account. Bind an authenticator app to continue.'
            )}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {!setup ? (
            <form className="space-y-4" onSubmit={handleStart}>
              <p className="text-sm text-muted-foreground">
                {t(
                  'mfaEnrollment.passwordStepHint',
                  '为防止会话被盗用，请先验证当前密码；验证通过后将显示绑定二维码，用身份验证器 App 扫码即可完成绑定。'
                )}
              </p>
              <div className="space-y-2">
                <Label htmlFor="mfa-enroll-password">
                  {t('mfaEnrollment.passwordLabel', 'Current password')}
                </Label>
                <PasswordInput
                  id="mfa-enroll-password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}

              <Button type="submit" className="w-full" disabled={isPending}>
                {t('mfaEnrollment.continue', 'Continue')}
              </Button>
            </form>
          ) : (
            <form className="space-y-4" onSubmit={handleEnable}>
              <p className="text-sm text-muted-foreground">
                {t(
                  'mfaEnrollment.scanHint',
                  'Scan the QR code with your authenticator app, then enter the 6-digit code it shows.'
                )}
              </p>

              <div className="flex justify-center">
                <img
                  src={setup.qr_code}
                  alt={t('mfaEnrollment.qrAlt', 'MFA QR code')}
                  className="h-44 w-44 rounded-md border bg-white p-1"
                />
              </div>

              <div className="space-y-1">
                <Label>{t('mfaEnrollment.secretLabel', 'Secret')}</Label>
                <code className="block break-all rounded-md border bg-muted/50 px-2 py-1 text-xs">
                  {setup.secret}
                </code>
              </div>

              <div className="space-y-2">
                <Label htmlFor="mfa-enroll-code">
                  {t('mfaEnrollment.codeLabel', 'Verification code')}
                </Label>
                <Input
                  id="mfa-enroll-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="000000"
                  value={code}
                  onChange={(event) =>
                    setCode(event.target.value.replace(/\D/g, '').slice(0, 6))
                  }
                />
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}

              <Button
                type="submit"
                className="w-full"
                disabled={isPending || code.length !== 6}
              >
                {t('mfaEnrollment.enable', 'Enable MFA')}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
