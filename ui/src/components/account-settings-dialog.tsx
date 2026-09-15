import { useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { KeyRound, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import {
  changeCurrentUserPassword,
  disableCurrentUserMFA,
  enableCurrentUserMFA,
  setupCurrentUserMFA,
  updateCurrentUser,
  type MFASetupResponse,
} from '@/lib/api'
import { buildPasswordRules, isPasswordRulesValid } from '@/lib/password-rules'
import { translateError } from '@/lib/utils'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { PasswordInput } from '@/components/password-input'
import { PasswordRulesPanel } from '@/components/password-rules-panel'

interface AccountSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AccountSettingsDialog({
  open,
  onOpenChange,
}: AccountSettingsDialogProps) {
  const { t } = useTranslation()
  const { user, checkAuth, mfaEnabled } = useAuth()
  const [nickname, setNickname] = useState(user?.name || '')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  // 修改密码的实时校验：默认策略（8~30 位 + 至少三类字符）。
  // 管理员调高策略时由后端兜底，错误经 translateError 显示中文。
  const passwordRules = buildPasswordRules(newPassword, t)
  const passwordValid = isPasswordRulesValid(passwordRules)
  const passwordTouched = newPassword.length > 0
  const confirmMismatch =
    confirmPassword.length > 0 && confirmPassword !== newPassword
  const [newPasswordFocused, setNewPasswordFocused] = useState(false)
  const [mfaSetup, setMFASetup] = useState<MFASetupResponse | null>(null)
  const [mfaCode, setMFACode] = useState('')
  const [passwordConfirmAction, setPasswordConfirmAction] = useState<
    'mfa' | null
  >(null)
  const [securityCurrentPassword, setSecurityCurrentPassword] = useState('')
  const [securityPasswordError, setSecurityPasswordError] = useState('')
  const [profileError, setProfileError] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [mfaError, setMFAError] = useState('')
  const [savingProfile, setSavingProfile] = useState(false)
  const [savingPassword, setSavingPassword] = useState(false)
  const [savingMFA, setSavingMFA] = useState(false)

  useEffect(() => {
    if (!open) {
      setPasswordConfirmAction(null)
      setSecurityCurrentPassword('')
      setSecurityPasswordError('')
      return
    }

    setNickname(user?.name || '')
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
    setMFASetup(null)
    setMFACode('')
    setPasswordConfirmAction(null)
    setSecurityCurrentPassword('')
    setSecurityPasswordError('')
    setProfileError('')
    setPasswordError('')
    setMFAError('')
  }, [open, user?.name])

  if (!user) return null

  const isPasswordUser = !user.provider || user.provider === 'password'
  if (!isPasswordUser) return null

  const mfaControlsDisabled = !mfaEnabled || savingMFA

  const handleUpdateProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSavingProfile(true)
    setProfileError('')

    try {
      await updateCurrentUser({ name: nickname.trim() })
      await checkAuth()
      toast.success(t('accountSettings.profile.saved', 'Account updated'))
    } catch (error) {
      setProfileError(
        error instanceof Error
          ? error.message
          : t('accountSettings.profile.error', 'Failed to update account')
      )
    } finally {
      setSavingProfile(false)
    }
  }

  const handleChangePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setPasswordError('')

    // 密码要求与两次一致性由输入框旁实时提示，不满足时直接拦截提交。
    if (!passwordValid || confirmMismatch) {
      return
    }

    setSavingPassword(true)
    try {
      await changeCurrentUserPassword(currentPassword, newPassword)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      toast.success(t('accountSettings.password.changed', 'Password changed'))
    } catch (error) {
      setPasswordError(
        translateError(error, t) ||
          t('accountSettings.password.error', 'Failed to change password')
      )
    } finally {
      setSavingPassword(false)
    }
  }

  const handleEnableMFA = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSavingMFA(true)
    setMFAError('')

    try {
      await enableCurrentUserMFA(mfaCode)
      await checkAuth()
      setMFASetup(null)
      setMFACode('')
      toast.success(t('accountSettings.security.mfa.enabled', 'MFA enabled'))
    } catch (error) {
      setMFAError(
        error instanceof Error
          ? error.message
          : t(
              'accountSettings.security.mfa.enableError',
              'Failed to enable MFA'
            )
      )
    } finally {
      setSavingMFA(false)
    }
  }

  const handleDisableMFA = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSavingMFA(true)
    setMFAError('')

    try {
      await disableCurrentUserMFA(mfaCode)
      await checkAuth()
      setMFACode('')
      toast.success(t('accountSettings.security.mfa.disabled', 'MFA disabled'))
    } catch (error) {
      setMFAError(
        error instanceof Error
          ? error.message
          : t(
              'accountSettings.security.mfa.disableError',
              'Failed to disable MFA'
            )
      )
    } finally {
      setSavingMFA(false)
    }
  }

  const openPasswordConfirm = (action: 'mfa') => {
    setPasswordConfirmAction(action)
    setSecurityCurrentPassword('')
    setSecurityPasswordError('')
    setMFAError('')
  }

  const closePasswordConfirm = () => {
    setPasswordConfirmAction(null)
    setSecurityCurrentPassword('')
    setSecurityPasswordError('')
  }

  const handleConfirmCurrentPassword = async (
    event: FormEvent<HTMLFormElement>
  ) => {
    event.preventDefault()
    if (!passwordConfirmAction) return

    setSecurityPasswordError('')

    if (passwordConfirmAction === 'mfa') {
      setSavingMFA(true)
      try {
        setMFASetup(await setupCurrentUserMFA(securityCurrentPassword))
        setMFACode('')
        closePasswordConfirm()
      } catch (error) {
        setSecurityPasswordError(
          error instanceof Error
            ? error.message
            : t(
                'accountSettings.security.mfa.setupError',
                'Failed to set up MFA'
              )
        )
      } finally {
        setSavingMFA(false)
      }
      return
    }
  }

  const passwordConfirmLoading = savingMFA

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {t('accountSettings.title', 'Account Settings')}
            </DialogTitle>
          </DialogHeader>

          <Tabs defaultValue="profile" className="gap-4">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="profile">
                {t('accountSettings.tabs.profile', 'Profile')}
              </TabsTrigger>
              <TabsTrigger value="password">
                {t('accountSettings.tabs.password', 'Password')}
              </TabsTrigger>
              <TabsTrigger value="security">
                {t('accountSettings.tabs.security', 'Security')}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="profile">
              <form onSubmit={handleUpdateProfile} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="account-nickname">
                    {t('accountSettings.profile.nickname', 'Nickname')}
                  </Label>
                  <Input
                    id="account-nickname"
                    autoComplete="name"
                    value={nickname}
                    onChange={(event) => setNickname(event.target.value)}
                  />
                </div>
                {profileError && (
                  <Alert variant="destructive">
                    <AlertDescription>{profileError}</AlertDescription>
                  </Alert>
                )}
                <div className="flex justify-end">
                  <Button type="submit" disabled={savingProfile}>
                    {savingProfile
                      ? t('common.actions.saving', 'Saving...')
                      : t('accountSettings.profile.saveButton', 'Save Profile')}
                  </Button>
                </div>
              </form>
            </TabsContent>

            <TabsContent value="password">
              <form onSubmit={handleChangePassword} className="space-y-4">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <KeyRound className="h-4 w-4" />
                  <span>{t('common.fields.password', 'Password')}</span>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="account-current-password">
                    {t(
                      'accountSettings.password.currentPassword',
                      'Current Password'
                    )}
                  </Label>
                  <PasswordInput
                    id="account-current-password"
                    autoComplete="current-password"
                    required
                    value={currentPassword}
                    onChange={(event) => setCurrentPassword(event.target.value)}
                  />
                </div>
                <div className="relative space-y-2">
                  <Label htmlFor="account-new-password">
                    {t('accountSettings.password.newPassword', 'New Password')}
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
                <div className="space-y-2">
                  <Label htmlFor="account-confirm-password">
                    {t(
                      'accountSettings.password.confirmNewPassword',
                      'Confirm New Password'
                    )}
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
                      {t(
                        'accountSettings.password.mismatch',
                        'New passwords do not match'
                      )}
                    </p>
                  )}
                </div>
                {passwordError && (
                  <Alert variant="destructive">
                    <AlertDescription>{passwordError}</AlertDescription>
                  </Alert>
                )}
                <div className="flex justify-end">
                  <Button type="submit" disabled={savingPassword}>
                    {savingPassword
                      ? t('common.actions.saving', 'Saving...')
                      : t(
                          'accountSettings.password.changeButton',
                          'Change Password'
                        )}
                  </Button>
                </div>
              </form>
            </TabsContent>

            <TabsContent value="security">
              <div className="space-y-6">
                <div className="space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <ShieldCheck className="h-4 w-4" />
                      <span>MFA</span>
                    </div>
                    <Badge variant={user.mfa_enabled ? 'default' : 'secondary'}>
                      {user.mfa_enabled
                        ? t('common.fields.enabled', 'Enabled')
                        : t('common.fields.disabled', 'Disabled')}
                    </Badge>
                  </div>

                  {mfaSetup && !user.mfa_enabled && (
                    <div className="space-y-3 rounded-md border p-3">
                      <div className="flex justify-center">
                        <img
                          src={mfaSetup.qr_code}
                          alt={t(
                            'accountSettings.security.mfa.qrCodeAlt',
                            'MFA QR code'
                          )}
                          className="size-48"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="account-mfa-otpauth-url">
                          {t(
                            'accountSettings.security.mfa.otpauthUrl',
                            'otpauth URL'
                          )}
                        </Label>
                        <Textarea
                          id="account-mfa-otpauth-url"
                          value={mfaSetup.otpauth_url}
                          readOnly
                          className="min-h-20 font-mono text-xs"
                        />
                      </div>
                    </div>
                  )}

                  {mfaError && (
                    <Alert variant="destructive">
                      <AlertDescription>{mfaError}</AlertDescription>
                    </Alert>
                  )}

                  {user.mfa_enabled ? (
                    <form onSubmit={handleDisableMFA} className="space-y-4">
                      <div className="space-y-2">
                        <Label htmlFor="account-mfa-disable-code">
                          {t(
                            'accountSettings.security.mfa.authCode',
                            'Authentication Code'
                          )}
                        </Label>
                        <Input
                          id="account-mfa-disable-code"
                          autoComplete="one-time-code"
                          inputMode="numeric"
                          required
                          disabled={!mfaEnabled}
                          value={mfaCode}
                          onChange={(event) => setMFACode(event.target.value)}
                        />
                      </div>
                      <div className="flex justify-end">
                        <Button
                          type="submit"
                          variant="outline"
                          disabled={mfaControlsDisabled}
                        >
                          {savingMFA
                            ? t('common.actions.saving', 'Saving...')
                            : t(
                                'accountSettings.security.mfa.disableButton',
                                'Disable MFA'
                              )}
                        </Button>
                      </div>
                    </form>
                  ) : mfaSetup ? (
                    <form onSubmit={handleEnableMFA} className="space-y-4">
                      <div className="space-y-2">
                        <Label htmlFor="account-mfa-enable-code">
                          {t(
                            'accountSettings.security.mfa.authCode',
                            'Authentication Code'
                          )}
                        </Label>
                        <Input
                          id="account-mfa-enable-code"
                          autoComplete="one-time-code"
                          inputMode="numeric"
                          required
                          disabled={!mfaEnabled}
                          value={mfaCode}
                          onChange={(event) => setMFACode(event.target.value)}
                        />
                      </div>
                      <div className="flex justify-end">
                        <Button type="submit" disabled={mfaControlsDisabled}>
                          {savingMFA
                            ? t('common.actions.saving', 'Saving...')
                            : t(
                                'accountSettings.security.mfa.enableButton',
                                'Enable MFA'
                              )}
                        </Button>
                      </div>
                    </form>
                  ) : (
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        variant="outline"
                        disabled={mfaControlsDisabled}
                        onClick={() => openPasswordConfirm('mfa')}
                      >
                        {savingMFA
                          ? t('common.actions.saving', 'Saving...')
                          : t(
                              'accountSettings.security.mfa.setupButton',
                              'Set Up MFA'
                            )}
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
      <Dialog
        open={passwordConfirmAction !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !passwordConfirmLoading) {
            closePasswordConfirm()
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t(
                'accountSettings.security.confirmPassword.title',
                'Confirm password'
              )}
            </DialogTitle>
            <DialogDescription>
              {t(
                'accountSettings.security.confirmPassword.description',
                'Enter your current password to continue.'
              )}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleConfirmCurrentPassword} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="account-security-current-password">
                {t(
                  'accountSettings.password.currentPassword',
                  'Current Password'
                )}
              </Label>
              <PasswordInput
                id="account-security-current-password"
                autoComplete="current-password"
                required
                value={securityCurrentPassword}
                onChange={(event) =>
                  setSecurityCurrentPassword(event.target.value)
                }
              />
            </div>
            {securityPasswordError && (
              <Alert variant="destructive">
                <AlertDescription>{securityPasswordError}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={passwordConfirmLoading}
                onClick={closePasswordConfirm}
              >
                {t('common.actions.cancel', 'Cancel')}
              </Button>
              <Button type="submit" disabled={passwordConfirmLoading}>
                {passwordConfirmLoading
                  ? t('common.actions.saving', 'Saving...')
                  : t('common.actions.continue', 'Continue')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
