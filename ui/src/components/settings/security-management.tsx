import { useEffect, useState, type ReactNode } from 'react'
import { IconShieldLock, IconX } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import {
  fetchLockedLoginIPs,
  type MFAPolicy,
  type SecuritySetting,
  updateSecuritySetting,
  useSecuritySetting,
} from '@/lib/api'
import { formatDate, translateError } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent } from '@/components/ui/tabs'
import {
  ToggleGroup,
  ToggleGroupItem,
} from '@/components/ui/toggle-group'

type SecurityTab = 'authentication' | 'loginPolicy' | 'password' | 'session'

const DEFAULT_SECURITY_SETTING: SecuritySetting = {
  loginCaptchaEnabled: false,
  inactiveUserDisableDays: 999,
  remoteLoginNoticeEnabled: true,
  mfaPolicy: 'disabled',
  mfaThirdPartyEnabled: true,
  mfaVerifyTtlSeconds: 60,
  otpIssuerName: 'Kite',
  otpVerifyWindow: 2,
  userLoginFailLimit: 7,
  userLoginBlockMinutes: 30,
  ipLoginFailLimit: 5,
  ipLoginBlockMinutes: 30,
  ipWhitelist: [],
  ipBlacklist: [],
  singleDeviceLogin: false,
  existingUserOnly: true,
  loginSourceRestricted: true,
  passwordExpireDays: 900,
  passwordHistoryCount: 5,
  passwordMinLength: 8,
  adminPasswordMinLength: 12,
  passwordRequireUppercase: true,
  passwordRequireLowercase: true,
  passwordRequireDigit: true,
  passwordRequireSpecial: true,
  sessionExpireOnBrowserClose: true,
  sessionMaxIdleMinutes: 600,
  sessionMaxHours: 24,
}

function SettingGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border">
      <div className="bg-muted/40 px-3 py-2 text-sm font-medium">{title}</div>
      <div className="divide-y">{children}</div>
    </div>
  )
}

function SettingRow({
  label,
  hint,
  required,
  children,
}: {
  label: string
  hint?: string
  required?: boolean
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-start sm:gap-6">
      <div className="space-y-1 sm:w-64 sm:shrink-0">
        <div className="text-sm">
          {required && <span className="mr-1 text-destructive">*</span>}
          {label}
        </div>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

function TagInput({
  value,
  onChange,
  placeholder,
}: {
  value: string[]
  onChange: (value: string[]) => void
  placeholder: string
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState('')

  const commit = () => {
    const next = draft.trim()
    setDraft('')
    if (!next || value.includes(next)) {
      return
    }
    onChange([...value, next])
  }

  return (
    <div className="flex min-h-9 w-full flex-wrap items-center gap-1 rounded-md border px-2 py-1">
      {value.map((entry) => (
        <Badge key={entry} variant="secondary" className="gap-1 font-normal">
          {entry}
          <button
            type="button"
            aria-label={t('common.actions.remove', 'Remove')}
            onClick={() => onChange(value.filter((item) => item !== entry))}
          >
            <IconX className="size-3" />
          </button>
        </Badge>
      ))}
      <Input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          }
        }}
        placeholder={placeholder}
        className="h-6 min-w-32 flex-1 border-0 px-1 shadow-none focus-visible:ring-0"
      />
    </div>
  )
}

