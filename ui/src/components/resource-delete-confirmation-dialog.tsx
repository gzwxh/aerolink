import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ResourceType } from '@/types/api'
import { deleteResource } from '@/lib/api'
import { useClusterNavigate } from '@/lib/cluster-path'
import { deleteRelatedServices } from '@/lib/related-service-cleanup'
import {
  getResourceListPath,
  getResourceSingularLabel,
} from '@/lib/resource-metadata'

import { DeleteConfirmationDialog } from './delete-confirmation-dialog'
import { RelatedServicesDeleteWarning } from './related-services-delete-warning'

interface ResourceDeleteConfirmationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  resourceName: string
  resourceType: ResourceType
  namespace?: string
  additionalNote?: string
  /**
   * 与该资源关联、将随本次删除一并删除的 Service 名单（调用方算好并做权限过滤）。
   * 非空时弹窗里展示联动提醒，确认后会先删资源再删这些 Service。
   */
  relatedServices?: string[]
}

export function ResourceDeleteConfirmationDialog({
  open,
  onOpenChange,
  resourceName,
  resourceType,
  namespace,
  additionalNote,
  relatedServices,
}: ResourceDeleteConfirmationDialogProps) {
  const [isDeleting, setIsDeleting] = useState(false)
  const navigate = useClusterNavigate()
  const { t } = useTranslation()

  const handleDelete = async (force?: boolean, wait?: boolean) => {
    setIsDeleting(true)
    try {
      await deleteResource(resourceType, resourceName, namespace, {
        force,
        wait,
      })
      // 主体资源已删除后再联动清理关联 Service，主体失败时不动它们。
      const failedServices =
        relatedServices && relatedServices.length
          ? await deleteRelatedServices(relatedServices, namespace)
          : []
      toast.success(
        // 这里原先拼的是模板串 `${label} deleted successfully`，
        // 于是同一个删除动作：列表页弹「已删除 xx」、详情页弹英文（第 13 轮 D-85）。
        t('common.messages.deleted', {
          resource: getResourceSingularLabel(resourceType) || resourceType,
        })
      )
      if (failedServices.length) {
        toast.warning(
          t('deleteConfirmation.relatedServicesDeleteFailed', {
            names: failedServices.join(', '),
          })
        )
      }
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
      extraContent={
        relatedServices?.length ? (
          <RelatedServicesDeleteWarning names={relatedServices} />
        ) : undefined
      }
    />
  )
}
