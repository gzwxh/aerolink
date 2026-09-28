import { useEffect, useState, type ReactNode } from 'react'
import { useAuth } from '@/contexts/auth-context'
import {
  SettingsSectionProvider,
  useSettingsSectionAccess,
} from '@/contexts/settings-section-context'
import { IconPlus, IconShieldLock, IconX } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

import {
  blockLoginIP,
  blockLoginUser,
  fetchLockedLoginIPs,
  fetchLockedLoginUsers,
  unblockLoginIP,
  unblockLoginUser,
  updateSecuritySetting,
  useSecuritySetting,
  type MFAPolicy,
  type SecuritySetting,
} from '@/lib/api'
import { cn, formatDate, translateError } from '@/lib/utils'
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
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

import { AuthenticationManagement } from './authentication-management'
import { UserStatusPanel } from './user-status-panel'

type SecurityTab =
  'authentication' | 'loginPolicy' | 'password' | 'session' | 'authProviders'

const DEFAULT_SECURITY_SETTING: SecuritySetting = {
  loginCaptchaEnabled: false,
  inactiveUserDisableDays: 999,
  defaultUserEnabled: true,
  defaultUserExpireDays: 0,
  remoteLoginNoticeEnabled: true,
  mfaPolicy: 'disabled',
  mfaThirdPartyEnabled: true,
  mfaStepUpEnabled: true,
  mfaVerifyTtlSeconds: 60,
  otpIssuerName: '鸢联 AeroLink',
  otpVerifyWindow: 2,
  userLoginFailLimit: 7,
  userLoginBlockMinutes: 30,
  ipLoginFailLimit: 5,
  ipLoginBlockMinutes: 30,
  ipWhitelist: [],
  ipBlacklist: [],
  singleDeviceLogin: false,
  rejectUnknownUsers: false,
  loginSourceEnforced: false,
  loginSourceAllowlist: [],
  passwordExpireDays: 900,
  passwordHistoryCount: 5,
  passwordMinLength: 8,
  passwordMinClasses: 3,
  adminPasswordMinLength: 12,
  passwordRequireUppercase: true,
  passwordRequireLowercase: true,
  passwordRequireDigit: true,
  passwordRequireSpecial: true,
  sessionExpireOnBrowserClose: true,
  sessionMaxIdleMinutes: 600,
  sessionMaxHours: 24,
}

