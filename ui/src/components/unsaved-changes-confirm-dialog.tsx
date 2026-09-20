import { IconAlertTriangle } from '@tabler/icons-react'
import { Trans, useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface UnsavedChangesConfirmDialogProps {
  open: boolean
  onCancel: () => void
  onConfirm: () => void
  /**
   * i18n key 前缀，默认 dialog.unsavedChanges；需要额外提供
   * `<前缀>Title` / `<前缀>Message` / `<前缀>Cancel` / `<前缀>Confirm` 四个键。
   */
  i18nPrefix?: string
}

/**
 * 弹窗里有未保存修改、用户又要关闭时的确认：拦一次，避免误点遮罩或按 Esc 丢草稿。
 * 与「切换集群」的确认弹窗刻意用了不同的文案（那是在换集群，这里只是关弹窗）。
 */
export function UnsavedChangesConfirmDialog({
  open,
  onCancel,
  onConfirm,
  i18nPrefix = 'dialog.unsavedChanges',
}: UnsavedChangesConfirmDialogProps) {
  const { t } = useTranslation()

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onCancel()
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-destructive/10">
              <IconAlertTriangle className="h-5 w-5 text-destructive" />
            </div>
            <DialogTitle className="text-left">
              {t(`${i18nPrefix}Title`)}
            </DialogTitle>
          </div>
        </DialogHeader>

        <DialogDescription className="text-left">
          <Trans
            i18nKey={`${i18nPrefix}Message`}
            components={{
              br: <br />,
              bold: <strong />,
              red: <span className="text-destructive" />,
            }}
          />
        </DialogDescription>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {t(`${i18nPrefix}Cancel`)}
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            {t(`${i18nPrefix}Confirm`)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
