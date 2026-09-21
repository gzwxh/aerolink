import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

import { ResourceType } from '@/types/api'
import { deleteResource } from '@/lib/api'
import {
  getResourceListPath,
  getResourceSingularLabel,
} from '@/lib/resource-metadata'

import { DeleteConfirmationDialog } from './delete-confirmation-dialog'

interface ResourceDeleteConfirmationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  resourceName: string
  resourceType: ResourceType
  namespace?: string
  additionalNote?: string
}

export function ResourceDeleteConfirmationDialog({
  open,
  onOpenChange,
  resourceName,
  resourceType,
  namespace,
  additionalNote,
}: ResourceDeleteConfirmationDialogProps) {
  const [isDeleting, setIsDeleting] = useState(false)
  const navigate = useNavigate()

  const handleDelete = async (force?: boolean, wait?: boolean) => {
    setIsDeleting(true)
    try {
      await deleteResource(resourceType, resourceName, namespace, {
        force,
        wait,
      })
      toast.success(
        `${getResourceSingularLabel(resourceType) || resourceType} deleted successfully`
      )
      navigate(getResourceListPath(resourceType))
    } catch (error) {
      // 资源可能已经不存在（被并发删除或强制删除）：
      // 不要把用户留在损坏的详情页上。
      const message = String(
        (error as { response?: { data?: { error?: string } } })?.response?.data
          ?.error ?? error
      ).toLowerCase()
      if (message.includes('not found') || message.includes('404')) {
        navigate(getResourceListPath(resourceType))
      } else {
        toast.error(error instanceof Error ? error.message : String(error))
      }
    } finally {
      setIsDeleting(false)
      onOpenChange(false)
    }
  }

  return (
    <DeleteConfirmationDialog
      open={open}
      onOpenChange={onOpenChange}
      resourceName={resourceName}
      // 用可读的 singular 标签（Helm Release 而不是 helmrelease）。
      resourceType={getResourceSingularLabel(resourceType) || resourceType}
      onConfirm={handleDelete}
      isDeleting={isDeleting}
      namespace={namespace}
      additionalNote={additionalNote}
      showAdditionalOptions={true}
    />
  )
}