function SettingGroup({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
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
  // 只读章节（只有 settings.<章节> 的读权限）时不渲染任何写入口。
  const { readOnly } = useSettingsSectionAccess()
  const { data, isLoading } = useSecuritySetting()
  const [isLockedIPsOpen, setIsLockedIPsOpen] = useState(false)
  const [newLockedIP, setNewLockedIP] = useState('')
  const { data: lockedIPs } = useQuery({
    queryKey: ['locked-login-ips'],
    queryFn: fetchLockedLoginIPs,
    refetchInterval: 15000,
  })

  const [isLockedUsersOpen, setIsLockedUsersOpen] = useState(false)
  const [newLockedUser, setNewLockedUser] = useState('')
  const { data: lockedUsers } = useQuery({
    queryKey: ['locked-login-users'],
    queryFn: fetchLockedLoginUsers,
    refetchInterval: 15000,
  })

  const blockIPMutation = useMutation({
    mutationFn: (ip: string) => blockLoginIP(ip),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['locked-login-ips'] })
      setNewLockedIP('')
      toast.success(t('securitySettings.lockedIPs.blocked', 'IP blocked'))
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const unblockIPMutation = useMutation({
    mutationFn: (ip: string) => unblockLoginIP(ip),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['locked-login-ips'] })
      toast.success(t('securitySettings.lockedIPs.unblocked', 'IP unblocked'))
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const blockUserMutation = useMutation({
    mutationFn: (username: string) => blockLoginUser(username),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['locked-login-users'] })
      setNewLockedUser('')
      toast.success(t('securitySettings.lockedUsers.blocked', 'User blocked'))
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const unblockUserMutation = useMutation({
    mutationFn: (username: string) => unblockLoginUser(username),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['locked-login-users'] })
      toast.success(t('securitySettings.lockedUsers.unblocked', 'User unblocked'))
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const [searchParams, setSearchParams] = useSearchParams()
  // 本章节的「认证配置」页签承载的是 settings.authentication，其余页签属于 settings.security：
  // 只持有其中一个章节的用户不该落到另一个章节的内容上（那会渲染出无权读写的表单，保存必然 403）。
  const { user } = useAuth()
  const canViewSecurity = user?.canViewSettingsSection('security') ?? false
  const canViewAuthentication =
    user?.canViewSettingsSection('authentication') ?? false
  const securityTabs = [
    ...(canViewSecurity
      ? (['authentication', 'loginPolicy', 'password', 'session'] as const)
      : []),
    ...(canViewAuthentication ? (['authProviders'] as const) : []),
  ]
  const tabParam =
    searchParams.get('tab') ?? securityTabs[0] ?? 'authentication'
  const tab = (
    securityTabs.includes(tabParam as SecurityTab) ? tabParam : securityTabs[0]
  ) as SecurityTab
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
        <Tabs
          value={tab}
          onValueChange={(value) => setSearchParams({ tab: value })}
        >
          {canViewSecurity && (
            <>
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
                      'Require MFA enrollment'
                    )}
                    hint={t(
                      'securitySettings.fields.mfaPolicyHint',
                      'Decides who must enroll in time-based codes. Accounts that have already enrolled are always challenged at login, regardless of this choice.'
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
                      {(
                        [
                          [
                            'disabled',
                            t('securitySettings.mfaPolicy.disabled', 'Nobody'),
                          ],
                          [
                            'all',
                            t('securitySettings.mfaPolicy.all', 'All users'),
                          ],
                          [
                            'admin',
                            t(
                              'securitySettings.mfaPolicy.admin',
                              'Admins only'
                            ),
                          ],
                        ] as [MFAPolicy, string][]
                      ).map(([value, label]) => {
                        const active = formData.mfaPolicy === value
                        return (
                          <ToggleGroupItem
                            key={value}
                            value={value}
                            className={cn(
                              'rounded-md px-3 font-medium first:rounded-md last:rounded-md data-[variant=outline]:border-l',
                              active
                                ? 'data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:font-semibold data-[state=on]:border-primary data-[state=on]:shadow-sm'
                                : 'data-[state=off]:text-muted-foreground data-[state=off]:hover:bg-muted data-[state=off]:hover:text-foreground'
                            )}
                          >
                            {label}
                          </ToggleGroupItem>
                        )
                      })}
                    </ToggleGroup>
                  </SettingRow>

                  <SettingRow
                    label={t(
                      'securitySettings.fields.mfaThirdPartyEnabled',
                      'Require LDAP admins to enroll in MFA'
                    )}
                    hint={t(
                      'securitySettings.fields.mfaThirdPartyEnabledHint',
                      'When on, LDAP administrators are asked for a code even if they have not enrolled yet; unenrolled admins cannot sign in until another administrator helps them enroll or this is turned off.'
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
                      'securitySettings.fields.mfaStepUpEnabled',
                      'Require MFA for sensitive operations'
                    )}
                    hint={t(
                      'securitySettings.fields.mfaStepUpEnabledHint',
                      'Ask MFA-enrolled users to re-verify before deletes and interactive shells.'
                    )}
                  >
                    <Switch
                      id="security-mfa-step-up"
                      checked={formData.mfaStepUpEnabled}
                      onCheckedChange={(checked) =>
                        patch('mfaStepUpEnabled', checked)
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
                        patch(
                          'mfaVerifyTtlSeconds',
                          toNumber(event.target.value)
                        )
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
                      placeholder="鸢联 AeroLink"
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
                {/* 卡片在宽屏上分两列，避免一长串卡片堆成又高又挤的一列。 */}
                <div className="grid gap-4 xl:grid-cols-2">
                  <div className="space-y-4">
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
                            patch(
                              'userLoginFailLimit',
                              toNumber(event.target.value)
                            )
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
                            patch(
                              'userLoginBlockMinutes',
                              toNumber(event.target.value)
                            )
                          }
                          className="max-w-40"
                        />
                      </SettingRow>

                      <SettingRow
                        label={t(
                          'securitySettings.fields.lockedUsers',
                          'Locked users'
                        )}
                        hint={t(
                          'securitySettings.fields.lockedUsersHint',
                          'List of users that are currently blocked.'
                        )}
                      >
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setIsLockedUsersOpen(true)}
                        >
                          {t(
                            'securitySettings.actions.viewLockedUsers',
                            'View locked users ({{count}})',
                            { count: (lockedUsers?.items ?? []).length }
                          )}
                        </Button>
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
                            patch(
                              'ipLoginFailLimit',
                              toNumber(event.target.value)
                            )
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
                            patch(
                              'ipLoginBlockMinutes',
                              toNumber(event.target.value)
                            )
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
                        label={t(
                          'securitySettings.fields.lockedIPs',
                          'Locked IPs'
                        )}
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
                            { count: (lockedIPs?.items ?? []).length }
                          )}
                        </Button>
                      </SettingRow>
                    </SettingGroup>
                  </div>
                  <div className="space-y-4">
                    <SettingGroup
                      title={t('securitySettings.groups.other', 'Other')}
                    >
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
                          'securitySettings.fields.rejectUnknownUsers',
                          'Existing users only'
                        )}
                        hint={t(
                          'securitySettings.fields.rejectUnknownUsersHint',
                          'Only accounts that already exist in AeroLink can sign in. Third-party sign-in matches an existing account by username and binds the identity to it on first sign-in.'
                        )}
                      >
                        <Switch
                          id="security-reject-unknown-users"
                          checked={formData.rejectUnknownUsers}
                          onCheckedChange={(checked) =>
                            patch('rejectUnknownUsers', checked)
                          }
                        />
                      </SettingRow>

                      <SettingRow
                        label={t(
                          'securitySettings.fields.loginSourceEnforced',
                          'Restrict login source'
                        )}
                        hint={t(
                          'securitySettings.fields.loginSourceEnforcedHint',
                          'When enabled, only the addresses below can reach the console: sign-in and every subsequent request are both rejected from elsewhere.'
                        )}
                      >
                        <Switch
                          id="security-login-source"
                          checked={formData.loginSourceEnforced}
                          onCheckedChange={(checked) =>
                            patch('loginSourceEnforced', checked)
                          }
                        />
                      </SettingRow>

                      <SettingRow
                        label={t(
                          'securitySettings.fields.loginSourceAllowlist',
                          'Allowed login sources'
                        )}
                        hint={t(
                          'securitySettings.fields.loginSourceAllowlistHint',
                          'Required when the switch above is on. Supports CIDR, single addresses and ranges, e.g. 10.0.0.0/8 or 192.168.10.1-192.168.10.20.'
                        )}
                      >
                        <TagInput
                          value={formData.loginSourceAllowlist}
                          onChange={(value) =>
                            patch('loginSourceAllowlist', value)
                          }
                          placeholder={t(
                            'securitySettings.placeholders.ipList',
                            'Press Enter to add'
                          )}
                        />
                      </SettingRow>
                    </SettingGroup>

                    <SettingGroup
                      title={t(
                        'securitySettings.newUserDefaults.title',
                        '新建用户默认状态'
                      )}
                    >
                      <SettingRow
                        label={t(
                          'securitySettings.newUserDefaults.enabled',
                          '默认激活'
                        )}
                        hint={t(
                          'securitySettings.newUserDefaults.enabledHint',
                          '关闭后新建用户默认禁用，需要管理员手动启用'
                        )}
                      >
                        <Switch
                          id="security-default-user-enabled"
                          checked={formData.defaultUserEnabled}
                          onCheckedChange={(checked) =>
                            patch('defaultUserEnabled', checked)
                          }
                        />
                      </SettingRow>
                      <SettingRow
                        label={t(
                          'securitySettings.newUserDefaults.expireDays',
                          '默认失效天数'
                        )}
                        hint={t(
                          'securitySettings.newUserDefaults.expireDaysHint',
                          '0 表示永不过期'
                        )}
                      >
                        <Input
                          id="security-default-user-expire-days"
                          type="number"
                          min={0}
                          value={formData.defaultUserExpireDays}
                          onChange={(event) =>
                            patch(
                              'defaultUserExpireDays',
                              toNumber(event.target.value)
                            )
                          }
                          className="max-w-40"
                        />
                      </SettingRow>
                    </SettingGroup>

                    <SettingGroup
                      title={t(
                        'securitySettings.groups.inactiveAutoDisable',
                        '不活跃自动禁用'
                      )}
                    >
                      <SettingRow
                        label={t(
                          'securitySettings.fields.inactiveUserDisableDays',
                          'Disable inactive users (days)'
                        )}
                        hint={t(
                          'securitySettings.fields.inactiveUserDisableDaysHint',
                          'Checked once a day; accounts that have not signed in within this period are disabled automatically. Use “Check now” in the User status card below to verify immediately.'
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
                    </SettingGroup>
                  </div>
                </div>

                {/* 被上方「不活跃自动禁用」策略关闭的账号在此恢复。 */}
                <UserStatusPanel />
              </TabsContent>

              <TabsContent value="password" className="space-y-4">
                <SettingGroup
                  title={t('securitySettings.groups.basic', 'Basic')}
                >
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
                        patch(
                          'passwordExpireDays',
                          toNumber(event.target.value)
                        )
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
                        patch(
                          'passwordHistoryCount',
                          toNumber(event.target.value)
                        )
                      }
                      className="max-w-40"
                    />
                  </SettingRow>
                </SettingGroup>

                <SettingGroup
                  title={t(
                    'securitySettings.groups.passwordRules',
                    'Password Rules'
                  )}
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
                      'securitySettings.fields.passwordMinClasses',
                      'Minimum character classes'
                    )}
                    hint={t(
                      'securitySettings.fields.passwordMinClassesHint',
                      '0 = require every enabled class below; 1-4 = require at least N of lowercase / uppercase / digit / special.'
                    )}
                    required
                  >
                    <Input
                      id="security-password-min-classes"
                      type="number"
                      min={0}
                      max={4}
                      value={formData.passwordMinClasses}
                      onChange={(event) =>
                        patch(
                          'passwordMinClasses',
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
                <SettingGroup
                  title={t('securitySettings.groups.session', 'Session')}
                >
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
                        patch(
                          'sessionMaxIdleMinutes',
                          toNumber(event.target.value)
                        )
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
            </>
          )}

          {/* 认证配置：LDAP / OAuth 认证源，从原 /settings/oauth 页面搬进来。
              接口门禁仍是 settings.authentication，所以这里单独包一层章节上下文，
              让只读提示与写入口的隐藏按「认证」章节而不是外层页面的。 */}
          <TabsContent value="authProviders" className="space-y-4">
            <SettingsSectionProvider section="authentication">
              <AuthenticationManagement />
            </SettingsSectionProvider>
          </TabsContent>
        </Tabs>

        {/* 认证配置页签有自己的保存入口（AuthenticationManagement），这里只服务于本页的安全策略表单。 */}
        {tab !== 'authProviders' && (
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={handleReset}>
              {t('common.actions.reset', 'Reset')}
            </Button>
            <Button
              onClick={() => {
                // 「启用 + 空列表」在界面上看着是开着的、实际什么也拦不住。
                // 后端也会拒绝保存，这里先给出可定位的提示。
                if (
                  formData.loginSourceEnforced &&
                  formData.loginSourceAllowlist.length === 0
                ) {
                  toast.error(
                    t(
                      'securitySettings.messages.loginSourceAllowlistRequired',
                      'Add at least one allowed address before enabling this switch.'
                    )
                  )
                  return
                }
                mutation.mutate(formData)
              }}
              disabled={readOnly || mutation.isPending}
            >
              {t('common.actions.submit', 'Submit')}
            </Button>
          </div>
        )}
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

          {!readOnly && (
            <div className="flex gap-2">
              <Input
                value={newLockedIP}
                onChange={(event) => setNewLockedIP(event.target.value)}
                placeholder={t(
                  'securitySettings.lockedIPs.addPlaceholder',
                  'IP address to block'
                )}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && newLockedIP.trim()) {
                    event.preventDefault()
                    blockIPMutation.mutate(newLockedIP.trim())
                  }
                }}
              />
              <Button
                variant="outline"
                disabled={!newLockedIP.trim() || blockIPMutation.isPending}
                onClick={() => blockIPMutation.mutate(newLockedIP.trim())}
              >
                <IconPlus className="h-4 w-4" />
                {t('securitySettings.lockedIPs.block', 'Block')}
              </Button>
            </div>
          )}

          {(lockedIPs?.items ?? []).length === 0 ? (
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
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">
                      {t('securitySettings.lockedIPs.until', 'Until {{time}}', {
                        time: formatDate(item.blockedUntil),
                      })}
                    </span>
                    {!readOnly && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        disabled={unblockIPMutation.isPending}
                        aria-label={t(
                          'securitySettings.lockedIPs.unblock',
                          'Unblock'
                        )}
                        title={t(
                          'securitySettings.lockedIPs.unblock',
                          'Unblock'
                        )}
                        onClick={() => unblockIPMutation.mutate(item.ip)}
                      >
                        <IconX className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            {t(
              'securitySettings.lockedIPs.manualHint',
              'Addresses on the allow list are never locked by failed attempts; add an IP to the deny list for a permanent block. A manual block is cleared when the server restarts.'
            )}
          </p>
        </DialogContent>
      </Dialog>

      <Dialog open={isLockedUsersOpen} onOpenChange={setIsLockedUsersOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {t('securitySettings.lockedUsers.title', 'Locked users')}
            </DialogTitle>
            <DialogDescription>
              {t(
                'securitySettings.lockedUsers.description',
                'Users that are temporarily blocked after too many failed sign-in attempts. You can unblock or block a user here.'
              )}
            </DialogDescription>
          </DialogHeader>

          {!readOnly && (
            <div className="flex gap-2">
              <Input
                value={newLockedUser}
                onChange={(event) => setNewLockedUser(event.target.value)}
                placeholder={t(
                  'securitySettings.lockedUsers.addPlaceholder',
                  'Username to block'
                )}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && newLockedUser.trim()) {
                    event.preventDefault()
                    blockUserMutation.mutate(newLockedUser.trim())
                  }
                }}
              />
              <Button
                variant="outline"
                disabled={!newLockedUser.trim() || blockUserMutation.isPending}
                onClick={() => blockUserMutation.mutate(newLockedUser.trim())}
              >
                <IconPlus className="h-4 w-4" />
                {t('securitySettings.lockedUsers.block', 'Block')}
              </Button>
            </div>
          )}

          {(lockedUsers?.items ?? []).length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t(
                'securitySettings.lockedUsers.empty',
                'No user is currently locked.'
              )}
            </p>
          ) : (
            <div className="divide-y rounded-md border">
              {lockedUsers?.items.map((item) => (
                <div
                  key={item.username}
                  className="flex items-center justify-between gap-4 px-3 py-2 text-sm"
                >
                  <span className="font-medium">{item.username}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">
                      {t('securitySettings.lockedUsers.until', 'Until {{time}}', {
                        time: formatDate(item.blockedUntil),
                      })}
                    </span>
                    {!readOnly && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        disabled={unblockUserMutation.isPending}
                        aria-label={t(
                          'securitySettings.lockedUsers.unblock',
                          'Unblock'
                        )}
                        title={t(
                          'securitySettings.lockedUsers.unblock',
                          'Unblock'
                        )}
                        onClick={() => unblockUserMutation.mutate(item.username)}
                      >
                        <IconX className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            {t(
              'securitySettings.lockedUsers.manualHint',
              'A manual block is cleared when the server restarts. Disable the account itself for a permanent block.'
            )}
          </p>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
