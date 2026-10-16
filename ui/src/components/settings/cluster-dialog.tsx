import { useCallback, useEffect, useState } from 'react'
import { IconCopy, IconEdit, IconEye, IconServer } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Cluster } from '@/types/api'
import { ClusterCreateRequest } from '@/lib/api'
import { apiClient } from '@/lib/api-client'
import { copyToClipboard } from '@/lib/clipboard'
import { withClusterPath } from '@/lib/cluster-path'
import { isValidClusterSlug } from '@/lib/cluster-slug'
import { withSubPath } from '@/lib/subpath'
import {
  useDraftDirty,
  useUnsavedChangesGuard,
} from '@/hooks/use-unsaved-changes-guard'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { UnsavedChangesConfirmDialog } from '@/components/unsaved-changes-confirm-dialog'

interface ClusterDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  cluster?: Cluster | null
  onSubmit: (clusterData: ClusterCreateRequest) => void
}

function createClusterFormData(cluster?: Cluster | null) {
  return {
    name: cluster?.name || '',
    description: cluster?.description || '',
    // URL 短名只在创建时可选填；编辑模式下短名已固化，不进表单。
    slug: '',
    // 编辑时**不回填**配置。
    //
    // 后端存的是加密凭据：回显既泄露凭据，还会因为「原样提交回去 → 后端再加密一次」
    // 而变成**双重加密**——真机上的表现就是「保存几次之后，配置框里变成一串 base64」。
    // 要改就重新粘贴；要看请走受 MFA 保护的「查看当前配置」。
    config: '',
    prometheusURL: cluster?.prometheusURL || '',
    enabled: cluster?.enabled ?? true,
    isDefault: cluster?.isDefault ?? false,
    inCluster: cluster?.inCluster ?? false,
    clusterAgent: cluster?.clusterAgent ?? false,
  }
}

