import { useEffect, useState } from 'react'
import DefaultLogo from '@/assets/logo.svg'
import { useSettingsSectionAccess } from '@/contexts/settings-section-context'
import {
  IconLink,
  IconMessage,
  IconPhoto,
  IconRobot,
  IconSettings,
  IconTerminal2,
  IconUpload,
  IconX,
} from '@tabler/icons-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import {
  GeneralSettingUpdateRequest,
  updateGeneralSetting,
  useGeneralSetting,
} from '@/lib/api'
import { SITE_NAME_MAX_LENGTH } from '@/lib/site-name'
import { cn, translateError } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { PasswordInput } from '@/components/password-input'

const DEFAULT_MODEL = 'gpt-4o-mini'
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-5'
// 与后端 maxLogoURLLength 对齐：bootstrap 是公开接口，logo 会在每次打开控制台时下发，
// 所以限制在 256 KiB 以内；数据 URL 会膨胀约 1/3，文件选择处再留一点余量。
const MAX_LOGO_BYTES = 180 * 1024
const DEFAULT_KUBECTL_IMAGE =
  'swr.cn-south-1.myhuaweicloud.com/gzwxh/kubectl:latest'
const DEFAULT_NODE_TERMINAL_IMAGE =
  'swr.cn-south-1.myhuaweicloud.com/gzwxh/busybox:latest'
const DEFAULT_CLUSTER_AGENT_IMAGE =
  'swr.cn-south-1.myhuaweicloud.com/gzwxh/devops/aerolink:latest'

interface GeneralSettingsFormData {
  aiAgentEnabled: boolean
  aiProvider: 'openai' | 'anthropic'
  aiModel: string
  aiApiKey: string
  aiApiKeyConfigured: boolean
  aiBaseUrl: string
  aiMaxTokens: number
  kubectlEnabled: boolean
  kubectlImage: string
  nodeTerminalImage: string
  clusterAgentImage: string
  loginPrompt: string
  logoUrl: string
  siteName: string
}

