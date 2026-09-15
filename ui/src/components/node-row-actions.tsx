import { useState } from 'react'
import {
  IconBan,
  IconCircleCheckFilled,
  IconDots,
  IconDownload,
  IconDroplet,
  IconPencil,
  IconTrash,
} from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import * as yaml from 'js-yaml'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { NodeWithMetrics } from '@/types/api'
import { cordonNode, deleteResource, uncordonNode } from '@/lib/api'
import { useCan } from '@/hooks/use-can'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { DeleteConfirmationDialog } from '@/components/delete-confirmation-dialog'
import { NodeEditDialog } from '@/components/node-edit-dialog'

function downloadNodeYaml(node: NodeWithMetrics) {
  const content = yaml.dump(node, { indent: 2, noRefs: true })
  const blob = new Blob([content], { type: 'application/x-yaml' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${node.metadata?.name || 'node'}.yaml`
  link.click()
  URL.revokeObjectURL(url)
}

export function NodeRowActions({
  node,
  onDrain,
}: {
  node: NodeWithMetrics
  onDrain: (node: NodeWithMetrics) => void
}) {
  const { t } = useTranslation()
  const can = useCan()
  const queryClient = useQueryClient()
  const [showEdit, setShowEdit] = useState(false)
  const [showDelete, setShowDelete] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  const name = node.metadata?.name || ''
  const canRead = can('nodes', 'get')
  const canUpdate = can('nodes', 'update')
  const canDelete = can('nodes', 'delete')

  if (!canRead && !canUpdate && !canDelete) {
    return null
  }

  const isUnschedulable = node.spec?.unschedulable

  const handleToggleCordon = async () => {
    try {
      if (isUnschedulable) {
        await uncordonNode(name)
        toast.success(t('detail.status.nodeUncordoned', { name }))
      } else {
        await cordonNode(name)
        toast.success(t('detail.status.nodeCordoned', { name }))
      }
      await queryClient.invalidateQueries({ queryKey: ['nodes'] })
    } catch (err) {
      // 操作失败已由 API 客户端统一写入站内信，不再弹窗
    }
  }

  const handleDelete = async () => {
    setIsDeleting(true)
    try {
      await deleteResource('nodes', name, undefined)
      toast.success(t('resourceTable.deleteSuccess', { name }))
      setShowDelete(false)
      await queryClient.invalidateQueries({ queryKey: ['nodes'] })
    } catch (err) {
      // 操作失败已由 API 客户端统一写入站内信，不再弹窗
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8">
            <IconDots className="size-4" />
            <span className="sr-only">
              {t('common.fields.actions', 'Actions')}
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canUpdate && (
            <DropdownMenuItem onSelect={() => void handleToggleCordon()}>
              {isUnschedulable ? (
                <IconCircleCheckFilled className="size-4" />
              ) : (
                <IconBan className="size-4" />
              )}
              {isUnschedulable
                ? t('common.actions.uncordon', 'Uncordon')
                : t('common.actions.cordon', 'Cordon')}
            </DropdownMenuItem>
          )}
          {canUpdate && (
            <DropdownMenuItem onSelect={() => onDrain(node)}>
              <IconDroplet className="size-4" />
              {t('common.actions.drain', 'Drain')}
            </DropdownMenuItem>
          )}
          {canUpdate && (
            <DropdownMenuItem onSelect={() => setShowEdit(true)}>
              <IconPencil className="size-4" />
              {t('common.actions.edit', 'Edit')}
            </DropdownMenuItem>
          )}
          {canRead && (
            <DropdownMenuItem onSelect={() => downloadNodeYaml(node)}>
              <IconDownload className="size-4" />
              {t('common.actions.downloadYaml', 'Download YAML')}
            </DropdownMenuItem>
          )}
          {canDelete && (
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => setShowDelete(true)}
            >
              <IconTrash className="size-4" />
              {t('common.actions.delete', 'Delete')}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <NodeEditDialog node={node} open={showEdit} onOpenChange={setShowEdit} />

      <DeleteConfirmationDialog
        open={showDelete}
        onOpenChange={setShowDelete}
        resourceName={name}
        resourceType={t('common.fields.node', 'Node')}
        onConfirm={() => void handleDelete()}
        isDeleting={isDeleting}
      />
    </>
  )
}
