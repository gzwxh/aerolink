import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from 'react'
import {
  IconLoader2,
  IconPalette,
  IconTrash,
  IconUpload,
} from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
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
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  CLUSTER_BADGE_TEXT_MAX_LENGTH,
  CLUSTER_BADGE_TEXT_SIZE_MAX_PX,
  CLUSTER_BADGE_TEXT_SIZE_MIN_PX,
  CLUSTER_BADGE_TEXT_SIZES,
  ClusterBadge,
  ClusterBadgeIcon,
  DEFAULT_CLUSTER_BADGE_COLOR,
  isValidClusterBadgeColor,
  resolveClusterBadgeColor,
  resolveClusterBadgeForeground,
  resolveClusterBadgeIconTextSize,
  resolveClusterBadgeTextPx,
  type ClusterBadgeTextSize,
} from '@/components/cluster-badge'
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

// 字号档位的中文名，`key` 与 zh.json 的 clusterBadge.* 一一对应。
const BADGE_TEXT_SIZE_LABELS: Record<
  ClusterBadgeTextSize,
  { key: string; label: string }
> = {
  sm: { key: 'clusterBadge.textSizeSm', label: '小' },
  md: { key: 'clusterBadge.textSizeMd', label: '标准' },
  lg: { key: 'clusterBadge.textSizeLg', label: '大' },
}

