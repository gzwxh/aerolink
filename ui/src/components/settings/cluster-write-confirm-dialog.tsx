import { useEffect, useState } from 'react'
import { IconShieldCheck } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import type { Cluster } from '@/types/api'
import type { ClusterUpdateRequest } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

/** 五类写操作与后端字段的对应；数组顺序就是弹窗里的展示顺序。 */
const CONFIRM_ITEMS = [
  { field: 'confirmCreate', kind: 'create' },
  { field: 'confirmUpdate', kind: 'update' },
  { field: 'confirmDelete', kind: 'delete' },
  { field: 'confirmRestart', kind: 'restart' },
  { field: 'confirmNodeMaintenance', kind: 'nodeMaintenance' },
] as const

type ConfirmField = (typeof CONFIRM_ITEMS)[number]['field']
type ConfirmForm = Record<ConfirmField, boolean>

const EMPTY_FORM: ConfirmForm = {
  confirmCreate: false,
  confirmUpdate: false,
  confirmDelete: false,
  confirmRestart: false,
  confirmNodeMaintenance: false,
}

export interface ClusterWriteConfirmDialogProps {
  open: boolean
  cluster: Cluster | null
  isPending?: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (id: number, data: ClusterUpdateRequest) => void
}

/**
 * 集群的「写操作二次确认」设置。
 *
 * 开关只影响当前集群、默认全关；判定发生在请求提交前，由前端完成
 * （见 lib/write-confirm.ts），服务端不参与拦截——它防的是误触，不是绕过。
 */
export function ClusterWriteConfirmDialog({
  open,
  cluster,
  isPending,
  onOpenChange,
  onSubmit,
}: ClusterWriteConfirmDialogProps) {
  const { t } = useTranslation()
  const [form, setForm] = useState<ConfirmForm>(EMPTY_FORM)

  // 每次打开都按该集群的当前值回填，避免上一个集群的开关串味。
  useEffect(() => {
    if (!open || !cluster) {
      return
    }
    setForm({
      confirmCreate: cluster.confirmCreate === true,
      confirmUpdate: cluster.confirmUpdate === true,
      confirmDelete: cluster.confirmDelete === true,
      confirmRestart: cluster.confirmRestart === true,
      confirmNodeMaintenance: cluster.confirmNodeMaintenance === true,
    })
  }, [open, cluster])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IconShieldCheck className="size-4" />
            {t('clusterManagement.writeConfirm.title', '操作二次确认')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'clusterManagement.writeConfirm.description',
              '开启后，这一类操作在提交给 Kubernetes 之前会先弹出确认框。设置只作用于当前集群。'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {CONFIRM_ITEMS.map((item) => (
            <div
              key={item.field}
              className="flex items-start justify-between gap-4"
            >
              <div className="space-y-1">
                <Label
                  htmlFor={`confirm-${item.field}`}
                  className="cursor-pointer"
                >
                  {t(`writeConfirm.kinds.${item.kind}`, item.kind)}
                </Label>
                <p className="text-muted-foreground text-xs">
                  {t(`clusterManagement.writeConfirm.hints.${item.kind}`, '')}
                </p>
              </div>
              <Switch
                id={`confirm-${item.field}`}
                checked={form[item.field]}
                onCheckedChange={(checked) =>
                  setForm((prev) => ({ ...prev, [item.field]: checked }))
                }
              />
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.actions.cancel', '取消')}
          </Button>
          <Button
            disabled={!cluster || isPending}
            onClick={() => cluster && onSubmit(cluster.id, form)}
          >
            {t('common.actions.save', '保存')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
