import { useCallback, useEffect, useState } from 'react'
import { IconCopy } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { CreatedAPIKey } from '@/types/api'
import { copyToClipboard } from '@/lib/clipboard'
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
import { UnsavedChangesConfirmDialog } from '@/components/unsaved-changes-confirm-dialog'

interface APIKeyDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (data: { name: string }) => void
  isLoading?: boolean
}

export function APIKeyDialog({
  open,
  onOpenChange,
  onSubmit,
  isLoading,
}: APIKeyDialogProps) {
  // 草稿在条件挂载的内容组件里，关闭即丢弃；「有没有改动」上报到这一层，
  // 由 useUnsavedChangesGuard 拦截遮罩点击 / Esc / 右上角 X。
  const [isDraftDirty, setIsDraftDirty] = useState(false)
  const close = useCallback(() => onOpenChange(false), [onOpenChange])
  const guard = useUnsavedChangesGuard({ dirty: isDraftDirty, onClose: close })

  return (
    <>
      <Dialog open={open} onOpenChange={guard.handleOpenChange}>
        {open ? (
          <APIKeyDialogContent
            onSubmit={onSubmit}
            isLoading={isLoading}
            onDraftChange={setIsDraftDirty}
            onRequestClose={() => guard.handleOpenChange(false)}
          />
        ) : null}
      </Dialog>

      <UnsavedChangesConfirmDialog {...guard.confirmDialogProps} />
    </>
  )
}

/**
 * 完整密钥只在创建响应里出现一次（列表只给前缀），所以创建成功后必须当场展示：
 * 关掉这个弹窗就再也看不到它了。
 */
export function APIKeySecretDialog({
  apiKey,
  open,
  onOpenChange,
}: {
  apiKey: CreatedAPIKey | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()

  const handleCopy = async () => {
    if (!apiKey) {
      return
    }
    if (await copyToClipboard(apiKey.key)) {
      toast.success(t('apikeyManagement.messages.copied', '已复制到剪贴板'))
      return
    }
    toast.error(
      t('common.messages.copyFailed', '复制失败，请手动选择文本后复制')
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('apikeyManagement.secret.title', 'API 密钥已创建')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'apikeyManagement.secret.description',
              '下面是完整密钥，请复制到目标系统。'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="flex items-start gap-2">
            <code className="bg-muted flex-1 rounded px-2 py-1.5 text-sm break-all select-all">
              {apiKey?.key}
            </code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void handleCopy()}
            >
              <IconCopy className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-sm text-destructive">
            {t(
              'apikeyManagement.secret.warning',
              '关闭后无法再次查看。密钥丢失只能删除该条目后重新创建。'
            )}
          </p>
        </div>

        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t('apikeyManagement.secret.done', '我已保存')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function APIKeyDialogContent({
  onSubmit,
  isLoading,
  onDraftChange,
  onRequestClose,
}: Omit<APIKeyDialogProps, 'open' | 'onOpenChange'> & {
  /** 上报是否有草稿，父级据此决定关闭时是否先弹确认。 */
  onDraftChange: (hasDraft: boolean) => void
  /** 需要用户确认的关闭请求（取消按钮）。 */
  onRequestClose: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  // 名称只在组件挂载时初始化，首帧空串即基线；改过才算未保存。
  const isDirty = useDraftDirty(name)
  useEffect(() => {
    onDraftChange(isDirty)
  }, [isDirty, onDraftChange])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    if (!name.trim()) {
      setError(t('common.values.required', 'This field is required'))
      return
    }

    onSubmit({ name: name.trim() })
  }

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>
          {t('common.actions.create', 'Create')}{' '}
          {t('common.fields.apiKey', 'API Key')}
        </DialogTitle>
        <DialogDescription>
          {t(
            'common.messages.createApiKeyDescription',
            'Create a new API key for programmatic access.'
          )}
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSubmit}>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="name">{t('common.fields.name', 'Name')}</Label>
            <Input
              id="name"
              placeholder={t(
                'common.placeholders.apiKeyName',
                'e.g., CI API Key'
              )}
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setError('')
              }}
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onRequestClose}>
            {t('common.actions.cancel', 'Cancel')}
          </Button>
          <Button type="submit" disabled={isLoading}>
            {isLoading
              ? t('common.messages.creating', 'Creating...')
              : t('common.actions.create', 'Create')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}