function createBadgeFormData(cluster?: Cluster | null) {
  return {
    badgeEnabled: cluster?.badgeEnabled ?? false,
    badgeText: cluster?.badgeText || '',
    // 字号以像素值回填：预设档位换算成 10/12/14，输入框就是个普通数字框。
    badgeTextSize: String(resolveClusterBadgeTextPx(cluster?.badgeTextSize)),
    badgeBold: cluster?.badgeBold ?? false,
    badgeColor: cluster?.badgeColor || DEFAULT_CLUSTER_BADGE_COLOR,
    badgeTextColor: cluster?.badgeTextColor || '',
    badgeIconEnabled: cluster?.badgeIconEnabled ?? false,
    badgeIconText: cluster?.badgeIconText || '',
    // 图标文本的排版与说明各自独立，空值分别表示「自动」。
    badgeIconTextSize: resolveClusterBadgeIconTextSize(
      cluster?.badgeIconTextSize
    ),
    badgeIconTextColor: cluster?.badgeIconTextColor || '',
    badgeIconTextBackground: cluster?.badgeIconTextBackground || '',
    badgeIconBold: cluster?.badgeIconBold ?? false,
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
  // 说明字号是像素值，限定在 10~24 的整数（后端同口径）；留空按标准档。
  const textSizeValue = formData.badgeTextSize.trim()
  const isTextSizeValid =
    textSizeValue === '' ||
    (Number.isInteger(Number(textSizeValue)) &&
      Number(textSizeValue) >= CLUSTER_BADGE_TEXT_SIZE_MIN_PX &&
      Number(textSizeValue) <= CLUSTER_BADGE_TEXT_SIZE_MAX_PX)
  // 说明字色留空表示「按背景色自动」；填了就必须是十六进制（后端同样只收 #RRGGBB）。
  const isTextColorValid =
    !formData.badgeTextColor.trim() ||
    isValidClusterBadgeColor(formData.badgeTextColor)
  // 图标文本的底色 / 字色留空分别表示「用徽章背景色」「按底色自动」；
  // 填了就必须是十六进制（后端同样只收 #RRGGBB）。
  const isIconTextColorValid =
    !formData.badgeIconTextColor.trim() ||
    isValidClusterBadgeColor(formData.badgeIconTextColor)
  const isIconTextBackgroundValid =
    !formData.badgeIconTextBackground.trim() ||
    isValidClusterBadgeColor(formData.badgeIconTextBackground)
  // 只有颜色没有文案会渲染成一个空色块，所以启用徽章时说明必填。
  const canSubmit =
    isColorValid &&
    isTextSizeValid &&
    isTextColorValid &&
    isIconTextColorValid &&
    isIconTextBackgroundValid &&
    (!formData.badgeEnabled || badgeText !== '')

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
      // 否则开关还关着，预览里根本不显示刚传上去的图标。
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
      badgeTextSize: formData.badgeTextSize,
      badgeBold: formData.badgeBold,
      badgeColor: formData.badgeColor.trim(),
      badgeTextColor: formData.badgeTextColor.trim(),
      badgeIconEnabled: formData.badgeIconEnabled,
      badgeIconText: formData.badgeIconText.trim(),
      badgeIconTextSize: formData.badgeIconTextSize,
      badgeIconTextColor: formData.badgeIconTextColor.trim(),
      badgeIconTextBackground: formData.badgeIconTextBackground.trim(),
      badgeIconBold: formData.badgeIconBold,
    })
  }

  return (
    // 内容比一般表单长（两套排版 + 图标上传），所以限高并让内容自己滚，
    // 否则弹窗会顶到视口上下边缘、把整页都盖住。
    <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[880px]">
      {/* 预览与标题同排：单独占一整块会把弹窗顶出屏幕。 */}
      <DialogHeader className="flex-row items-center justify-between gap-4">
        <DialogTitle className="flex items-center gap-2">
          <IconPalette className="h-5 w-5" />
          {t('clusterBadge.title', '自定义集群徽章')}
        </DialogTitle>
        <div
          className="flex min-w-0 items-center gap-2 pr-6"
          title={t('clusterBadge.preview', '集群图标和名称效果')}
        >
          <ClusterBadgeIcon cluster={previewBadge} size="lg" />
          <ClusterBadge cluster={previewBadge} />
          <span className="truncate text-sm font-medium">{cluster?.name}</span>
        </div>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="space-y-3">
        {/* 说明与图标各占一栏：单栏竖排会超过一屏，弹窗就得上下滚。 */}
        <div className="grid items-start gap-x-6 gap-y-3 md:grid-cols-2">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
              <div className="space-y-1">
                <Label htmlFor="cluster-badge-enabled">
                  {t('clusterBadge.enabled', '显示此集群的徽章')}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t(
                    'clusterBadge.enabledHint',
                    '关闭后，顶栏、创建页与集群管理列表都不显示这个徽章；图标由下面单独控制。'
                  )}
                </p>
              </div>
              <Switch
                id="cluster-badge-enabled"
                checked={formData.badgeEnabled}
                onCheckedChange={(checked) =>
                  handleChange('badgeEnabled', checked)
                }
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

            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="cluster-badge-text-size">
                  {t('clusterBadge.textSize', '字号')}
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="cluster-badge-text-size"
                    type="number"
                    min={CLUSTER_BADGE_TEXT_SIZE_MIN_PX}
                    max={CLUSTER_BADGE_TEXT_SIZE_MAX_PX}
                    step={1}
                    value={formData.badgeTextSize}
                    onChange={(e) =>
                      handleChange('badgeTextSize', e.target.value)
                    }
                    className="h-8 w-20 font-mono"
                  />
                  <span className="text-xs text-muted-foreground">
                    {t('clusterBadge.textSizeHint', 'px（{{min}}–{{max}}）', {
                      min: CLUSTER_BADGE_TEXT_SIZE_MIN_PX,
                      max: CLUSTER_BADGE_TEXT_SIZE_MAX_PX,
                    })}
                  </span>
                </div>
                {!isTextSizeValid && (
                  <p className="text-xs text-destructive">
                    {t(
                      'clusterBadge.textSizeInvalid',
                      '请填写 {{min}}–{{max}} 之间的整数',
                      {
                        min: CLUSTER_BADGE_TEXT_SIZE_MIN_PX,
                        max: CLUSTER_BADGE_TEXT_SIZE_MAX_PX,
                      }
                    )}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 pb-1.5">
                <Switch
                  id="cluster-badge-bold"
                  checked={formData.badgeBold}
                  onCheckedChange={(checked) =>
                    handleChange('badgeBold', checked)
                  }
                />
                <Label htmlFor="cluster-badge-bold">
                  {t('clusterBadge.bold', '加粗')}
                </Label>
              </div>
            </div>

            {/* 底色与字色并排：两列各放一个取色器 + 一个输入框，省掉近一半竖向空间。 */}
            <div className="grid gap-3 sm:grid-cols-2">
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
                    className="h-9 w-12 shrink-0 cursor-pointer rounded-md border bg-transparent p-0.5"
                  />
                  <Input
                    value={formData.badgeColor}
                    onChange={(e) => handleChange('badgeColor', e.target.value)}
                    placeholder={DEFAULT_CLUSTER_BADGE_COLOR}
                    className="min-w-0 flex-1 font-mono"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('clusterBadge.colorHint', '十六进制颜色，如 #0011ff')}
                </p>
                {!isColorValid && (
                  <p className="text-xs text-destructive">
                    {t(
                      'clusterBadge.colorInvalid',
                      '请填写十六进制颜色，如 #0011ff'
                    )}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="cluster-badge-text-color">
                  {t('clusterBadge.textColor', '说明文字颜色')}
                </Label>
                <div className="flex items-center gap-2">
                  <input
                    id="cluster-badge-text-color"
                    type="color"
                    aria-label={t('clusterBadge.textColor', '说明文字颜色')}
                    value={
                      isValidClusterBadgeColor(formData.badgeTextColor)
                        ? formData.badgeTextColor.trim()
                        : resolveClusterBadgeForeground(formData.badgeColor)
                            .color
                    }
                    onChange={(e) =>
                      handleChange('badgeTextColor', e.target.value)
                    }
                    className="h-9 w-12 shrink-0 cursor-pointer rounded-md border bg-transparent p-0.5"
                  />
                  <Input
                    value={formData.badgeTextColor}
                    onChange={(e) =>
                      handleChange('badgeTextColor', e.target.value)
                    }
                    placeholder={t('clusterBadge.textColorAuto', '留空自动')}
                    className="min-w-0 flex-1 font-mono"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {t(
                    'clusterBadge.textColorHint',
                    '留空则按徽章背景色自动取黑/白字'
                  )}
                </p>
                {!isTextColorValid && (
                  <p className="text-xs text-destructive">
                    {t(
                      'clusterBadge.textColorInvalid',
                      '请填写十六进制颜色，如 #0011ff'
                    )}
                  </p>
                )}
              </div>
            </div>
          </div>

          <div className="space-y-3 border-t pt-4 md:border-t-0 md:border-l md:pl-4 md:pt-0">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-1">
                <Label htmlFor="cluster-badge-icon-enabled">
                  {t('clusterBadge.iconEnabled', '自定义集群图标')}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t(
                    'clusterBadge.iconHint',
                    '关闭时不显示图标；开启后可上传图片，或用最多 6 个汉字代替默认图标。'
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
              {/* 开关关着时图标位整体不显示：默认图标只在开启后作为占位出现。 */}
              {formData.badgeIconEnabled && (
                // 最小 36px 的方形底槽；图标文本跟随说明字号后会变宽，所以宽度不锁死。
                <span className="flex h-9 min-w-9 shrink-0 items-center justify-center rounded-md border bg-muted/30 px-1">
                  <ClusterBadgeIcon cluster={previewBadge} size="lg" />
                </span>
              )}
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
                'PNG / JPG，≤{{limit}}，自动裁方缩放到 {{size}}×{{size}}。',
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
                placeholder={t(
                  'clusterBadge.iconTextPlaceholder',
                  '如：测试环境'
                )}
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

            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="space-y-1.5">
                <Label>{t('clusterBadge.iconTextSize', '图标文本字号')}</Label>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  // 空值（自动）在界面上要有选中项，否则看着像「什么都没选」。
                  value={formData.badgeIconTextSize || 'auto'}
                  onValueChange={(value) => {
                    if (value) {
                      handleChange(
                        'badgeIconTextSize',
                        value === 'auto' ? '' : value
                      )
                    }
                  }}
                  aria-label={t('clusterBadge.iconTextSize', '图标文本字号')}
                >
                  <ToggleGroupItem value="auto" className="h-8 px-3 text-xs">
                    {t('clusterBadge.iconTextSizeAuto', '自动')}
                  </ToggleGroupItem>
                  {CLUSTER_BADGE_TEXT_SIZES.map((size) => (
                    <ToggleGroupItem
                      key={size}
                      value={size}
                      className="h-8 px-3 text-xs"
                    >
                      {t(
                        BADGE_TEXT_SIZE_LABELS[size].key,
                        BADGE_TEXT_SIZE_LABELS[size].label
                      )}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
              <div className="flex items-center gap-2 pb-1.5">
                <Switch
                  id="cluster-badge-icon-bold"
                  checked={formData.badgeIconBold}
                  onCheckedChange={(checked) =>
                    handleChange('badgeIconBold', checked)
                  }
                />
                <Label htmlFor="cluster-badge-icon-bold">
                  {t('clusterBadge.iconTextBold', '图标文本加粗')}
                </Label>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="cluster-badge-icon-text-background">
                  {t('clusterBadge.iconTextBackground', '图标文本背景色')}
                </Label>
                <div className="flex items-center gap-2">
                  <input
                    id="cluster-badge-icon-text-background"
                    type="color"
                    aria-label={t(
                      'clusterBadge.iconTextBackground',
                      '图标文本背景色'
                    )}
                    value={
                      isValidClusterBadgeColor(formData.badgeIconTextBackground)
                        ? formData.badgeIconTextBackground.trim()
                        : resolveClusterBadgeColor(formData.badgeColor)
                    }
                    onChange={(e) =>
                      handleChange('badgeIconTextBackground', e.target.value)
                    }
                    className="h-9 w-12 shrink-0 cursor-pointer rounded-md border bg-transparent p-0.5"
                  />
                  <Input
                    value={formData.badgeIconTextBackground}
                    onChange={(e) =>
                      handleChange('badgeIconTextBackground', e.target.value)
                    }
                    placeholder={t(
                      'clusterBadge.iconTextBackgroundAuto',
                      '同徽章'
                    )}
                    className="min-w-0 flex-1 font-mono"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {t(
                    'clusterBadge.iconTextBackgroundHint',
                    '留空则用徽章背景色'
                  )}
                </p>
                {!isIconTextBackgroundValid && (
                  <p className="text-xs text-destructive">
                    {t(
                      'clusterBadge.iconTextBackgroundInvalid',
                      '请填写十六进制颜色，如 #0011ff'
                    )}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="cluster-badge-icon-text-color">
                  {t('clusterBadge.iconTextColor', '图标文本颜色')}
                </Label>
                <div className="flex items-center gap-2">
                  <input
                    id="cluster-badge-icon-text-color"
                    type="color"
                    aria-label={t('clusterBadge.iconTextColor', '图标文本颜色')}
                    value={
                      isValidClusterBadgeColor(formData.badgeIconTextColor)
                        ? formData.badgeIconTextColor.trim()
                        : '#ffffff'
                    }
                    onChange={(e) =>
                      handleChange('badgeIconTextColor', e.target.value)
                    }
                    className="h-9 w-12 shrink-0 cursor-pointer rounded-md border bg-transparent p-0.5"
                  />
                  <Input
                    value={formData.badgeIconTextColor}
                    onChange={(e) =>
                      handleChange('badgeIconTextColor', e.target.value)
                    }
                    placeholder={t(
                      'clusterBadge.iconTextColorAuto',
                      '留空按底色'
                    )}
                    className="min-w-0 flex-1 font-mono"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {t(
                    'clusterBadge.iconTextColorHint',
                    '留空则按上方的底色自动取黑/白字'
                  )}
                </p>
                {!isIconTextColorValid && (
                  <p className="text-xs text-destructive">
                    {t(
                      'clusterBadge.iconTextColorInvalid',
                      '请填写十六进制颜色，如 #0011ff'
                    )}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="border-t pt-4">
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
