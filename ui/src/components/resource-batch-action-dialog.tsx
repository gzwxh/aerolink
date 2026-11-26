import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { translateError } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface BatchResource {
  metadata?: {
    name?: string
    namespace?: string
  }
}

interface ResourceBatchActionDialogProps<T extends BatchResource> {
  open: boolean
  onOpenChange: (open: boolean) => void
  resources: T[]
  title: string
  description: string
  actionLabel: string
  onExecute: (resource: T) => Promise<unknown>
  onComplete?: () => void | Promise<void>
  sequential?: boolean
  destructive?: boolean
  /**
   * 调用方判定「现在还不该能提交」（例如批量删除要求先逐字输入对象个数）。
   * 与 DeleteConfirmationDialog 的同意图参数同名，让两个确认弹窗保持一套口径。
   */
  confirmDisabled?: boolean
  options?: (disabled: boolean) => React.ReactNode
}

interface BatchFailure {
  resource: string
  error: string
}

export function ResourceBatchActionDialog<T extends BatchResource>({
  open,
  onOpenChange,
  resources,
  title,
  description,
  actionLabel,
  onExecute,
  onComplete,
  sequential = false,
  destructive = false,
  confirmDisabled,
  options,
}: ResourceBatchActionDialogProps<T>) {
  const { t } = useTranslation()
  const [isRunning, setIsRunning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [failures, setFailures] = useState<BatchFailure[]>([])
  // 执行期间用一份名单快照：调用方的 onComplete 通常会清掉勾选并重拉数据，
  // 那时 `resources` 会变成空数组，失败面板就会把计数写成「Done -1/0」。
  const [snapshot, setSnapshot] = useState<T[]>([])
  const shownResources = isRunning || failures.length > 0 ? snapshot : resources

  const reset = () => {
    setProgress({ done: 0, total: 0 })
    setFailures([])
    setSnapshot([])
  }

  const handleOpenChange = (nextOpen: boolean) => {
    if (isRunning) return
    if (!nextOpen) reset()
    onOpenChange(nextOpen)
  }

  const handleExecute = async () => {
    setIsRunning(true)
    setFailures([])
    setSnapshot(resources)
    setProgress({ done: 0, total: resources.length })

    const nextFailures: BatchFailure[] = []
    let succeeded = 0

    const executeResource = async (resource: T) => {
      const name = resource.metadata!.name!
      const displayName = resource.metadata?.namespace
        ? `${resource.metadata.namespace}/${name}`
        : name

      try {
        await onExecute(resource)
        succeeded += 1
      } catch (error) {
        nextFailures.push({
          resource: displayName,
          error: translateError(error, t),
        })
      } finally {
        setProgress((current) => ({
          ...current,
          done: current.done + 1,
        }))
      }
    }

    if (sequential) {
      for (const resource of resources) {
        await executeResource(resource)
      }
    } else {
      await Promise.all(resources.map(executeResource))
    }

    await onComplete?.()
    setIsRunning(false)

    if (nextFailures.length === 0) {
      toast.success(
        t('resourceTable.batchActionSuccess', {
          action: actionLabel,
          count: succeeded,
        })
      )
      reset()
      onOpenChange(false)
      return
    }

    setFailures(nextFailures)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        role={destructive ? 'alertdialog' : 'dialog'}
        showCloseButton={!isRunning}
      >
        <DialogHeader>
          <DialogTitle className="text-balance">{title}</DialogTitle>
          <DialogDescription className="text-pretty">
            {description}
          </DialogDescription>
        </DialogHeader>

        {/* 列出将要操作的资源名：只写「1 个 Deployments」看不出动的是哪一个，
            名字是最关键的信息，操作前后都便于核对。 */}
        {shownResources.length > 0 ? (
          <div className="space-y-1">
            <p className="text-muted-foreground text-xs font-medium">
              {t('resourceTable.batchActions.resourcesLabel', '将要操作的资源')}
            </p>
            <ul className="bg-muted/40 max-h-40 space-y-1 overflow-y-auto rounded-md border px-3 py-2 font-mono text-xs">
              {shownResources.map((resource) => {
                const name = resource.metadata?.name ?? ''
                const namespace = resource.metadata?.namespace
                const label = namespace ? `${namespace}/${name}` : name
                return (
                  <li key={label} className="truncate" title={label}>
                    {label}
                  </li>
                )
              })}
            </ul>
          </div>
        ) : null}

        {options?.(isRunning)}

        {failures.length > 0 && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/5 p-3"
          >
            <p className="text-pretty text-sm">
              {t('resourceTable.batchActionPartialResult', {
                succeeded: shownResources.length - failures.length,
                total: shownResources.length,
              })}
            </p>
            <p className="mt-2 text-sm font-medium text-destructive">
              {t('resourceTable.failedResources', {
                count: failures.length,
              })}
            </p>
            <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-sm">
              {failures.map((failure) => (
                <li key={failure.resource} className="text-pretty">
                  <span className="font-medium">{failure.resource}:</span>{' '}
                  {failure.error}
                </li>
              ))}
            </ul>
          </div>
        )}

        <DialogFooter>
          {failures.length > 0 ? (
            <Button variant="outline" onClick={() => handleOpenChange(false)}>
              {t('common.actions.close')}
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => handleOpenChange(false)}
                disabled={isRunning}
              >
                {t('common.actions.cancel')}
              </Button>
              <Button
                variant={destructive ? 'destructive' : 'default'}
                onClick={handleExecute}
                disabled={isRunning || confirmDisabled}
                className="tabular-nums"
              >
                {isRunning
                  ? t('resourceTable.processingProgress', progress)
                  : actionLabel}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
