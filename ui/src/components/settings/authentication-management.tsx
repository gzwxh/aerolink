import { useEffect, useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { useSettingsSectionAccess } from '@/contexts/settings-section-context'
import { IconAlertTriangle, IconKey } from '@tabler/icons-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import {
  fetchLDAPSyncStatus,
  LDAPSetting,
  LDAPSettingUpdateRequest,
  LDAPSyncResult,
  triggerLDAPSync,
  updateGeneralSetting,
  updateLDAPSetting,
  useGeneralSetting,
  useLDAPSetting,
} from '@/lib/api'
import { translateError } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { PasswordInput } from '@/components/password-input'

import { LDAPImportDialog } from './ldap-import-dialog'
import { OAuthProviderManagement } from './oauth-provider-management'

type AuthenticationFormData = LDAPSetting

function createDefaultSettings(): AuthenticationFormData {
  return {
    enabled: false,
    serverUrl: '',
    useStartTLS: false,
    bindDn: '',
    bindPassword: '',
    bindPasswordConfigured: false,
    userBaseDn: '',
    userFilter: '',
    usernameAttribute: '',
    displayNameAttribute: '',
    groupBaseDn: '',
    groupFilter: '',
    groupNameAttribute: '',
    autoSync: true,
    syncIntervalMinutes: 10,
  }
}

function toFormData(data?: LDAPSetting): AuthenticationFormData {
  if (!data) {
    return createDefaultSettings()
  }

  return {
    enabled: data.enabled ?? false,
    serverUrl: data.serverUrl || '',
    useStartTLS: data.useStartTLS ?? false,
    bindDn: data.bindDn || '',
    bindPassword: '',
    bindPasswordConfigured: data.bindPasswordConfigured ?? false,
    userBaseDn: data.userBaseDn || '',
    userFilter: data.userFilter || '',
    usernameAttribute: data.usernameAttribute || '',
    displayNameAttribute: data.displayNameAttribute || '',
    groupBaseDn: data.groupBaseDn || '',
    groupFilter: data.groupFilter || '',
    groupNameAttribute: data.groupNameAttribute || '',
    autoSync: data.autoSync ?? true,
    syncIntervalMinutes: data.syncIntervalMinutes || 10,
  }
}

