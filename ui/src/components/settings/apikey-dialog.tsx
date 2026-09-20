import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

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
