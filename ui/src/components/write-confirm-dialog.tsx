import { useCallback, useEffect, useState } from 'react'
import { IconAlertTriangle, IconShieldCheck } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import {
  currentWriteConfirmRequest,
  resolveWriteConfirm,
  WRITE_CONFIRM_EVENT,
  type WriteConfirmPrompt,
  type WriteOperationKind,
  type WriteTarget,
} from '@/lib/write-confirm'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/** 操作类别 → i18n key。 */
const KIND_LABEL_KEY: Record<WriteOperationKind, string> = {
  create: 'writeConfirm.kinds.create',
  update: 'writeConfirm.kinds.update',
  delete: 'writeConfirm.kinds.delete',
  restart: 'writeConfirm.kinds.restart',
  nodeMaintenance: 'writeConfirm.kinds.nodeMaintenance',
}

/**
 * k8s 写操作的二次确认弹窗。
 *
 * API 客户端在提交写请求前会 await 这里的结论（见 lib/write-confirm.ts）：
 * 确认 → 请求照常发出；取消或直接关掉弹窗 → 请求根本不发出去。
 */
export function WriteConfirmDialog() {
  const { t } = useTranslation()
  const [prompt, setPrompt] = useState<WriteConfirmPrompt | null>(null)

  useEffect(() => {
    const handleRequest = () => setPrompt(currentWriteConfirmRequest())
    window.addEventListener(WRITE_CONFIRM_EVENT, handleRequest)
    return () => window.removeEventListener(WRITE_CONFIRM_EVENT, handleRequest)
  }, [])

  const finish = useCallback((confirmed: boolean) => {
    setPrompt(null)
    resolveWriteConfirm(confirmed)
  }, [])

  const request = prompt?.request ?? null
  const count = prompt?.count ?? 1
  const destructive = request?.kind === 'delete'

  return (
    <Dialog
      open={prompt !== null}
      onOpenChange={(next) => {
        if (!next) {
          finish(false)
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {destructive ? (
              <IconAlertTriangle className="text-destructive size-4" />
            ) : (
              <IconShieldCheck className="text-warning size-4" />
            )}
            {t('writeConfirm.title', '确认执行该操作？')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'writeConfirm.description',
              '该集群已开启操作二次确认，确认后才会把这次变更提交给 Kubernetes。'
            )}
          </DialogDescription>
        </DialogHeader>

        {request ? (
          <dl className="space-y-2 text-sm">
            <ConfirmRow
              label={t('writeConfirm.fields.cluster', '集群')}
              value={request.cluster}
            />
            <ConfirmRow
              label={t('writeConfirm.fields.operation', '操作')}
              value={t(KIND_LABEL_KEY[request.kind], request.kind)}
            />
            <ConfirmRow
              label={t('writeConfirm.fields.target', '对象')}
              value={describeTarget(request.target)}
            />
          </dl>
        ) : null}

        {count > 1 ? (
          <p className="text-muted-foreground text-xs">
            {t('writeConfirm.bulkHint', '本次将同时提交 {{count}} 个同类操作', {
              count,
            })}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => finish(false)}>
            {t('common.actions.cancel', '取消')}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            onClick={() => finish(true)}
          >
            {t('writeConfirm.confirm', '确认执行')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ConfirmRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="text-muted-foreground shrink-0">{label}</dt>
      <dd className="min-w-0 flex-1 truncate font-medium" title={value}>
        {value}
      </dd>
    </div>
  )
}

/** `deployments/nginx · default`：kubectl 式的简写，比拼长句更好读。 */
function describeTarget(target: WriteTarget): string {
  const resource = target.name
    ? `${target.resource}/${target.name}`
    : target.resource
  return target.namespace ? `${resource} · ${target.namespace}` : resource
}
