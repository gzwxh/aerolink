import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  IconLoader2,
  IconPalette,
  IconTrash,
  IconUpload,
} from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Cluster } from '@/types/api'
import {
  ClusterBadgeUpdateRequest,
  deleteClusterBadgeIcon,
  uploadClusterBadgeIcon,
} from '@/lib/api'
import {
  CLUSTER_ICON_MAX_BYTES,
  CLUSTER_ICON_TARGET_SIZE,
  prepareClusterIconFile,
} from '@/lib/cluster-icon-upload'
import { formatBytes, translateError } from '@/lib/utils'
import {
  useDraftDirty,
  useUnsavedChangesGuard,
} from '@/hooks/use-unsaved-changes-guard'
import {
  CLUSTER_BADGE_TEXT_MAX_LENGTH,
  ClusterBadge,
  ClusterBadgeIcon,
  DEFAULT_CLUSTER_BADGE_COLOR,
  isValidClusterBadgeColor,
} from '@/components/cluster-badge'
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
import { Switch } from '@/components/ui/switch'
import { UnsavedChangesConfirmDialog } from '@/components/unsaved-changes-confirm-dialog'

interface ClusterBadgeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  cluster?: Cluster | null
  onSubmit: (data: ClusterBadgeUpdateRequest) => void
  isPending?: boolean
}

/**
 * 图标文本的长度上限，按字符计，与服务端的 maxBadgeIconTextRunes 一致
 * （pkg/cluster/cluster_handler.go）：6 个汉字。超长后端会 400，不静默截断。
 */
const CLUSTER_ICON_TEXT_MAX_LENGTH = 6

function createBadgeFormData(cluster?: Cluster | null) {
  return {
    badgeEnabled: cluster?.badgeEnabled ?? false,
    badgeText: cluster?.badgeText || '',
    badgeColor: cluster?.badgeColor || DEFAULT_CLUSTER_BADGE_COLOR,
    badgeIconEnabled: cluster?.badgeIconEnabled ?? false,
    badgeIconText: cluster?.badgeIconText || '',
  }
}

export function ClusterBadgeDialog({
  open,
  onOpenChange,
  cluster,
  onSubmit,
  isPending,
}: ClusterBadgeDialogProps) {
  // 草稿在条件挂载的内容组件里，关闭即丢弃；「有没有改动」上报到这一层，
  // 由 useUnsavedChangesGuard 拦截遮罩点击 / Esc / 右上角 X。
  const [isDraftDirty, setIsDraftDirty] = useState(false)
  const close = useCallback(() => onOpenChange(false), [onOpenChange])
  const guard = useUnsavedChangesGuard({ dirty: isDraftDirty, onClose: close })

  return (
    <>
      <Dialog open={open} onOpenChange={guard.handleOpenChange}>
        {open ? (
          <ClusterBadgeDialogContent
            key={cluster?.id ?? cluster?.name ?? 'badge'}
            cluster={cluster}
            onSubmit={onSubmit}
            isPending={isPending}
            onDraftChange={setIsDraftDirty}
            onRequestClose={() => guard.handleOpenChange(false)}
          />
        ) : null}
      </Dialog>

      <UnsavedChangesConfirmDialog {...guard.confirmDialogProps} />
    </>
  )
}