export function SecurityManagement() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data, isLoading } = useSecuritySetting()
  const [isLockedIPsOpen, setIsLockedIPsOpen] = useState(false)
  const { data: lockedIPs } = useQuery({
    queryKey: ['locked-login-ips'],
    queryFn: fetchLockedLoginIPs,
    refetchInterval: 15000,
  })
  const [searchParams, setSearchParams] = useSearchParams()
  const securityTabs = [
    'authentication',
    'loginPolicy',
    'password',
    'session',
  ] as const
  const tabParam = searchParams.get('tab') ?? 'authentication'
  const tab = (securityTabs.includes(tabParam as SecurityTab)
    ? tabParam
    : 'authentication') as SecurityTab
  const [formData, setFormData] = useState<SecuritySetting>(
    DEFAULT_SECURITY_SETTING
  )

  useEffect(() => {
    if (data) {
      setFormData(data)
    }
  }, [data])

  const mutation = useMutation({
    mutationFn: (payload: SecuritySetting) => updateSecuritySetting(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['security-setting'] })
      toast.success(
        t('securitySettings.messages.updated', 'Security settings updated')
      )
    },
    onError: (error) => {
      toast.error(translateError(error, t))
    },
  })

  const patch = <K extends keyof SecuritySetting>(
    key: K,
    value: SecuritySetting[K]
  ) => setFormData((prev) => ({ ...prev, [key]: value }))

  const toNumber = (value: string) => {
    const parsed = Number.parseInt(value, 10)
    return Number.isNaN(parsed) ? 0 : parsed
  }

  const handleReset = () => {
    setFormData(data ?? DEFAULT_SECURITY_SETTING)
  }

  if (isLoading && !data) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-muted-foreground">
          {t('common.messages.loading', 'Loading...')}
        </div>
      </div>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <IconShieldLock className="h-5 w-5" />
          {t('securitySettings.title', 'Security')}
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        <Tabs value={tab} onValueChange={(value) => setSearchParams({ tab: value })}>


          <TabsContent value="authentication" className="space-y-4">
            <SettingGroup
              title={t('securitySettings.groups.basic', 'Basic')}
            >
              <SettingRow
                label={t(
                  'securitySettings.fields.loginCaptchaEnabled',
                  'Enable login captcha'
                )}
                hint={t(
                  'securitySettings.fields.loginCaptchaEnabledHint',
                  'Require a captcha to block bots from signing in.'
                )}
              >
                <Switch
                  id="security-login-captcha"
                  checked={formData.loginCaptchaEnabled}
                  onCheckedChange={(checked) =>
                    patch('loginCaptchaEnabled', checked)
                  }
                />
              </SettingRow>

              <SettingRow
                label={t(
                  'securitySettings.fields.inactiveUserDisableDays',
                  'Disable inactive users (days)'
                )}
                hint={t(
                  'securitySettings.fields.inactiveUserDisableDaysHint',
                  'Checked once a day; users that have not signed in within this period are disabled.'
                )}
              >
                <Input
                  id="security-inactive-user-days"
                  type="number"
                  min={0}
                  value={formData.inactiveUserDisableDays}
                  onChange={(event) =>
                    patch(
                      'inactiveUserDisableDays',
                      toNumber(event.target.value)
                    )
                  }
                  className="max-w-40"
                />
              </SettingRow>

              <SettingRow
                label={t(
                  'securitySettings.fields.remoteLoginNoticeEnabled',
                  'Remote login notification'
                )}
                hint={t(
                  'securitySettings.fields.remoteLoginNoticeEnabledHint',
                  'Notify users when they sign in from an unusual city.'
                )}
              >
                <Switch
                  id="security-remote-login-notice"
                  checked={formData.remoteLoginNoticeEnabled}
                  onCheckedChange={(checked) =>
                    patch('remoteLoginNoticeEnabled', checked)
                  }
                />
              </SettingRow>
            </SettingGroup>

            <SettingGroup title={t('securitySettings.groups.mfa', 'MFA')}>
              <SettingRow
                label={t(
                  'securitySettings.fields.mfaPolicy',
                  'Enable MFA globally'
                )}
              >
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  value={formData.mfaPolicy}
                  onValueChange={(value) => {
                    if (value) {
                      patch('mfaPolicy', value as MFAPolicy)
                    }
                  }}
                >
                  <ToggleGroupItem
                    value="disabled"
                    className="rounded-md px-3 first:rounded-md last:rounded-md data-[variant=outline]:border-l"
                  >
                    {t('securitySettings.mfaPolicy.disabled', 'Disabled')}
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    value="all"
                    className="rounded-md px-3 first:rounded-md last:rounded-md data-[variant=outline]:border-l"
                  >
                    {t('securitySettings.mfaPolicy.all', 'All users')}
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    value="admin"
                    className="rounded-md px-3 first:rounded-md last:rounded-md data-[variant=outline]:border-l"
                  >
                    {t('securitySettings.mfaPolicy.admin', 'Admins only')}
                  </ToggleGroupItem>
                </ToggleGroup>
              </SettingRow>

              <SettingRow
                label={t(
                  'securitySettings.fields.mfaThirdPartyEnabled',
                  'Enable MFA for third-party login'
                )}
                hint={t(
                  'securitySettings.fields.mfaThirdPartyEnabledHint',
                  'Applies to third-party login methods such as OIDC, CAS and SAML2.'
                )}
              >
                <Switch
                  id="security-mfa-third-party"
                  checked={formData.mfaThirdPartyEnabled}
                  onCheckedChange={(checked) =>
                    patch('mfaThirdPartyEnabled', checked)
                  }
                />
              </SettingRow>

              <SettingRow
                label={t(
                  'securitySettings.fields.mfaVerifyTtlSeconds',
                  'MFA verification validity'
                )}
                hint={t(
                  'securitySettings.fields.mfaVerifyTtlSecondsHint',
                  'In seconds. Currently only used when MFA is verified together with the account password.'
                )}
                required
              >
                <Input
                  id="security-mfa-ttl"
                  type="number"
                  min={60}
                  value={formData.mfaVerifyTtlSeconds}
                  onChange={(event) =>
                    patch('mfaVerifyTtlSeconds', toNumber(event.target.value))
                  }
                  className="max-w-40"
                />
              </SettingRow>

              <SettingRow
                label={t(
                  'securitySettings.fields.otpIssuerName',
                  'OTP issuer name'
                )}
              >
                <Input
                  id="security-otp-issuer"
                  value={formData.otpIssuerName}
                  onChange={(event) =>
                    patch('otpIssuerName', event.target.value)
                  }
                  placeholder="Kite"
                  className="max-w-80"
                />
              </SettingRow>

              <SettingRow
                label={t(
                  'securitySettings.fields.otpVerifyWindow',
                  'OTP verification window'
                )}
                required
              >
                <Input
                  id="security-otp-window"
                  type="number"
                  min={0}
                  max={10}
                  value={formData.otpVerifyWindow}
                  onChange={(event) =>
                    patch('otpVerifyWindow', toNumber(event.target.value))
                  }
                  className="max-w-40"
                />
              </SettingRow>
            </SettingGroup>
          </TabsContent>

          <TabsContent value="loginPolicy" className="space-y-4">
            <SettingGroup
              title={t(
                'securitySettings.groups.userLoginLimit',
                'User Login Limits'
              )}
            >
              <SettingRow
                label={t(
                  'securitySettings.fields.userLoginFailLimit',
                  'Failed login attempts per user'
                )}
                required
              >
                <Input
                  id="security-user-fail-limit"
                  type="number"
                  min={0}
                  value={formData.userLoginFailLimit}
                  onChange={(event) =>
                    patch('userLoginFailLimit', toNumber(event.target.value))
                  }
                  className="max-w-40"
                />
              </SettingRow>

              <SettingRow
                label={t(
                  'securitySettings.fields.userLoginBlockMinutes',
                  'User lockout window (minutes)'
                )}
                hint={t(
                  'securitySettings.fields.userLoginBlockMinutesHint',
                  'Once the failed attempt limit is reached, logins are blocked for this period.'
                )}
                required
              >
                <Input
                  id="security-user-block-minutes"
                  type="number"
                  min={0}
                  value={formData.userLoginBlockMinutes}
                  onChange={(event) =>
                    patch('userLoginBlockMinutes', toNumber(event.target.value))
                  }
                  className="max-w-40"
                />
              </SettingRow>
            </SettingGroup>

            <SettingGroup
              title={t(
                'securitySettings.groups.ipLoginLimit',
                'IP Login Limits'
              )}
            >
              <SettingRow
                label={t(
                  'securitySettings.fields.ipLoginFailLimit',
                  'Failed login attempts per IP'
                )}
                required
              >
                <Input
                  id="security-ip-fail-limit"
                  type="number"
                  min={0}
                  value={formData.ipLoginFailLimit}
                  onChange={(event) =>
                    patch('ipLoginFailLimit', toNumber(event.target.value))
                  }
                  className="max-w-40"
                />
              </SettingRow>

              <SettingRow
                label={t(
                  'securitySettings.fields.ipLoginBlockMinutes',
                  'IP lockout window (minutes)'
                )}
                hint={t(
                  'securitySettings.fields.ipLoginBlockMinutesHint',
                  'Once the failed attempt limit is reached, logins from this IP are blocked for this period.'
                )}
                required
              >
                <Input
                  id="security-ip-block-minutes"
                  type="number"
                  min={0}
                  value={formData.ipLoginBlockMinutes}
                  onChange={(event) =>
                    patch('ipLoginBlockMinutes', toNumber(event.target.value))
                  }
                  className="max-w-40"
                />
              </SettingRow>

              <SettingRow
                label={t(
                  'securitySettings.fields.ipWhitelist',
                  'IP allow list'
                )}
                hint={t(
                  'securitySettings.fields.ipListHint',
                  'Ranges are supported, for example 192.168.10.1-192.168.10.20 or 2001:db8:a1-2001:db8:1:a10.'
                )}
              >
                <TagInput
                  value={formData.ipWhitelist}
                  onChange={(value) => patch('ipWhitelist', value)}
                  placeholder={t(
                    'securitySettings.placeholders.ipList',
                    'Press Enter to add'
                  )}
                />
              </SettingRow>

              <SettingRow
                label={t(
                  'securitySettings.fields.ipBlacklist',
                  'IP deny list'
                )}
                hint={t(
                  'securitySettings.fields.ipListHint',
                  'Ranges are supported, for example 192.168.10.1-192.168.10.20 or 2001:db8:a1-2001:db8:1:a10.'
                )}
              >
                <TagInput
                  value={formData.ipBlacklist}
                  onChange={(value) => patch('ipBlacklist', value)}
                  placeholder={t(
                    'securitySettings.placeholders.ipList',
                    'Press Enter to add'
                  )}
                />
              </SettingRow>

              <SettingRow
                label={t('securitySettings.fields.lockedIPs', 'Locked IPs')}
                hint={t(
                  'securitySettings.fields.lockedIPsHint',
                  'List of IPs that are currently blocked.'
                )}
              >
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setIsLockedIPsOpen(true)}
                >
                  {t(
                    'securitySettings.actions.viewLockedIPs',
                    'View locked IPs ({{count}})',
                    { count: lockedIPs?.items.length ?? 0 }
                  )}
                </Button>
              </SettingRow>
            </SettingGroup>

            <SettingGroup title={t('securitySettings.groups.other', 'Other')}>
              <SettingRow
                label={t(
                  'securitySettings.fields.singleDeviceLogin',
                  'Single device login'
                )}
                hint={t(
                  'securitySettings.fields.singleDeviceLoginHint',
                  'Signed-in devices are logged out automatically when the user signs in from a new device.'
                )}
              >
                <Switch
                  id="security-single-device"
                  checked={formData.singleDeviceLogin}
                  onCheckedChange={(checked) =>
                    patch('singleDeviceLogin', checked)
                  }
                />
              </SettingRow>

              <SettingRow
                label={t(
                  'securitySettings.fields.existingUserOnly',
                  'Existing users only'
                )}
                hint={t(
                  'securitySettings.fields.existingUserOnlyHint',
                  'When enabled, unknown users cannot sign in; when disabled, users from other authentication providers are created automatically.'
                )}
              >
                <Switch
                  id="security-existing-user-only"
                  checked={formData.existingUserOnly}
                  onCheckedChange={(checked) =>
                    patch('existingUserOnly', checked)
                  }
                />
              </SettingRow>

              <SettingRow
                label={t(
                  'securitySettings.fields.loginSourceRestricted',
                  'Restrict login source'
                )}
                hint={t(
                  'securitySettings.fields.loginSourceRestrictedHint',
                  'When enabled, the login source IP is validated; when disabled, every configured authentication provider is tried until one succeeds.'
                )}
              >
                <Switch
                  id="security-login-source"
                  checked={formData.loginSourceRestricted}
                  onCheckedChange={(checked) =>
                    patch('loginSourceRestricted', checked)
                  }
                />
              </SettingRow>
            </SettingGroup>
          </TabsContent>

          <TabsContent value="password" className="space-y-4">
            <SettingGroup title={t('securitySettings.groups.basic', 'Basic')}>
              <SettingRow
                label={t(
                  'securitySettings.fields.passwordExpireDays',
                  'Password expiry (days)'
                )}
                hint={t(
                  'securitySettings.fields.passwordExpireDaysHint',
                  'Users that do not update their password within this period are notified by email two days before it expires.'
                )}
                required
              >
                <Input
                  id="security-password-expire-days"
                  type="number"
                  min={0}
                  value={formData.passwordExpireDays}
                  onChange={(event) =>
                    patch('passwordExpireDays', toNumber(event.target.value))
                  }
                  className="max-w-40"
                />
              </SettingRow>

              <SettingRow
                label={t(
                  'securitySettings.fields.passwordHistoryCount',
                  'Password history'
                )}
                hint={t(
                  'securitySettings.fields.passwordHistoryCountHint',
                  'Passwords used by the user within this count cannot be reused.'
                )}
                required
              >
                <Input
                  id="security-password-history-count"
                  type="number"
                  min={0}
                  value={formData.passwordHistoryCount}
                  onChange={(event) =>
                    patch('passwordHistoryCount', toNumber(event.target.value))
                  }
                  className="max-w-40"
                />
              </SettingRow>
            </SettingGroup>

            <SettingGroup
              title={t('securitySettings.groups.passwordRules', 'Password Rules')}
            >
              <SettingRow
                label={t(
                  'securitySettings.fields.passwordMinLength',
                  'Minimum password length'
                )}
                required
              >
                <Input
                  id="security-password-min-length"
                  type="number"
                  min={1}
                  value={formData.passwordMinLength}
                  onChange={(event) =>
                    patch('passwordMinLength', toNumber(event.target.value))
                  }
                  className="max-w-40"
                />
              </SettingRow>

              <SettingRow
                label={t(
                  'securitySettings.fields.adminPasswordMinLength',
                  'Minimum admin password length'
                )}
                required
              >
                <Input
                  id="security-admin-password-min-length"
                  type="number"
                  min={1}
                  value={formData.adminPasswordMinLength}
                  onChange={(event) =>
                    patch(
                      'adminPasswordMinLength',
                      toNumber(event.target.value)
                    )
                  }
                  className="max-w-40"
                />
              </SettingRow>

              <SettingRow
                label={t(
                  'securitySettings.fields.passwordRequireUppercase',
                  'Require uppercase letters'
                )}
              >
                <Switch
                  id="security-password-uppercase"
                  checked={formData.passwordRequireUppercase}
                  onCheckedChange={(checked) =>
                    patch('passwordRequireUppercase', checked)
                  }
                />
              </SettingRow>

              <SettingRow
                label={t(
                  'securitySettings.fields.passwordRequireLowercase',
                  'Require lowercase letters'
                )}
              >
                <Switch
                  id="security-password-lowercase"
                  checked={formData.passwordRequireLowercase}
                  onCheckedChange={(checked) =>
                    patch('passwordRequireLowercase', checked)
                  }
                />
              </SettingRow>

              <SettingRow
                label={t(
                  'securitySettings.fields.passwordRequireDigit',
                  'Require digits'
                )}
              >
                <Switch
                  id="security-password-digit"
                  checked={formData.passwordRequireDigit}
                  onCheckedChange={(checked) =>
                    patch('passwordRequireDigit', checked)
                  }
                />
              </SettingRow>

              <SettingRow
                label={t(
                  'securitySettings.fields.passwordRequireSpecial',
                  'Require special characters'
                )}
              >
                <Switch
                  id="security-password-special"
                  checked={formData.passwordRequireSpecial}
                  onCheckedChange={(checked) =>
                    patch('passwordRequireSpecial', checked)
                  }
                />
              </SettingRow>
            </SettingGroup>
          </TabsContent>

          <TabsContent value="session" className="space-y-4">
            <SettingGroup title={t('securitySettings.groups.session', 'Session')}>
              <SettingRow
                label={t(
                  'securitySettings.fields.sessionExpireOnBrowserClose',
                  'Expire session when the browser closes'
                )}
                hint={t(
                  'securitySettings.fields.sessionExpireOnBrowserCloseHint',
                  'Whether the session expires once the user closes the browser.'
                )}
              >
                <Switch
                  id="security-session-browser-close"
                  checked={formData.sessionExpireOnBrowserClose}
                  onCheckedChange={(checked) =>
                    patch('sessionExpireOnBrowserClose', checked)
                  }
                />
              </SettingRow>

              <SettingRow
                label={t(
                  'securitySettings.fields.sessionMaxIdleMinutes',
                  'Connection max idle time (minutes)'
                )}
                hint={t(
                  'securitySettings.fields.sessionMaxIdleMinutesHint',
                  'The connection is closed when there is no activity for longer than this.'
                )}
              >
                <Input
                  id="security-session-max-idle"
                  type="number"
                  min={1}
                  value={formData.sessionMaxIdleMinutes}
                  onChange={(event) =>
                    patch('sessionMaxIdleMinutes', toNumber(event.target.value))
                  }
                  className="max-w-40"
                />
              </SettingRow>

              <SettingRow
                label={t(
                  'securitySettings.fields.sessionMaxHours',
                  'Connection max lifetime (hours)'
                )}
                hint={t(
                  'securitySettings.fields.sessionMaxHoursHint',
                  'The connection is closed when it lasts longer than this.'
                )}
              >
                <Input
                  id="security-session-max-hours"
                  type="number"
                  min={1}
                  value={formData.sessionMaxHours}
                  onChange={(event) =>
                    patch('sessionMaxHours', toNumber(event.target.value))
                  }
                  className="max-w-40"
                />
              </SettingRow>
            </SettingGroup>
          </TabsContent>
        </Tabs>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={handleReset}>
            {t('common.actions.reset', 'Reset')}
          </Button>
          <Button
            onClick={() => mutation.mutate(formData)}
            disabled={mutation.isPending}
          >
            {t('common.actions.submit', 'Submit')}
          </Button>
        </div>
      </CardContent>

      <Dialog open={isLockedIPsOpen} onOpenChange={setIsLockedIPsOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {t('securitySettings.lockedIPs.title', 'Locked IPs')}
            </DialogTitle>
            <DialogDescription>
              {t(
                'securitySettings.lockedIPs.description',
                'Client IPs that are temporarily blocked after too many failed sign-in attempts.'
              )}
            </DialogDescription>
          </DialogHeader>

          {(lockedIPs?.items.length ?? 0) === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t(
                'securitySettings.lockedIPs.empty',
                'No IP is currently locked.'
              )}
            </p>
          ) : (
            <div className="divide-y rounded-md border">
              {lockedIPs?.items.map((item) => (
                <div
                  key={item.ip}
                  className="flex items-center justify-between gap-4 px-3 py-2 text-sm"
                >
                  <span className="font-medium">{item.ip}</span>
                  <span className="text-muted-foreground">
                    {t(
                      'securitySettings.lockedIPs.until',
                      'Until {{time}}',
                      { time: formatDate(item.blockedUntil) }
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  )
}
