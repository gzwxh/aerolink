import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { NodeWithMetrics } from '@/types/api'
import { drainNode } from '@/lib/api'
import { translateError } from '@/lib/utils'
import {
  useDraftDirty,
  useUnsavedChangesGuard,
} from '@/hooks/use-unsaved-changes-guard'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { UnsavedChangesConfirmDialog } from '@/components/unsaved-changes-confirm-dialog'

interface RadioOptionProps {
  name: string
  checked: boolean
  onSelect: () => void
  children: React.ReactNode
}

function RadioOption({ name, checked, onSelect, children }: RadioOptionProps) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onSelect}
        className="accent-primary size-4"
      />
      {children}
    </label>
  )
}

interface NodeDrainDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  nodes: NodeWithMetrics[]
  onDrained: () => void | Promise<void>
}

// 每次打开都会重置到这份默认选项，所以它就是「未改动」的基线。
const defaultDrainOptions = {
  deleteLocalData: false,
  force: false,
  graceMode: 'default',
  gracePeriod: 30,
  timeoutMode: 'continue',
  timeout: 60,
}

export function NodeDrainDialog({
  open,
  onOpenChange,
  nodes,
  onDrained,
}: NodeDrainDialogProps) {
  const { t } = useTranslation()
  const [deleteLocalData, setDeleteLocalData] = useState(false)
  const [force, setForce] = useState(false)
  const [graceMode, setGraceMode] = useState<'default' | 'custom'>('default')
  const [gracePeriod, setGracePeriod] = useState(30)
  const [timeoutMode, setTimeoutMode] = useState<'continue' | 'abort'>(
    'continue'
  )
  const [timeout, setTimeout] = useState(60)
  const [isRunning, setIsRunning] = useState(false)

  // 选项每次打开都会重置成默认值，默认值即基线；有改动时由 guard 拦下
  // 遮罩 / Esc / X 的关闭，isRunning 期间仍维持原有的不可关闭。
  const isDirty = useDraftDirty(
    { deleteLocalData, force, graceMode, gracePeriod, timeoutMode, timeout },
    defaultDrainOptions
  )
  const close = useCallback(() => onOpenChange(false), [onOpenChange])
  const guard = useUnsavedChangesGuard({ dirty: isDirty, onClose: close })

  useEffect(() => {
    if (!open) return
    setDeleteLocalData(false)
    setForce(false)
    setGraceMode('default')
    setGracePeriod(30)
    setTimeoutMode('continue')
    setTimeout(60)
  }, [open])

  const handleDrain = async () => {
    setIsRunning(true)
    const errors: string[] = []
    let drained = 0
    for (const node of nodes) {
      const name = node.metadata?.name || ''
      try {
        await drainNode(name, {
          force,
          gracePeriod: graceMode === 'custom' ? gracePeriod : -1,
          deleteLocalData,
          ignoreDaemonsets: true,
          timeout: timeoutMode === 'abort' ? timeout : 0,
        })
        drained += 1
      } catch (err) {
        errors.push(`${name}: ${translateError(err, t)}`)
      }
    }
    await onDrained()
    setIsRunning(false)
    if (errors.length === 0) {
      toast.success(
        t('nodeDrain.success', {
          count: drained,
          defaultValue: '{{count}} node(s) drained',
        })
      )
      close()
    } else {
      toast.error(errors.join('; '))
    }
  }

  const title =
    nodes.length === 1
      ? t('nodeDrain.title', {
          name: nodes[0]?.metadata?.name,
          defaultValue: 'Drain {{name}}',
        })
      : t('nodeDrain.titleMany', {
          count: nodes.length,
          defaultValue: 'Drain {{count}} nodes',
        })

  const yesNo = (
    group: string,
    value: boolean,
    onChange: (v: boolean) => void
  ) => (
    <div className="flex items-center gap-4">
      <RadioOption name={group} checked={value} onSelect={() => onChange(true)}>
        {t('nodeDrain.yes', 'Yes')}
      </RadioOption>
      <RadioOption
        name={group}
        checked={!value}
        onSelect={() => onChange(false)}
      >
        {t('nodeDrain.no', 'No')}
      </RadioOption>
    </div>
  )

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={isRunning ? undefined : guard.handleOpenChange}
      >
        <DialogContent className="sm:max-w-lg" showCloseButton={!isRunning}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <div className="text-sm font-medium">
                {t('nodeDrain.deleteEmptyDir', 'Delete emptyDir data')}
              </div>
              {yesNo('empty-dir', deleteLocalData, setDeleteLocalData)}
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium">
                {t('nodeDrain.force', 'Force')}
              </div>
              {yesNo('force', force, setForce)}
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium">
                {t(
                  'nodeDrain.gracePeriodTitle',
                  'Pod termination grace period'
                )}
              </div>
              <RadioOption
                name="grace-period"
                checked={graceMode === 'default'}
                onSelect={() => setGraceMode('default')}
              >
                {t(
                  'nodeDrain.gracePeriodDefault',
                  "Use each Pod's own default"
                )}
              </RadioOption>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <RadioOption
                  name="grace-period"
                  checked={graceMode === 'custom'}
                  onSelect={() => setGraceMode('custom')}
                >
                  {t(
                    'nodeDrain.gracePeriodCustom',
                    'Ignore the default; each Pod gets'
                  )}
                </RadioOption>
                <Input
                  type="number"
                  min={0}
                  value={gracePeriod}
                  disabled={graceMode !== 'custom'}
                  onChange={(e) => setGracePeriod(Number(e.target.value) || 0)}
                  className="h-8 w-24"
                />
                <span className="text-muted-foreground">
                  {t('nodeDrain.seconds', 'seconds')}
                </span>
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium">
                {t('nodeDrain.timeoutTitle', 'Drain timeout')}
              </div>
              <RadioOption
                name="drain-timeout"
                checked={timeoutMode === 'continue'}
                onSelect={() => setTimeoutMode('continue')}
              >
                {t(
                  'nodeDrain.timeoutContinue',
                  'Keep trying after the timeout'
                )}
              </RadioOption>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <RadioOption
                  name="drain-timeout"
                  checked={timeoutMode === 'abort'}
                  onSelect={() => setTimeoutMode('abort')}
                >
                  {t('nodeDrain.timeoutAbort', 'Abort the drain after')}
                </RadioOption>
                <Input
                  type="number"
                  min={1}
                  value={timeout}
                  disabled={timeoutMode !== 'abort'}
                  onChange={(e) => setTimeout(Number(e.target.value) || 0)}
                  className="h-8 w-24"
                />
                <span className="text-muted-foreground">
                  {t('nodeDrain.seconds', 'seconds')}
                </span>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => guard.handleOpenChange(false)}
              disabled={isRunning}
            >
              {t('common.actions.cancel', 'Cancel')}
            </Button>
            <Button
              onClick={() => void handleDrain()}
              disabled={isRunning || nodes.length === 0}
            >
              {isRunning
                ? t('common.messages.loading', 'Loading...')
                : t('nodeDrain.action', 'Drain')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <UnsavedChangesConfirmDialog {...guard.confirmDialogProps} />
    </>
  )
}
