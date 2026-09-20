import { useCallback, useEffect, useState } from 'react'
import { IconEdit, IconKey } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import { OAuthProvider } from '@/types/api'
import { OAuthProviderCreateRequest } from '@/lib/api'
import {
  useDraftDirty,
  useUnsavedChangesGuard,
} from '@/hooks/use-unsaved-changes-guard'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { PasswordInput } from '@/components/password-input'
import { UnsavedChangesConfirmDialog } from '@/components/unsaved-changes-confirm-dialog'

interface OAuthProviderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  provider?: OAuthProvider | null
  onSubmit: (providerData: OAuthProviderCreateRequest) => void
}

function createOAuthProviderFormData(provider?: OAuthProvider | null) {
  return {
    name: provider?.name || '',
    clientId: provider?.clientId || '',
    clientSecret: '',
    authUrl: provider?.authUrl || '',
    tokenUrl: provider?.tokenUrl || '',
    userInfoUrl: provider?.userInfoUrl || '',
    scopes: provider?.scopes || 'openid,profile,email',
    issuer: provider?.issuer || '',
    usernameClaim: provider?.usernameClaim || '',
    groupsClaim: provider?.groupsClaim || '',
    allowedGroups: provider?.allowedGroups || '',
    enabled: provider?.enabled ?? true,
  }
}

export function OAuthProviderDialog({
  open,
  onOpenChange,
  provider,
  onSubmit,
}: OAuthProviderDialogProps) {
  // 草稿在条件挂载的内容组件里，关闭即丢弃；「有没有改动」上报到这一层，
  // 由 useUnsavedChangesGuard 拦截遮罩点击 / Esc / 右上角 X。
  const [isDraftDirty, setIsDraftDirty] = useState(false)
  const close = useCallback(() => onOpenChange(false), [onOpenChange])
  const guard = useUnsavedChangesGuard({ dirty: isDraftDirty, onClose: close })

  return (
    <>
      <Dialog open={open} onOpenChange={guard.handleOpenChange}>
        {open ? (
          <OAuthProviderDialogContent
            key={provider?.id ?? 'new'}
            provider={provider}
            onSubmit={onSubmit}
            onDraftChange={setIsDraftDirty}
            onRequestClose={() => guard.handleOpenChange(false)}
          />
        ) : null}
      </Dialog>

      <UnsavedChangesConfirmDialog {...guard.confirmDialogProps} />
    </>
  )
}