export function AuthenticationManagement() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { user } = useAuth()
  // 只读章节（只有 settings.authentication 的读权限）时禁用保存，并收起同步 / 导入入口。
  const { readOnly } = useSettingsSectionAccess()
  const { data, error, isError, isLoading, refetch } = useLDAPSetting()
  const { data: generalSetting } = useGeneralSetting()
  const [formData, setFormData] = useState<AuthenticationFormData>(
    createDefaultSettings
  )
  const [passwordLoginEnabled, setPasswordLoginEnabled] = useState(true)

  useEffect(() => {
    setFormData(toFormData(data))
  }, [data])

  useEffect(() => {
    if (generalSetting) {
      setPasswordLoginEnabled(!generalSetting.passwordLoginDisabled)
    }
  }, [generalSetting])

  // 「密码登录」开关落在通用设置（settings.general）上：只有能改通用设置的人才能改它。
  const canManageGeneral = user?.canManageSettingsSection('general') ?? false

  const mutation = useMutation({
    mutationFn: (params: {
      ldap: LDAPSettingUpdateRequest
      passwordLoginDisabled: boolean
    }) => {
      const promises: Promise<unknown>[] = []
      // 「密码登录」开关存在通用设置里（settings.general），而 LDAP 属于认证源
      // （settings.authentication）。三权分立下这两个章节可能属于不同的管理员，
      // 所以只提交自己有权修改的部分——否则安全管理员保存 LDAP 会被
      // settings.general 的门禁拒绝，整个保存一起失败。
      if (canManageGeneral) {
        promises.push(
          updateGeneralSetting({
            passwordLoginDisabled: params.passwordLoginDisabled,
          })
        )
      }
      promises.push(updateLDAPSetting(params.ldap))
      return Promise.all(promises)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['ldap-setting'],
      })
      queryClient.invalidateQueries({ queryKey: ['general-setting'] })
      queryClient.invalidateQueries({ queryKey: ['bootstrap'] })
      toast.success(
        t(
          'authenticationManagement.messages.updated',
          'Authentication settings updated'
        )
      )
    },
    onError: (error) => {
      toast.error(translateError(error, t))
    },
  })

  const handleSave = () => {
    if (!data) {
      toast.error(
        isError
          ? translateError(error, t)
          : t('common.messages.failedToLoad', {
              resource: t('authenticationManagement.title', 'Authentication'),
              defaultValue: 'Failed to load LDAP settings',
            })
      )
      return
    }

    const payload: LDAPSettingUpdateRequest = {
      enabled: formData.enabled,
      serverUrl: formData.serverUrl.trim(),
      useStartTLS: formData.useStartTLS,
      bindDn: formData.bindDn.trim(),
      userBaseDn: formData.userBaseDn.trim(),
      userFilter: formData.userFilter.trim(),
      usernameAttribute: formData.usernameAttribute.trim(),
      displayNameAttribute: formData.displayNameAttribute.trim(),
      groupBaseDn: formData.groupBaseDn.trim(),
      groupFilter: formData.groupFilter.trim(),
      groupNameAttribute: formData.groupNameAttribute.trim(),
      autoSync: formData.autoSync,
      syncIntervalMinutes: formData.syncIntervalMinutes,
    }
    if (formData.bindPassword !== '') {
      payload.bindPassword = formData.bindPassword
    }

    mutation.mutate({
      ldap: payload,
      passwordLoginDisabled: !passwordLoginEnabled,
    })
  }

  const [ldapSyncRunning, setLdapSyncRunning] = useState(false)
  const [ldapSyncResult, setLdapSyncResult] = useState<LDAPSyncResult | null>(
    null
  )
  const [ldapSyncAt, setLdapSyncAt] = useState<string | undefined>(undefined)
  const [ldapImportOpen, setLdapImportOpen] = useState(false)

  useEffect(() => {
    if (!data?.enabled) return
    let cancelled = false
    fetchLDAPSyncStatus()
      .then((status) => {
        if (cancelled) return
        setLdapSyncResult(status.lastResult ?? null)
        setLdapSyncAt(status.lastSyncAt)
        if (status.running) setLdapSyncRunning(true)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [data?.enabled])

  useEffect(() => {
    if (!ldapSyncRunning) return
    let stopped = false
    const poll = async () => {
      try {
        const status = await fetchLDAPSyncStatus()
        if (stopped) return
        setLdapSyncResult(status.lastResult ?? null)
        setLdapSyncAt(status.lastSyncAt)
        if (!status.running) setLdapSyncRunning(false)
      } catch {
        if (!stopped) setLdapSyncRunning(false)
      }
    }
    void poll()
    const timer = window.setInterval(poll, 2000)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [ldapSyncRunning])

  const handleSyncNow = async () => {
    if (!formData.enabled) {
      toast.error(
        t(
          'authenticationManagement.ldap.sync.notEnabled',
          'LDAP is not enabled'
        )
      )
      return
    }
    try {
      const status = await triggerLDAPSync()
      setLdapSyncRunning(true)
      setLdapSyncResult(status.lastResult ?? null)
      setLdapSyncAt(status.lastSyncAt)
      toast.success(
        t('authenticationManagement.ldap.sync.started', 'LDAP sync started')
      )
    } catch (error) {
      toast.error(translateError(error, t))
    }
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

  if (isError && !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <IconKey className="h-5 w-5" />
            {t('authenticationManagement.title', 'Authentication')}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-4">
          <div className="text-sm text-muted-foreground">
            {translateError(error, t)}
          </div>
          <Button variant="outline" onClick={() => refetch()}>
            {t('common.actions.retry', 'Retry')}
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <IconKey className="h-5 w-5" />
            {t('authenticationManagement.title', 'Authentication')}
          </CardTitle>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="rounded-lg border">
            <div className="flex items-center justify-between p-3">
              <div className="space-y-1">
                <Label className="text-sm font-medium">
                  {t('common.fields.passwordLogin', 'Password Login')}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t(
                    'common.messages.passwordLoginDescription',
                    'Allow users to sign in with a username and password.'
                  )}
                </p>
              </div>
              <Switch
                checked={passwordLoginEnabled}
                onCheckedChange={setPasswordLoginEnabled}
                disabled={!generalSetting || !canManageGeneral}
              />
            </div>

            {!passwordLoginEnabled && (
              <div className="border-t p-3">
                <div className="flex gap-3 rounded-md bg-warning/10 border border-warning/25 p-3">
                  <IconAlertTriangle className="h-5 w-5 text-warning shrink-0 mt-0.5" />
                  <div className="space-y-1 text-sm">
                    <p className="font-medium text-warning">
                      {t(
                        'common.messages.passwordLoginWarningTitle',
                        'Warning: You may lose access!'
                      )}
                    </p>
                    <p className="text-muted-foreground">
                      {t(
                        'common.messages.passwordLoginWarningDescription',
                        'Verify that your LDAP or OAuth provider is working before saving. Without a working alternative login method, you will be locked out and can only recover by resetting the database.'
                      )}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="flex justify-end">
            <Button
              onClick={handleSave}
              disabled={readOnly || mutation.isPending || !generalSetting}
            >
              {t('common.actions.save', 'Save')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <OAuthProviderManagement />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <IconKey className="h-5 w-5" />
            {t('authenticationManagement.ldap.title', 'LDAP')}
          </CardTitle>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="rounded-lg border">
            <div className="flex items-center justify-between p-3">
              <div className="space-y-1">
                <Label className="text-sm font-medium">
                  {t('authenticationManagement.ldap.title', 'LDAP')}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t(
                    'authenticationManagement.ldap.description',
                    'Enable LDAP username/password login and sync groups into RBAC.'
                  )}
                </p>
              </div>
              <Switch
                checked={formData.enabled}
                onCheckedChange={(checked) =>
                  setFormData((prev) => ({ ...prev, enabled: checked }))
                }
              />
            </div>

            {formData.enabled && (
              <div className="space-y-4 border-t p-3">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2 md:col-span-2">
                    <Label htmlFor="ldap-server-url">
                      {t(
                        'authenticationManagement.ldap.form.serverUrl',
                        'Server URL'
                      )}
                    </Label>
                    <Input
                      id="ldap-server-url"
                      value={formData.serverUrl}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          serverUrl: e.target.value,
                        }))
                      }
                      placeholder="ldaps://ldap.example.com:636"
                    />
                  </div>

                  <div className="space-y-2 md:col-span-2">
                    <div className="flex items-center justify-between rounded-md border px-3 py-2">
                      <div>
                        <Label htmlFor="ldap-starttls" className="text-sm">
                          {t(
                            'authenticationManagement.ldap.form.useStartTLS',
                            'Use StartTLS'
                          )}
                        </Label>
                        <p className="text-xs text-muted-foreground">
                          {t(
                            'authenticationManagement.ldap.form.useStartTLSHint',
                            'Enable StartTLS when using ldap:// endpoints.'
                          )}
                        </p>
                      </div>
                      <Switch
                        id="ldap-starttls"
                        checked={formData.useStartTLS}
                        onCheckedChange={(checked) =>
                          setFormData((prev) => ({
                            ...prev,
                            useStartTLS: checked,
                          }))
                        }
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="ldap-bind-dn">
                      {t(
                        'authenticationManagement.ldap.form.bindDn',
                        'Bind DN'
                      )}
                    </Label>
                    <Input
                      id="ldap-bind-dn"
                      value={formData.bindDn}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          bindDn: e.target.value,
                        }))
                      }
                      placeholder="cn=svc-aerolink,ou=services,dc=example,dc=com"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="ldap-bind-password">
                      {t(
                        'authenticationManagement.ldap.form.bindPassword',
                        'Bind Password'
                      )}
                    </Label>
                    <PasswordInput
                      id="ldap-bind-password"
                      value={formData.bindPassword}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          bindPassword: e.target.value,
                        }))
                      }
                      placeholder={
                        formData.bindPasswordConfigured
                          ? t(
                              'authenticationManagement.ldap.form.bindPasswordPlaceholder',
                              'Leave empty to keep current bind password'
                            )
                          : ''
                      }
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="ldap-user-base-dn">
                      {t(
                        'authenticationManagement.ldap.form.userBaseDn',
                        'User Base DN'
                      )}
                    </Label>
                    <Input
                      id="ldap-user-base-dn"
                      value={formData.userBaseDn}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          userBaseDn: e.target.value,
                        }))
                      }
                      placeholder="ou=users,dc=example,dc=com"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="ldap-user-filter">
                      {t(
                        'authenticationManagement.ldap.form.userFilter',
                        'User Filter'
                      )}
                    </Label>
                    <Input
                      id="ldap-user-filter"
                      value={formData.userFilter}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          userFilter: e.target.value,
                        }))
                      }
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="ldap-username-attribute">
                      {t(
                        'authenticationManagement.ldap.form.usernameAttribute',
                        'Username Attribute'
                      )}
                    </Label>
                    <Input
                      id="ldap-username-attribute"
                      value={formData.usernameAttribute}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          usernameAttribute: e.target.value,
                        }))
                      }
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="ldap-display-name-attribute">
                      {t(
                        'authenticationManagement.ldap.form.displayNameAttribute',
                        'Display Name Attribute'
                      )}
                    </Label>
                    <Input
                      id="ldap-display-name-attribute"
                      value={formData.displayNameAttribute}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          displayNameAttribute: e.target.value,
                        }))
                      }
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="ldap-group-base-dn">
                      {t(
                        'authenticationManagement.ldap.form.groupBaseDn',
                        'Group Base DN'
                      )}
                    </Label>
                    <Input
                      id="ldap-group-base-dn"
                      value={formData.groupBaseDn}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          groupBaseDn: e.target.value,
                        }))
                      }
                      placeholder="ou=groups,dc=example,dc=com"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="ldap-group-filter">
                      {t(
                        'authenticationManagement.ldap.form.groupFilter',
                        'Group Filter'
                      )}
                    </Label>
                    <Input
                      id="ldap-group-filter"
                      value={formData.groupFilter}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          groupFilter: e.target.value,
                        }))
                      }
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="ldap-group-name-attribute">
                      {t(
                        'authenticationManagement.ldap.form.groupNameAttribute',
                        'Group Name Attribute'
                      )}
                    </Label>
                    <Input
                      id="ldap-group-name-attribute"
                      value={formData.groupNameAttribute}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          groupNameAttribute: e.target.value,
                        }))
                      }
                    />
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2 md:col-span-2">
                    <div className="flex items-center justify-between rounded-md border px-3 py-2">
                      <div>
                        <Label htmlFor="ldap-auto-sync" className="text-sm">
                          {t(
                            'authenticationManagement.ldap.autoSync',
                            'Enable periodic sync'
                          )}
                        </Label>
                        <p className="text-xs text-muted-foreground">
                          {t(
                            'authenticationManagement.ldap.autoSyncHint',
                            'Periodically pull users and group memberships from LDAP.'
                          )}
                        </p>
                      </div>
                      <Switch
                        id="ldap-auto-sync"
                        checked={formData.autoSync}
                        onCheckedChange={(checked) =>
                          setFormData((prev) => ({
                            ...prev,
                            autoSync: checked,
                          }))
                        }
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="ldap-sync-interval">
                      {t(
                        'authenticationManagement.ldap.syncIntervalMinutes',
                        'Sync interval (minutes)'
                      )}
                    </Label>
                    <Input
                      id="ldap-sync-interval"
                      type="number"
                      min={1}
                      value={formData.syncIntervalMinutes}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          syncIntervalMinutes: Number(e.target.value) || 1,
                        }))
                      }
                    />
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2 md:col-span-2">
                    <div className="space-y-1 text-xs text-muted-foreground">
                      <p>
                        {t('authenticationManagement.ldap.sync.lastSyncAt', {
                          at: ldapSyncAt
                            ? new Date(ldapSyncAt).toLocaleString()
                            : t(
                                'authenticationManagement.ldap.sync.never',
                                'never'
                              ),
                          defaultValue: 'Last sync: {{at}}',
                        })}
                      </p>
                      {ldapSyncResult && !ldapSyncResult.error && (
                        <p>
                          {t('authenticationManagement.ldap.sync.summary', {
                            created: ldapSyncResult.created,
                            updated: ldapSyncResult.updated,
                            failed: ldapSyncResult.failed,
                            purged: ldapSyncResult.purged,
                            defaultValue:
                              '{{created}} created, {{updated}} updated, {{failed}} failed, {{purged}} removed',
                          })}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {!readOnly && (
                        <Button
                          variant="outline"
                          onClick={() => setLdapImportOpen(true)}
                          disabled={mutation.isPending}
                        >
                          {t(
                            'authenticationManagement.ldap.sync.importUsers',
                            'Import Users'
                          )}
                        </Button>
                      )}
                      {!readOnly && (
                        <Button
                          variant="outline"
                          onClick={handleSyncNow}
                          disabled={ldapSyncRunning || mutation.isPending}
                        >
                          {ldapSyncRunning
                            ? t(
                                'authenticationManagement.ldap.sync.running',
                                'Syncing...'
                              )
                            : t(
                                'authenticationManagement.ldap.sync.now',
                                'Sync Now'
                              )}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="flex justify-end">
            <Button
              onClick={handleSave}
              disabled={readOnly || mutation.isPending || !generalSetting}
            >
              {t('common.actions.save', 'Save')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <LDAPImportDialog
        open={ldapImportOpen}
        onOpenChange={setLdapImportOpen}
      />
    </div>
  )
}