function ClusterBadgeDialogContent({
  cluster,
  onSubmit,
  isPending,
  onDraftChange,
  onRequestClose,
}: Omit<ClusterBadgeDialogProps, 'open' | 'onOpenChange'> & {
  /** 上报是否有草稿，父级据此决定关闭时是否先弹确认。 */
  onDraftChange: (hasDraft: boolean) => void
  /** 需要用户确认的关闭请求（取消按钮）。 */
  onRequestClose: () => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [formData, setFormData] = useState(() => createBadgeFormData(cluster))
  // 图标是即时落库的独立操作（与头像一致），不进表单草稿：上传/删除立刻生效，
  // 这里只跟踪当前生效的地址，用来渲染预览与「移除」按钮。
  const [iconUrl, setIconUrl] = useState(cluster?.badgeIconUrl ?? '')
  const [iconBusy, setIconBusy] = useState(false)
  const [iconError, setIconError] = useState('')
  const iconInputRef = useRef<HTMLInputElement>(null)
  // 首帧表单即基线；改过才算未保存。
  const isDirty = useDraftDirty(formData)
  useEffect(() => {
    onDraftChange(isDirty)
  }, [isDirty, onDraftChange])

  const handleChange = (field: string, value: string | boolean) => {
    setFormData((prev) => ({
      ...prev,
      [field]: value,
    }))
  }

  const badgeText = formData.badgeText.trim()
  // 颜色留空表示「用默认色」；非空时必须是十六进制，后端同样只收 #RRGGBB。
  const isColorValid =
    !formData.badgeColor.trim() || isValidClusterBadgeColor(formData.badgeColor)
  // 只有颜色没有文案会渲染成一个空色块，所以启用徽章时说明必填。
  const canSubmit = isColorValid && (!formData.badgeEnabled || badgeText !== '')

  // 预览合并表单草稿与已落库的图标地址：文本与底色取草稿（未保存也先给用户看到效果），
  // 图片地址取服务端当前状态。
  const previewBadge = { ...formData, badgeIconUrl: iconUrl }
  const hasUploadedIcon = iconUrl !== ''

  const refreshClusterQueries = () => {
    // 图标同时出现在集群切换器与顶栏，两处都读这两个查询；不失效的话
    // 用户得等缓存过期才看到新图标。
    queryClient.invalidateQueries({ queryKey: ['cluster-list'] })
    queryClient.invalidateQueries({ queryKey: ['clusters'] })
  }

  const handleIconUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    // 清空 input：否则再次选择同一个文件不会触发 change。
    event.target.value = ''
    if (!file || !cluster) {
      return
    }

    setIconBusy(true)
    setIconError('')
    try {
      // 与头像同一条链路：先在浏览器里裁方、缩放、重编码，
      // 参数与限制见 lib/cluster-icon-upload.ts。
      const prepared = await prepareClusterIconFile(file)
      const result = await uploadClusterBadgeIcon(cluster.id, prepared)
      setIconUrl(result.badgeIconUrl)
      // 服务端上传时会顺带打开 badge_icon_enabled，本地跟着同步，
      // 否则预览仍会按「图标关着」渲染成默认图标。
      handleChange('badgeIconEnabled', true)
      refreshClusterQueries()
      toast.success(t('clusterBadge.iconUploadSuccess', '集群图标已更新'))
    } catch (err) {
      setIconError(
        translateError(err, t) ||
          t('clusterBadge.iconUploadFailed', '图标上传失败')
      )
    } finally {
      setIconBusy(false)
    }
  }

  const handleIconRemove = async () => {
    if (!cluster) {
      return
    }

    setIconBusy(true)
    setIconError('')
    try {
      await deleteClusterBadgeIcon(cluster.id)
      setIconUrl('')
      refreshClusterQueries()
      toast.success(t('clusterBadge.iconRemoveSuccess', '已移除集群图标'))
    } catch (err) {
      setIconError(translateError(err, t))
    } finally {
      setIconBusy(false)
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) {
      return
    }
    onSubmit({
      badgeEnabled: formData.badgeEnabled,
      badgeText,
      badgeColor: formData.badgeColor.trim(),
      badgeIconEnabled: formData.badgeIconEnabled,
      badgeIconText: formData.badgeIconText.trim(),
    })
  }

  return (
    <DialogContent className="sm:max-w-[600px]">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <IconPalette className="h-5 w-5" />
          {t('clusterBadge.title', '自定义集群徽章')}
        </DialogTitle>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
          <p className="text-xs text-muted-foreground">
            {t('clusterBadge.preview', '集群图标和名称效果')}
          </p>
          <div className="flex min-w-0 items-center gap-2">
            <ClusterBadgeIcon cluster={previewBadge} size="lg" />
            <ClusterBadge cluster={previewBadge} />
            <span className="truncate font-medium">{cluster?.name}</span>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
          <div className="space-y-1">
            <Label htmlFor="cluster-badge-enabled">
              {t('clusterBadge.enabled', '显示此集群的徽章')}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t(
                'clusterBadge.enabledHint',
                '关闭后，顶栏与创建页的「当前集群」、集群管理列表都不再显示这个徽章；集群图标由下面的「自定义集群图标」单独控制。'
              )}
            </p>
          </div>
          <Switch
            id="cluster-badge-enabled"
            checked={formData.badgeEnabled}
            onCheckedChange={(checked) => handleChange('badgeEnabled', checked)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="cluster-badge-text">
            {t('clusterBadge.text', '自定义说明')} *
          </Label>
          <Input
            id="cluster-badge-text"
            value={formData.badgeText}
            onChange={(e) => handleChange('badgeText', e.target.value)}
            placeholder={t('clusterBadge.textPlaceholder', '如：测试环境')}
            maxLength={CLUSTER_BADGE_TEXT_MAX_LENGTH}
            required
          />
          <p className="text-xs text-muted-foreground">
            {t(
              'clusterBadge.textHint',
              '最多 16 个字符，显示时会完整展示，不会截断。'
            )}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="cluster-badge-color">
            {t('clusterBadge.color', '徽章背景颜色')}
          </Label>
          <div className="flex items-center gap-2">
            <input
              id="cluster-badge-color"
              type="color"
              aria-label={t('clusterBadge.color', '徽章背景颜色')}
              value={
                isValidClusterBadgeColor(formData.badgeColor)
                  ? formData.badgeColor.trim()
                  : DEFAULT_CLUSTER_BADGE_COLOR
              }
              onChange={(e) => handleChange('badgeColor', e.target.value)}
              className="h-9 w-14 shrink-0 cursor-pointer rounded-md border bg-transparent p-0.5"
            />
            <Input
              value={formData.badgeColor}
              onChange={(e) => handleChange('badgeColor', e.target.value)}
              placeholder={DEFAULT_CLUSTER_BADGE_COLOR}
              className="w-32 font-mono"
            />
            <span className="text-xs text-muted-foreground">
              {t('clusterBadge.colorHint', '十六进制颜色，如 #0011ff')}
            </span>
          </div>
          {!isColorValid && (
            <p className="text-xs text-destructive">
              {t('clusterBadge.colorInvalid', '请填写十六进制颜色，如 #0011ff')}
            </p>
          )}
        </div>

        <div className="space-y-3 border-t pt-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="cluster-badge-icon-enabled">
                {t('clusterBadge.iconEnabled', '自定义集群图标')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t(
                  'clusterBadge.iconHint',
                  '上传一张图片，或用最多 6 个汉字代替默认的集群图标；与上面的徽章开关互不影响。'
                )}
              </p>
            </div>
            <Switch
              id="cluster-badge-icon-enabled"
              checked={formData.badgeIconEnabled}
              onCheckedChange={(checked) =>
                handleChange('badgeIconEnabled', checked)
              }
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/30">
              <ClusterBadgeIcon cluster={previewBadge} size="lg" />
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={iconBusy || !cluster}
              onClick={() => iconInputRef.current?.click()}
            >
              {iconBusy ? (
                <IconLoader2 className="size-4 animate-spin" />
              ) : (
                <IconUpload className="size-4" />
              )}
              {iconBusy
                ? t('clusterBadge.iconUploading', '处理中…')
                : t('clusterBadge.iconUpload', '上传图标')}
            </Button>
            {hasUploadedIcon && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={iconBusy}
                onClick={() => void handleIconRemove()}
              >
                <IconTrash className="size-4" />
                {t('clusterBadge.iconRemove', '移除图标')}
              </Button>
            )}
            {/* 真正的 file input 藏在按钮后面：原生控件样式与界面不统一。 */}
            <input
              ref={iconInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => void handleIconUpload(event)}
            />
          </div>

          {hasUploadedIcon && (
            <p className="text-xs text-muted-foreground">
              {t(
                'clusterBadge.iconUploadedHint',
                '当前图标来自上传，保存在本实例的数据库中；显示时优先于图标文本。'
              )}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {t(
              'clusterBadge.iconUploadHint',
              '支持 PNG / JPG，大小不超过 {{limit}}；上传前自动裁剪为正方形并缩放到 {{size}}×{{size}} 以内。',
              {
                limit: formatBytes(CLUSTER_ICON_MAX_BYTES),
                size: CLUSTER_ICON_TARGET_SIZE,
              }
            )}
          </p>

          {iconError && (
            <Alert variant="destructive">
              <AlertDescription>{iconError}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Label htmlFor="cluster-badge-icon-text">
              {t('clusterBadge.iconText', '图标文本')}
            </Label>
            <Input
              id="cluster-badge-icon-text"
              value={formData.badgeIconText}
              onChange={(e) => handleChange('badgeIconText', e.target.value)}
              placeholder={t('clusterBadge.iconTextPlaceholder', '如：测试环境')}
              maxLength={CLUSTER_ICON_TEXT_MAX_LENGTH}
              disabled={!formData.badgeIconEnabled}
            />
            <p className="text-xs text-muted-foreground">
              {t(
                'clusterBadge.iconTextHint',
                '最多 6 个汉字，显示时会完整展示，不会截断。'
              )}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onRequestClose}>
            {t('common.actions.cancel', '取消')}
          </Button>
          <Button type="submit" disabled={!canSubmit || isPending}>
            {t('common.actions.apply', '应用')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}
