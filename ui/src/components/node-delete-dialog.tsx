import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { NodeWithMetrics } from '@/types/api'
import { deleteResource } from '@/lib/api'
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
import { Input } from '@/components/ui/input'

interface NodeDeleteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  nodes: NodeWithMetrics[]
  onDeleted: () => void | Promise<void>
}

// NodeDeleteDialog deletes one or more nodes. A single node requires typing its
// name, mirroring the confirmation used elsewhere in the console.
export function NodeDeleteDialog({
  open,
  onOpenChange,
  nodes,
  onDeleted,
}: NodeDeleteDialogProps) {
  const { t } = useTranslation()
  const [typed, setTyped] = useState('')
  const [isDeleting, setIsDeleting] = useState(false)

  useEffect(() => {
    if (open) setTyped('')
  }, [open])

  const single = nodes.length === 1
  const targetName = nodes[0]?.metadata?.name || ''
  const canConfirm = single ? typed === targetName : nodes.length > 0

  const handleDelete = async () => {
    setIsDeleting(true)
    const errors: string[] = []
    let deleted = 0
    for (const node of nodes) {
      const name = node.metadata?.name || ''
      try {
        await deleteResource('nodes', name, undefined)
        deleted += 1
      } catch (err) {
        errors.push(`${name}: ${translateError(err, t)}`)
      }
    }
    await onDeleted()
    setIsDeleting(false)
    if (errors.length === 0) {
      toast.success(
        t('nodeDelete.success', {
          count: deleted,
          defaultValue: '{{count}} node(s) deleted',
        })
      )
      onOpenChange(false)
    } else {
      toast.error(errors.join('; '))
    }
  }

  return (
    <Dialog open={open} onOpenChange={isDeleting ? undefined : onOpenChange}>
      <DialogContent role="alertdialog" showCloseButton={!isDeleting}>
        <DialogHeader>
          <DialogTitle>{t('nodeDelete.title', 'Confirm?')}</DialogTitle>
          <DialogDescription>
            {single
              ? t('nodeDelete.message', {
                  name: targetName,
                  defaultValue: 'You are about to delete node {{name}}.',
                })
              : t('nodeDelete.messageMany', {
                  count: nodes.length,
                  defaultValue: 'You are about to delete {{count}} nodes.',
                })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {single ? (
            <>
              <p className="text-sm">
                {t('nodeDelete.typeToConfirm', {
                  name: targetName,
                  defaultValue: 'Enter {{name}} below to confirm:',
                })}
              </p>
              <Input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={targetName}
                autoComplete="off"
              />
            </>
          ) : (
            <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2 text-sm">
              {nodes.map((node) => (
                <li key={node.metadata?.name}>{node.metadata?.name}</li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isDeleting}
          >
            {t('common.actions.cancel', 'Cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => void handleDelete()}
            disabled={!canConfirm || isDeleting}
          >
            {t('nodeDelete.action', 'Delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