export function ClusterDialog({
  open,
  onOpenChange,
  cluster,
  onSubmit,
}: ClusterDialogProps) {
  // 草稿在条件挂载的内容组件里，关闭即丢弃；「有没有改动」上报到这一层，
  // 由 useUnsavedChangesGuard 拦截遮罩点击 / Esc / 右上角 X。
  const [isDraftDirty, setIsDraftDirty] = useState(false)
  const close = useCallback(() => onOpenChange(false), [onOpenChange])
  const guard = useUnsavedChangesGuard({ dirty: isDraftDirty, onClose: close })

  return (
    <>
      <Dialog open={open} onOpenChange={guard.handleOpenChange}>
        {open ? (
          <ClusterDialogContent
            key={cluster?.id ?? 'new'}
            cluster={cluster}
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

function ClusterDialogContent({
  cluster,
  onSubmit,
  onDraftChange,
  onRequestClose,
}: Omit<ClusterDialogProps, 'open' | 'onOpenChange'> & {
  /** 上报是否有草稿，父级据此决定关闭时是否先弹确认。 */
  onDraftChange: (hasDraft: boolean) => void
  /** 需要用户确认的关闭请求（取消按钮）。 */
  onRequestClose: () => void
}) {
  const { t } = useTranslation()
  const isEditMode = !!cluster
  const [isLoadingConfig, setIsLoadingConfig] = useState(false)

  // 查看已存的 kubeconfig：属于凭据暴露操作，后端受 MFA step-up 保护——
  // 开启 MFA 且已绑定的管理员会先弹出动态码验证，验证通过后自动重放请求。
  const handleViewConfig = async () => {
    if (!cluster?.id) return
    setIsLoadingConfig(true)
    try {
      const data = await apiClient.get<{ config: string }>(
        `/admin/clusters/${encodeURIComponent(cluster.name)}/kubeconfig`
      )
      handleChange('config', data.config)
      toast.success(
        t('clusterManagement.dialog.configLoaded', '当前配置已加载')
      )
    } catch {
      toast.error(
        t('clusterManagement.dialog.configLoadFailed', '加载当前配置失败')
      )
    } finally {
      setIsLoadingConfig(false)
    }
  }

  const [formData, setFormData] = useState(() => createClusterFormData(cluster))
  // 首帧表单（编辑时为集群当前值，新建为空）即基线；改过才算未保存。
  const isDirty = useDraftDirty(formData)
  useEffect(() => {
    onDraftChange(isDirty)
  }, [isDirty, onDraftChange])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (isEditMode) {
      // 短名创建时固化：编辑表单不含 slug 输入（后端更新接口不接收该字段，
      // 这里原样透传其余字段即可）。
      onSubmit(formData)
      return
    }
    const slug = formData.slug.trim()
    // 手填值非法时前端先挡一层；留空则交给后端自动生成。
    if (slug && !isValidClusterSlug(slug)) {
      toast.error(t('clusterManagement.dialog.slugInvalid'))
      return
    }
    onSubmit({ ...formData, slug: slug || undefined })
  }

  const handleChange = (field: string, value: string | boolean) => {
    setFormData((prev) => ({
      ...prev,
      [field]: value,
    }))
  }

  // 短名固化后唯一能改的就是「分享哪个链接」，所以编辑态提供完整地址的一键复制。
  const handleCopyClusterLink = async () => {
    const slug = cluster?.slug
    if (!slug) return
    const link = `${window.location.origin}${withSubPath(
      withClusterPath('/', slug)
    )}`
    if (await copyToClipboard(link)) {
      toast.success(t('common.messages.copied'))
    } else {
      toast.error(t('common.messages.copyFailed'))
    }
  }

  return (
    <DialogContent className="sm:max-w-[600px]">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          {isEditMode ? (
            <IconEdit className="h-5 w-5" />
          ) : (
            <IconServer className="h-5 w-5" />
          )}
          {isEditMode
            ? t('clusterManagement.dialog.editTitle', 'Edit Cluster')
            : t('clusterManagement.dialog.createTitle', 'Add New Cluster')}
        </DialogTitle>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="cluster-name">
              {t('clusterManagement.dialog.name', 'Cluster Name')} *
            </Label>
            <Input
              id="cluster-name"
              value={formData.name}
              onChange={(e) => handleChange('name', e.target.value)}
              placeholder={t(
                'clusterManagement.dialog.namePlaceholder',
                'e.g., production, staging'
              )}
              required
            />
          </div>

          {!isEditMode && (
            <div className="space-y-2">
              <Label htmlFor="cluster-type">
                {t('clusterManagement.dialog.type', 'Cluster Type')}
              </Label>
              <Select
                value={
                  formData.clusterAgent
                    ? 'clusterAgent'
                    : formData.inCluster
                      ? 'inCluster'
                      : 'external'
                }
                onValueChange={(value) => {
                  setFormData((prev) => ({
                    ...prev,
                    clusterAgent: value === 'clusterAgent',
                    inCluster: value === 'inCluster',
                    config: value === 'external' ? prev.config : '',
                  }))
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="external">
                    {t('clusterManagement.type.external', 'External Cluster')}
                  </SelectItem>
                  <SelectItem value="inCluster">
                    {t('clusterManagement.type.inCluster', 'In-Cluster')}
                  </SelectItem>
                  <SelectItem value="clusterAgent">
                    {t('clusterManagement.type.clusterAgent', 'Cluster Agent')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        {isEditMode ? (
          <div className="space-y-2">
            <Label htmlFor="cluster-slug">
              {t('clusterManagement.dialog.slugLabel')}
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id="cluster-slug"
                value={cluster?.slug ?? ''}
                readOnly
                className="font-mono"
              />
              <Button
                type="button"
                variant="outline"
                onClick={handleCopyClusterLink}
                disabled={!cluster?.slug}
              >
                <IconCopy className="h-4 w-4" />
                {t('common.actions.copy')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('clusterManagement.dialog.slugReadonlyHint')}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="cluster-slug">
              {t('clusterManagement.dialog.slugLabel')}
            </Label>
            <Input
              id="cluster-slug"
              value={formData.slug}
              onChange={(e) => handleChange('slug', e.target.value)}
              placeholder={t('clusterManagement.dialog.slugAutoPlaceholder')}
              aria-invalid={
                !!formData.slug.trim() && !isValidClusterSlug(formData.slug)
              }
            />
            <p className="text-xs text-muted-foreground">
              {t('clusterManagement.dialog.slugHint')}
            </p>
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="cluster-description">
            {t('clusterManagement.dialog.description', 'Description')}
          </Label>
          <Textarea
            id="cluster-description"
            value={formData.description}
            onChange={(e) => handleChange('description', e.target.value)}
            placeholder={t(
              'clusterManagement.dialog.descriptionPlaceholder',
              'Brief description of this cluster'
            )}
            rows={2}
          />
        </div>

        {!formData.inCluster && !formData.clusterAgent && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="cluster-config">
                {t('clusterManagement.dialog.config', 'Kubeconfig')}
                {!isEditMode && ' *'}
              </Label>
              {isEditMode && cluster?.id && (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50"
                  disabled={isLoadingConfig}
                  onClick={handleViewConfig}
                >
                  <IconEye className="h-3.5 w-3.5" />
                  {t(
                    'clusterManagement.dialog.viewCurrentConfig',
                    '查看当前配置'
                  )}
                </button>
              )}
            </div>
            {isEditMode && (
              <p className="text-xs text-muted-foreground">
                {t(
                  'common.messages.keepCurrentConfiguration',
                  'Leave empty to keep current configuration'
                )}
              </p>
            )}
            <Textarea
              id="cluster-config"
              value={formData.config}
              onChange={(e) => handleChange('config', e.target.value)}
              placeholder={t(
                'clusterManagement.dialog.configPlaceholder',
                'Paste your kubeconfig content here...'
              )}
              rows={8}
              className="text-sm"
              required={
                !isEditMode && !formData.inCluster && !formData.clusterAgent
              }
            />
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="prometheus-url">
            {t('clusterManagement.dialog.prometheusUrl', 'Prometheus URL')}
          </Label>
          <Input
            id="prometheus-url"
            value={formData.prometheusURL}
            onChange={(e) => handleChange('prometheusURL', e.target.value)}
            type="url"
          />
        </div>

        {/* Cluster Status Controls */}
        <div className="space-y-4 border-t pt-4">
          {/* Enabled Status */}
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <Label htmlFor="cluster-enabled">
                {t('clusterManagement.dialog.enabled', 'Enable Cluster')}
              </Label>
            </div>
            <Switch
              id="cluster-enabled"
              checked={formData.enabled}
              onCheckedChange={(checked) => handleChange('enabled', checked)}
            />
          </div>

          {/* Default Status */}
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <Label htmlFor="cluster-default">
                {t('clusterManagement.dialog.isDefault', 'Set as Default')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t(
                  'common.messages.defaultClusterDescription',
                  'Use this cluster as the default for new operations'
                )}
              </p>
            </div>
            <Switch
              id="cluster-default"
              checked={formData.isDefault}
              onCheckedChange={(checked) => handleChange('isDefault', checked)}
            />
          </div>
        </div>

        {formData.inCluster && (
          <div className="p-4 bg-info/10 rounded-lg border border-info/25">
            <p className="text-sm text-info">
              {t(
                'common.messages.inClusterConfiguration',
                'This cluster uses the in-cluster service account configuration. No additional kubeconfig is required.'
              )}
            </p>
          </div>
        )}
        {formData.clusterAgent && (
          <div className="p-4 bg-info/10 rounded-lg border border-info/25">
            <p className="text-sm text-info">
              {t(
                'clusterManagement.dialog.clusterAgentDescription',
                'Create the cluster first, then run the generated command inside the target cluster.'
              )}
            </p>
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onRequestClose}>
            {t('common.actions.cancel', 'Cancel')}
          </Button>
          <Button
            type="submit"
            disabled={
              !formData.name ||
              (!isEditMode &&
                !formData.inCluster &&
                !formData.clusterAgent &&
                !formData.config)
            }
          >
            {isEditMode
              ? t('common.actions.saveChanges', 'Save Changes')
              : t('clusterManagement.actions.add', 'Add Cluster')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}