function OAuthProviderDialogContent({
  provider,
  onSubmit,
  onDraftChange,
  onRequestClose,
}: Omit<OAuthProviderDialogProps, 'open' | 'onOpenChange'> & {
  /** 上报是否有草稿，父级据此决定关闭时是否先弹确认。 */
  onDraftChange: (hasDraft: boolean) => void
  /** 需要用户确认的关闭请求（取消按钮）。 */
  onRequestClose: () => void
}) {
  const { t } = useTranslation()
  const isEditMode = !!provider

  const [formData, setFormData] = useState(() =>
    createOAuthProviderFormData(provider)
  )
  // 首帧表单（编辑时为现有配置，新建为默认值）即基线；改过才算未保存。
  // 含 clientSecret 等敏感字段，仅在本组件内存中比较，不写入日志。
  const isDirty = useDraftDirty(formData)
  useEffect(() => {
    onDraftChange(isDirty)
  }, [isDirty, onDraftChange])

  const [validationError, setValidationError] = useState('')

  const validateForm = () => {
    const hasIssuer = !!formData.issuer.trim()
    const hasUrls = !!(
      formData.authUrl.trim() &&
      formData.tokenUrl.trim() &&
      formData.userInfoUrl.trim()
    )
    if (!hasIssuer && !hasUrls) {
      setValidationError(
        t(
          'common.messages.issuerOrOAuthUrlRequired',
          'Please fill in either Issuer or OAuth URL (Authorization, Token, User Info)'
        )
      )
      return false
    }

    setValidationError('')
    return true
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    if (!validateForm()) {
      return
    }

    const submitData: OAuthProviderCreateRequest = {
      name: formData.name,
      clientId: formData.clientId,
      clientSecret: formData.clientSecret,
      enabled: formData.enabled,
    }

    if (formData.authUrl) submitData.authUrl = formData.authUrl
    if (formData.tokenUrl) submitData.tokenUrl = formData.tokenUrl
    if (formData.userInfoUrl) submitData.userInfoUrl = formData.userInfoUrl
    if (formData.scopes) submitData.scopes = formData.scopes
    if (formData.issuer) submitData.issuer = formData.issuer
    if (formData.usernameClaim)
      submitData.usernameClaim = formData.usernameClaim
    if (formData.groupsClaim) submitData.groupsClaim = formData.groupsClaim
    if (formData.allowedGroups)
      submitData.allowedGroups = formData.allowedGroups

    onSubmit(submitData)
  }

  const handleInputChange =
    (field: keyof typeof formData) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setFormData((prev) => ({
        ...prev,
        [field]: e.target.value,
      }))
      if (validationError) {
        setValidationError('')
      }
    }

  const handleSwitchChange =
    (field: keyof typeof formData) => (checked: boolean) => {
      setFormData((prev) => ({
        ...prev,
        [field]: checked,
      }))
    }

  return (
    <DialogContent className="!max-w-4xl max-h-[90vh] overflow-y-auto sm:!max-w-4xl">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          {isEditMode ? (
            <IconEdit className="h-5 w-5" />
          ) : (
            <IconKey className="h-5 w-5" />
          )}
          {isEditMode
            ? t('oauthManagement.dialog.editTitle', 'Edit OAuth Provider')
            : t('oauthManagement.dialog.createTitle', 'Add OAuth Provider')}
        </DialogTitle>
      </DialogHeader>
      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Section 1: Name & Scopes */}
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-medium">
              {t('common.fields.basicInformation', 'Basic Information')}
            </h3>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="name">
                {t('oauthManagement.dialog.name', 'Name')} *
              </Label>
              <Input
                id="name"
                value={formData.name}
                onChange={handleInputChange('name')}
                placeholder={t(
                  'oauthManagement.dialog.namePlaceholder',
                  'e.g., github, google'
                )}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="scopes">
                {t('oauthManagement.dialog.scopes', 'Scopes')}
              </Label>
              <Input
                id="scopes"
                value={formData.scopes}
                onChange={handleInputChange('scopes')}
                placeholder={t(
                  'common.placeholders.scopes',
                  'openid,profile,email'
                )}
              />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="client_id">
                {t('oauthManagement.dialog.clientId', 'Client ID')} *
              </Label>
              <Input
                id="client_id"
                value={formData.clientId}
                onChange={handleInputChange('clientId')}
                placeholder={t(
                  'oauthManagement.dialog.clientIdPlaceholder',
                  'OAuth Client ID'
                )}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="client_secret">
                {t('oauthManagement.dialog.clientSecret', 'Client Secret')}
                {isEditMode ? '' : ' *'}
              </Label>
              <PasswordInput
                id="client_secret"
                value={formData.clientSecret}
                onChange={handleInputChange('clientSecret')}
                placeholder={
                  isEditMode
                    ? t(
                        'oauthManagement.dialog.clientSecretPlaceholder',
                        'Leave empty to keep current secret'
                      )
                    : t(
                        'oauthManagement.dialog.clientSecretRequired',
                        'OAuth Client Secret'
                      )
                }
                required={!isEditMode}
              />
            </div>
          </div>
        </div>
        <Separator />
        {/* Section 2: URLs & Issuer */}
        <div className="space-y-4">
          <div className="space-y-2">
            <h3 className="text-lg font-medium">
              {t('common.fields.oauthEndpoints', 'OAuth Endpoints')}
            </h3>
          </div>
          <div className="space-y-2">
            <Label htmlFor="issuer">
              {t('oauthManagement.dialog.issuer', 'Issuer')}
            </Label>
            <Input
              id="issuer"
              value={formData.issuer}
              onChange={handleInputChange('issuer')}
              placeholder={t(
                'common.placeholders.issuer',
                'https://provider.com (auto discovery)'
              )}
            />
          </div>
          <div className="text-center text-sm text-muted-foreground py-2">
            {t('common.values.or', 'or')}
          </div>
          <div className="grid grid-cols-1 gap-4">
            <div className="space-y-2">
              <Label htmlFor="authUrl">
                {t('oauthManagement.dialog.authUrl', 'Authorization URL')}
              </Label>
              <Input
                id="authUrl"
                value={formData.authUrl}
                onChange={handleInputChange('authUrl')}
                placeholder={t(
                  'common.placeholders.authUrl',
                  'https://provider.com/oauth/authorize'
                )}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="tokenUrl">
                {t('oauthManagement.dialog.tokenUrl', 'Token URL')}
              </Label>
              <Input
                id="tokenUrl"
                value={formData.tokenUrl}
                onChange={handleInputChange('tokenUrl')}
                placeholder={t(
                  'common.placeholders.tokenUrl',
                  'https://provider.com/oauth/token'
                )}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="userInfoUrl">
                {t('oauthManagement.dialog.userInfoUrl', 'User Info URL')}
              </Label>
              <Input
                id="userInfoUrl"
                value={formData.userInfoUrl}
                onChange={handleInputChange('userInfoUrl')}
                placeholder={t(
                  'common.placeholders.userInfoUrl',
                  'https://provider.com/oauth/userinfo'
                )}
              />
            </div>
          </div>
        </div>
        <Separator />
        {/* Section 3: Advanced OIDC Details */}
        <div className="space-y-4">
          <div className="space-y-2">
            <h3 className="text-lg font-medium">
              {t('common.fields.advancedSettings', 'Advanced Settings')}
            </h3>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="usernameClaim">
                {t('common.fields.usernameClaim', 'Username Claim')}
              </Label>
              <Input
                id="usernameClaim"
                value={formData.usernameClaim}
                onChange={handleInputChange('usernameClaim')}
                placeholder={t(
                  'common.placeholders.usernameClaim',
                  'e.g., preferred_username'
                )}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="groupsClaim">
                {t('common.fields.groupsClaim', 'Groups Claim')}
              </Label>
              <Input
                id="groupsClaim"
                value={formData.groupsClaim}
                onChange={handleInputChange('groupsClaim')}
                placeholder={t(
                  'common.placeholders.groupsClaim',
                  'e.g., memberOf'
                )}
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="allowedGroups">
                {t('common.fields.allowedGroups', 'Allowed Groups')}
              </Label>
              <Input
                id="allowedGroups"
                value={formData.allowedGroups}
                onChange={handleInputChange('allowedGroups')}
                placeholder={t(
                  'common.placeholders.allowedGroups',
                  'e.g., admin, developers (comma separated)'
                )}
              />
            </div>
          </div>
        </div>
        <Separator />
        {/* Section 4: Enable */}
        <div className="space-y-4">
          <h3 className="text-lg font-medium">
            {t('common.fields.status', 'Status')}
          </h3>
          <div className="flex items-center space-x-2">
            <Switch
              id="enabled"
              checked={formData.enabled}
              onCheckedChange={handleSwitchChange('enabled')}
            />
            <Label htmlFor="enabled">
              {t('oauthManagement.dialog.enabled', 'Enabled')}
            </Label>
          </div>
        </div>
        {validationError && (
          <Alert variant="destructive">
            <AlertDescription>{validationError}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onRequestClose}>
            {t('common.actions.cancel', 'Cancel')}
          </Button>
          <Button type="submit">
            {isEditMode
              ? t('common.actions.update', 'Update')
              : t('common.actions.create', 'Create')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}