export function GeneralManagement() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  // 只读章节（只有 settings.general 的读权限）时禁用保存。
  const { readOnly } = useSettingsSectionAccess()
  const { data, isLoading } = useGeneralSetting()
  const [formData, setFormData] = useState<GeneralSettingsFormData>({
    aiAgentEnabled: false,
    aiProvider: 'openai',
    aiModel: DEFAULT_MODEL,
    aiApiKey: '',
    aiApiKeyConfigured: false,
    aiBaseUrl: '',
    aiMaxTokens: 16384,
    kubectlEnabled: true,
    kubectlImage: DEFAULT_KUBECTL_IMAGE,
    nodeTerminalImage: DEFAULT_NODE_TERMINAL_IMAGE,
    clusterAgentImage: DEFAULT_CLUSTER_AGENT_IMAGE,
    loginPrompt: '',
    logoUrl: '',
    siteName: '',
  })

  useEffect(() => {
    if (!data) return
    setFormData({
      aiAgentEnabled: data.aiAgentEnabled,
      aiProvider: data.aiProvider || 'openai',
      aiModel: data.aiModel || DEFAULT_MODEL,
      aiApiKey: '',
      aiApiKeyConfigured: data.aiApiKeyConfigured ?? false,
      aiBaseUrl: data.aiBaseUrl || '',
      aiMaxTokens: data.aiMaxTokens || 16384,
      kubectlEnabled: data.kubectlEnabled ?? true,
      kubectlImage: data.kubectlImage || DEFAULT_KUBECTL_IMAGE,
      nodeTerminalImage: data.nodeTerminalImage || DEFAULT_NODE_TERMINAL_IMAGE,
      clusterAgentImage: data.clusterAgentImage || DEFAULT_CLUSTER_AGENT_IMAGE,
      loginPrompt: data.loginPrompt || '',
      logoUrl: data.logoUrl || '',
      siteName: data.siteName || '',
    })
  }, [data])

  const mutation = useMutation({
    mutationFn: (payload: GeneralSettingUpdateRequest) =>
      updateGeneralSetting(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === 'general-setting' ||
          query.queryKey[0] === 'ai-status' ||
          query.queryKey[0] === 'bootstrap',
      })
      toast.success(
        t('generalManagement.messages.updated', 'General settings updated')
      )
    },
    onError: (error) => {
      toast.error(translateError(error, t))
    },
  })

  const handleLogoFile = (file: File | undefined) => {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      toast.error(t('generalManagement.errors.logoNotImage', '请选择图片文件'))
      return
    }
    if (file.size > MAX_LOGO_BYTES) {
      toast.error(
        t('generalManagement.errors.logoTooLarge', {
          defaultValue:
            '图片不能超过 {{size}} KiB，建议改用更小的 logo 或直接填图片地址',
          size: Math.round(MAX_LOGO_BYTES / 1024),
        })
      )
      return
    }
    // 管理员手里通常是图片文件而不是已有地址：转成 data: URL 直接存进设置，
    // 省掉自己找地方托管图标的步骤。
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      if (result) setFormData((prev) => ({ ...prev, logoUrl: result }))
    }
    reader.readAsDataURL(file)
  }

  const handleSave = () => {
    const defaultModel =
      formData.aiProvider === 'anthropic'
        ? DEFAULT_ANTHROPIC_MODEL
        : DEFAULT_MODEL

    if (formData.aiAgentEnabled && !formData.aiModel.trim()) {
      toast.error(
        t('generalManagement.errors.modelRequired', 'Model is required')
      )
      return
    }
    if (
      formData.aiAgentEnabled &&
      !formData.aiApiKey.trim() &&
      !formData.aiApiKeyConfigured
    ) {
      toast.error(
        t(
          'generalManagement.errors.apiKeyRequired',
          'API Key is required when AI Agent is enabled'
        )
      )
      return
    }
    if (formData.kubectlEnabled && !formData.kubectlImage.trim()) {
      toast.error(
        t(
          'generalManagement.errors.kubectlImageRequired',
          'Kubectl image is required when kubectl is enabled'
        )
      )
      return
    }
    if (!formData.nodeTerminalImage.trim()) {
      toast.error(
        t(
          'generalManagement.errors.nodeTerminalImageRequired',
          'Node terminal image is required'
        )
      )
      return
    }

    const payload: GeneralSettingUpdateRequest = {
      aiAgentEnabled: formData.aiAgentEnabled,
      aiProvider: formData.aiProvider,
      aiModel: formData.aiModel.trim() || defaultModel,
      aiBaseUrl: formData.aiBaseUrl.trim(),
      aiMaxTokens: formData.aiMaxTokens || 16384,
      kubectlEnabled: formData.kubectlEnabled,
      kubectlImage: formData.kubectlImage.trim() || DEFAULT_KUBECTL_IMAGE,
      nodeTerminalImage:
        formData.nodeTerminalImage.trim() || DEFAULT_NODE_TERMINAL_IMAGE,
      clusterAgentImage:
        formData.clusterAgentImage.trim() || DEFAULT_CLUSTER_AGENT_IMAGE,
      loginPrompt: formData.loginPrompt.trim(),
      // 显式传空串 = 恢复内置图标（后端同一套「出现即处理」语义）。
      logoUrl: formData.logoUrl.trim(),
      // 空串 = 用默认名。
      siteName: formData.siteName.trim(),
    }
    if (formData.aiApiKey.trim()) {
      payload.aiApiKey = formData.aiApiKey.trim()
    }

    mutation.mutate(payload)
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
          <IconSettings className="h-5 w-5" />
          {t('generalManagement.title', 'General')}
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="rounded-lg border">
          <div className="flex items-center justify-between p-3">
            <div className="space-y-1">
              <Label className="flex items-center gap-2 text-sm font-medium">
                <IconRobot className="h-4 w-4" />
                {t('generalManagement.aiAgent.title', 'AI Agent')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t(
                  'generalManagement.aiAgent.description',
                  'Enable AI assistant and configure model endpoint.'
                )}
              </p>
            </div>
            <Switch
              checked={formData.aiAgentEnabled}
              onCheckedChange={(checked) =>
                setFormData((prev) => ({ ...prev, aiAgentEnabled: checked }))
              }
            />
          </div>

          {formData.aiAgentEnabled && (
            <div className="space-y-4 border-t p-3">
              <div className="space-y-2">
                <Label htmlFor="general-ai-provider">
                  {t('common.fields.provider', 'Provider')}
                </Label>
                <Select
                  value={formData.aiProvider}
                  onValueChange={(value: 'openai' | 'anthropic') =>
                    setFormData((prev) => ({
                      ...prev,
                      aiProvider: value,
                      aiModel:
                        value === 'anthropic'
                          ? prev.aiModel || DEFAULT_ANTHROPIC_MODEL
                          : prev.aiModel || DEFAULT_MODEL,
                    }))
                  }
                >
                  <SelectTrigger id="general-ai-provider">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai">OpenAI Compatible</SelectItem>
                    <SelectItem value="anthropic">
                      Anthropic Compatible
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="general-ai-model">
                  {t('generalManagement.aiAgent.form.model', 'Model')}
                </Label>
                <Input
                  id="general-ai-model"
                  value={formData.aiModel}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      aiModel: e.target.value,
                    }))
                  }
                  placeholder={
                    formData.aiProvider === 'anthropic'
                      ? DEFAULT_ANTHROPIC_MODEL
                      : DEFAULT_MODEL
                  }
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="general-ai-api-key">
                  {t('generalManagement.aiAgent.form.apiKey', 'API Key')}
                </Label>
                <PasswordInput
                  id="general-ai-api-key"
                  value={formData.aiApiKey}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      aiApiKey: e.target.value,
                    }))
                  }
                  placeholder={
                    formData.aiApiKeyConfigured
                      ? t(
                          'generalManagement.aiAgent.form.apiKeyPlaceholder',
                          'Leave empty to keep current API Key'
                        )
                      : 'sk-...'
                  }
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="general-ai-base-url">
                  {t('generalManagement.aiAgent.form.baseUrl', 'Base URL')}
                </Label>
                <Input
                  id="general-ai-base-url"
                  value={formData.aiBaseUrl}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      aiBaseUrl: e.target.value,
                    }))
                  }
                  placeholder={
                    formData.aiProvider === 'anthropic'
                      ? 'https://api.anthropic.com'
                      : 'https://api.openai.com/v1'
                  }
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="general-ai-max-tokens">
                  {t('generalManagement.aiAgent.form.maxTokens', 'Max Tokens')}
                </Label>
                <Input
                  id="general-ai-max-tokens"
                  type="number"
                  min="1"
                  max="128000"
                  value={formData.aiMaxTokens}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      aiMaxTokens: parseInt(e.target.value) || 16384,
                    }))
                  }
                  placeholder="16384"
                />
              </div>
            </div>
          )}
        </div>

        <div className="rounded-lg border">
          <div className="flex items-center justify-between p-3">
            <div className="space-y-1">
              <Label className="flex items-center gap-2 text-sm font-medium">
                <IconTerminal2 className="h-4 w-4" />
                {t('generalManagement.kubectl.title', 'Kubectl')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t(
                  'generalManagement.kubectl.description',
                  'Enable kubectl terminal and configure runtime image.'
                )}
              </p>
            </div>
            <Switch
              checked={formData.kubectlEnabled}
              onCheckedChange={(checked) =>
                setFormData((prev) => ({ ...prev, kubectlEnabled: checked }))
              }
            />
          </div>

          {formData.kubectlEnabled && (
            <div className="space-y-2 border-t p-3">
              <Label htmlFor="general-kubectl-image">
                {t('generalManagement.kubectl.form.image', 'Image')}
              </Label>
              <Input
                id="general-kubectl-image"
                value={formData.kubectlImage}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    kubectlImage: e.target.value,
                  }))
                }
                placeholder={DEFAULT_KUBECTL_IMAGE}
              />
            </div>
          )}
        </div>

        <div className="rounded-lg border p-3">
          <div className="space-y-1">
            <Label className="flex items-center gap-2 text-sm font-medium">
              <IconTerminal2 className="h-4 w-4" />
              {t('generalManagement.nodeTerminal.title', 'Node Terminal')}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t(
                'generalManagement.nodeTerminal.description',
                'Configure runtime image used for node terminal sessions.'
              )}
            </p>
          </div>

          <div className="mt-3 space-y-2">
            <Label htmlFor="general-node-terminal-image">
              {t('generalManagement.nodeTerminal.form.image', 'Image')}
            </Label>
            <Input
              id="general-node-terminal-image"
              value={formData.nodeTerminalImage}
              onChange={(e) =>
                setFormData((prev) => ({
                  ...prev,
                  nodeTerminalImage: e.target.value,
                }))
              }
              placeholder={DEFAULT_NODE_TERMINAL_IMAGE}
            />
          </div>
        </div>

        <div className="rounded-lg border p-3">
          <div className="space-y-1">
            <Label className="flex items-center gap-2 text-sm font-medium">
              <IconLink className="h-4 w-4" />
              {t('generalManagement.clusterAgent.title', 'Cluster Agent Image')}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t(
                'generalManagement.clusterAgent.description',
                'Container image used when generating the Cluster Agent manifest for Cluster Agent clusters.'
              )}
            </p>
          </div>

          <div className="mt-3 space-y-2">
            <Label htmlFor="general-cluster-agent-image">
              {t('generalManagement.clusterAgent.form.image', 'Image')}
            </Label>
            <Input
              id="general-cluster-agent-image"
              value={formData.clusterAgentImage}
              onChange={(e) =>
                setFormData((prev) => ({
                  ...prev,
                  clusterAgentImage: e.target.value,
                }))
              }
              placeholder={DEFAULT_CLUSTER_AGENT_IMAGE}
            />
          </div>
        </div>

        <div className="rounded-lg border p-3">
          <div className="space-y-1">
            <Label className="flex items-center gap-2 text-sm font-medium">
              <IconMessage className="h-4 w-4" />
              {t('generalManagement.loginPrompt.title', 'Login Prompt')}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t(
                'generalManagement.loginPrompt.description',
                'Show a custom message on the login page.'
              )}
            </p>
          </div>

          <div className="mt-3 space-y-2">
            <Label htmlFor="general-login-prompt">
              {t('generalManagement.loginPrompt.form.message', 'Message')}
            </Label>
            <Textarea
              id="general-login-prompt"
              value={formData.loginPrompt}
              onChange={(e) =>
                setFormData((prev) => ({
                  ...prev,
                  loginPrompt: e.target.value,
                }))
              }
              placeholder={t(
                'generalManagement.loginPrompt.form.placeholder',
                'Leave empty to hide the login prompt'
              )}
            />
          </div>
        </div>

        <div className="rounded-lg border p-3">
          <div className="space-y-1">
            <Label className="flex items-center gap-2 text-sm font-medium">
              <IconPhoto className="h-4 w-4" />
              {t('generalManagement.branding.title', '品牌')}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t(
                'generalManagement.branding.description',
                '自定义控制台外观：名称与 logo 会用在侧边栏、登录页、初始化页与浏览器标签上；留空则用默认值（鸢联 AeroLink + 内置图标）。仅管理员可改。'
              )}
            </p>
          </div>

          <div className="mt-3 space-y-2">
            <Label htmlFor="general-site-name">
              {t('generalManagement.branding.nameLabel', '名称')}
            </Label>
            <Input
              id="general-site-name"
              value={formData.siteName}
              disabled={readOnly}
              maxLength={SITE_NAME_MAX_LENGTH}
              onChange={(event) =>
                setFormData((prev) => ({
                  ...prev,
                  siteName: event.target.value,
                }))
              }
              placeholder={t(
                'generalManagement.branding.namePlaceholder',
                '鸢联 AeroLink'
              )}
            />
            <div className="flex items-start justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                {t(
                  'generalManagement.branding.nameHint',
                  '展示在侧边栏、登录页与浏览器标签上；最长 16 个字符（中文按 1 个算），过长时侧边栏会折成两行完整展示。留空则使用默认名称 鸢联 AeroLink。'
                )}
              </p>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {t('generalManagement.branding.nameCounter', {
                  defaultValue: '{{used}}/{{max}}',
                  used: [...formData.siteName].length,
                  max: SITE_NAME_MAX_LENGTH,
                })}
              </span>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <img
              src={formData.logoUrl.trim() || DefaultLogo}
              alt={t('generalManagement.branding.preview', 'Logo 预览')}
              className={cn(
                'h-10 w-10 shrink-0 rounded border object-contain p-1'
              )}
            />
            <label
              className={cn(
                'inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm transition-colors hover:bg-accent',
                readOnly && 'pointer-events-none opacity-50'
              )}
            >
              <IconUpload className="h-4 w-4" />
              {t('generalManagement.branding.upload', '选择图片')}
              <input
                type="file"
                accept="image/*"
                className="hidden"
                disabled={readOnly}
                onChange={(event) => {
                  handleLogoFile(event.target.files?.[0])
                  // 允许连续两次选择同一个文件。
                  event.target.value = ''
                }}
              />
            </label>
            {formData.logoUrl.trim() !== '' && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={readOnly}
                onClick={() =>
                  setFormData((prev) => ({ ...prev, logoUrl: '' }))
                }
              >
                <IconX className="h-4 w-4" />
                {t('generalManagement.branding.reset', '恢复默认')}
              </Button>
            )}
          </div>

          <div className="mt-3 space-y-2">
            <Label htmlFor="general-logo-url">
              {t('generalManagement.branding.urlLabel', 'Logo 地址')}
            </Label>
            <Input
              id="general-logo-url"
              value={formData.logoUrl}
              disabled={readOnly}
              onChange={(event) =>
                setFormData((prev) => ({
                  ...prev,
                  logoUrl: event.target.value,
                }))
              }
              placeholder={t(
                'generalManagement.branding.urlPlaceholder',
                'https://example.com/logo.png'
              )}
            />
            <p className="text-xs text-muted-foreground">
              {t(
                'generalManagement.branding.urlHint',
                '支持图片地址或 data: URL；建议方形图标且小于 180 KiB（logo 会在每次打开控制台时下发），保存后生效。'
              )}
            </p>
          </div>
        </div>

        <div className="flex justify-end">
          <Button
            onClick={handleSave}
            disabled={readOnly || mutation.isPending}
          >
            {t('common.actions.save', 'Save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
