import { AlertTriangle } from 'lucide-react'
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

interface ClusterSwitchConfirmDialogProps {
  open: boolean
  isSwitching: boolean
  onCancel: () => void
  onConfirm: () => void
}

/**
 * 创建表单 / YAML 编辑里有未保存草稿时的切换确认：「丢弃」标红，
 * 让用户先看清这次切换的代价（见 ClusterProvider）。
 */
export function ClusterSwitchConfirmDialog({
  open,
  isSwitching,
  onCancel,
  onConfirm,
}: ClusterSwitchConfirmDialogProps) {
  const { t } = useTranslation()

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !isSwitching) {
          onCancel()
        }
      }}
    >
      <DialogContent className="max-w-md" showCloseButton={!isSwitching}>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-destructive/10">
              <AlertTriangle className="h-5 w-5 text-destructive" />
            </div>
            <DialogTitle className="text-left">
              {t('cluster.unsavedSwitchConfirmTitle', '切换集群？')}
            </DialogTitle>
          </div>
        </DialogHeader>

        <DialogDescription className="text-left">
          <Trans
            i18nKey="cluster.unsavedSwitchConfirm"
            components={{
              br: <br />,
              bold: <strong />,
              red: <span className="text-destructive" />,
            }}
          />
        </DialogDescription>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={isSwitching}>
            {t('common.actions.cancel', '取消')}
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={isSwitching}
          >
            {isSwitching
              ? t('cluster.switching', '切换集群中...')
              : t('cluster.unsavedSwitchConfirmAction', '切换集群')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
