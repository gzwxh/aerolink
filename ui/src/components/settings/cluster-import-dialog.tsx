import { useCallback, useEffect, useMemo, useState } from 'react'
import { IconUpload } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import { filledSlugs, findInvalidSlugContext } from '@/lib/cluster-slug'
import { parseKubeconfigContexts } from '@/lib/kubeconfig'
import {
  useDraftDirty,
  useUnsavedChangesGuard,
} from '@/hooks/use-unsaved-changes-guard'
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
import { Textarea } from '@/components/ui/textarea'
import { ClusterSlugFields } from '@/components/settings/cluster-slug-fields'
import { UnsavedChangesConfirmDialog } from '@/components/unsaved-changes-confirm-dialog'

interface ClusterImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (config: string, slugs: Record<string, string>) => void
  isSubmitting: boolean
  error?: string
  /** 集群名（= context 名）→ 已固化短名，见 ClusterSlugFields 的同名 prop。 */
  existingSlugs?: Record<string, string>
}

export function ClusterImportDialog({
  open,
  onOpenChange,
  onSubmit,
  isSubmitting,
  error,
  existingSlugs,
}: ClusterImportDialogProps) {
  // 草稿在条件挂载的内容组件里，关闭即丢弃；「有没有改动」上报到这一层，
  // 由 useUnsavedChangesGuard 拦截遮罩点击 / Esc / 右上角 X。
  const [isDraftDirty, setIsDraftDirty] = useState(false)
  const close = useCallback(() => onOpenChange(false), [onOpenChange])
  const guard = useUnsavedChangesGuard({ dirty: isDraftDirty, onClose: close })

  return (
    <>
      <Dialog open={open} onOpenChange={guard.handleOpenChange}>
        {open ? (
          <ClusterImportDialogContent
            onSubmit={onSubmit}
            isSubmitting={isSubmitting}
            error={error}
            existingSlugs={existingSlugs}
            onDraftChange={setIsDraftDirty}
            onRequestClose={() => guard.handleOpenChange(false)}
          />
        ) : null}
      </Dialog>

      <UnsavedChangesConfirmDialog {...guard.confirmDialogProps} />
    </>
  )
}

function ClusterImportDialogContent({
  onSubmit,
  isSubmitting,
  error,
  existingSlugs,
  onDraftChange,
  onRequestClose,
}: Omit<ClusterImportDialogProps, 'open' | 'onOpenChange'> & {
  /** 上报是否有草稿，父级据此决定关闭时是否先弹确认。 */
  onDraftChange: (hasDraft: boolean) => void
  /** 需要用户确认的关闭请求（取消按钮）。 */
  onRequestClose: () => void
}) {
  const { t } = useTranslation()
  const [config, setConfig] = useState('')
  const [fileError, setFileError] = useState('')
  // context 名 → 手填短名；留空的 context 走后端自动生成。
  const [slugs, setSlugs] = useState<Record<string, string>>({})
  // 初始为空串：粘贴或选文件写入的任何 kubeconfig 都视为未保存草稿。
  const isDirty = useDraftDirty(config)
  useEffect(() => {
    onDraftChange(isDirty)
  }, [isDirty, onDraftChange])

  const contexts = useMemo(() => parseKubeconfigContexts(config), [config])
  // 已存在的集群短名固化：它们的行只读，也不进校验与提交载荷——后端对同名集群只更新
  // config，提交上去的短名会被静默忽略，用户会以为改成功了。
  const editableContexts = useMemo(
    () => contexts.filter((context) => !existingSlugs?.[context]),
    [contexts, existingSlugs]
  )
  // 手填值里只要有一个非法就整批不提交：后端是 fail-closed 的，前端提前挡一层。
  const invalidContext = useMemo(
    () => findInvalidSlugContext(editableContexts, slugs),
    [editableContexts, slugs]
  )

  const handleFileSelect = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      setConfig(await file.text())
      setFileError('')
    } catch {
      setFileError(
        t(
          'clusterManagement.messages.fileReadError',
          'Failed to read kubeconfig file'
        )
      )
    }
  }

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    if (invalidContext) return
    onSubmit(config, filledSlugs(editableContexts, slugs))
  }

  return (
    <DialogContent className="sm:max-w-[600px]">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 text-balance">
          <IconUpload className="size-5" />
          {t('clusterManagement.dialog.importTitle', 'Import Clusters')}
        </DialogTitle>
        <DialogDescription className="text-pretty">
          {t(
            'clusterManagement.dialog.importDescription',
            'Import all Kubernetes contexts from a kubeconfig file.'
          )}
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="cluster-import-file">
            {t('clusterManagement.dialog.importFile', 'Kubeconfig File')}
          </Label>
          <Input
            id="cluster-import-file"
            type="file"
            onChange={handleFileSelect}
          />
          <p className="text-xs text-muted-foreground text-pretty">
            {t(
              'clusterManagement.dialog.importFileHint',
              'Choose a kubeconfig file, or paste its content below.'
            )}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="cluster-import-config">
            {t('clusterManagement.dialog.config', 'Kubeconfig')} *
          </Label>
          <Textarea
            id="cluster-import-config"
            value={config}
            onChange={(event) => {
              setConfig(event.target.value)
              setFileError('')
            }}
            placeholder={t(
              'clusterManagement.dialog.configPlaceholder',
              'Paste kubeconfig content here...'
            )}
            rows={10}
            className="font-mono text-sm"
            required
          />
        </div>

        {contexts.length > 0 && (
          <ClusterSlugFields
            contexts={contexts}
            slugs={slugs}
            onSlugChange={(context, slug) =>
              setSlugs((prev) => ({ ...prev, [context]: slug }))
            }
            invalidContext={invalidContext}
            existingSlugs={existingSlugs}
          />
        )}

        {(fileError || error) && (
          <p role="alert" className="text-sm text-destructive text-pretty">
            {fileError || error}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onRequestClose}>
            {t('common.actions.cancel', 'Cancel')}
          </Button>
          <Button
            type="submit"
            disabled={isSubmitting || !config.trim() || !!invalidContext}
          >
            {isSubmitting
              ? t('clusterManagement.actions.importing', 'Importing...')
              : t('clusterManagement.actions.import', 'Import Clusters')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}
