import { useCallback, useEffect, useState } from 'react'
import { DialogDescription } from '@radix-ui/react-dialog'
import { Container } from 'kubernetes-types/core/v1'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router-dom'

import {
  useDraftDirty,
  useUnsavedChangesGuard,
} from '@/hooks/use-unsaved-changes-guard'

import { EnvironmentEditor, ImageEditor, ResourceEditor } from './editors'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs'
import { UnsavedChangesConfirmDialog } from './unsaved-changes-confirm-dialog'

interface ContainerEditDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  container: Container
  onSave: (updatedContainer: Container) => void
}

function cloneContainer(container: Container) {
  return JSON.parse(JSON.stringify(container)) as Container
}

export function ContainerEditDialog({
  open,
  onOpenChange,
  container,
  onSave,
}: ContainerEditDialogProps) {
  // 草稿在条件挂载的内容组件里，关闭即丢弃，所以「有没有改动」上报到这一层，
  // 由 useUnsavedChangesGuard 拦截遮罩点击 / Esc / 右上角 X。
  const [isDraftDirty, setIsDraftDirty] = useState(false)
  const close = useCallback(() => onOpenChange(false), [onOpenChange])
  const guard = useUnsavedChangesGuard({ dirty: isDraftDirty, onClose: close })

  return (
    <>
      <Dialog open={open} onOpenChange={guard.handleOpenChange}>
        {open ? (
          <ContainerEditDialogContent
            container={container}
            onSave={onSave}
            onDraftChange={setIsDraftDirty}
            onRequestClose={() => guard.handleOpenChange(false)}
            onClose={close}
          />
        ) : null}
      </Dialog>

      <UnsavedChangesConfirmDialog {...guard.confirmDialogProps} />
    </>
  )
}

function ContainerEditDialogContent({
  container,
  onSave,
  onDraftChange,
  onRequestClose,
  onClose,
}: Omit<ContainerEditDialogProps, 'open' | 'onOpenChange'> & {
  /** 上报是否有草稿，父级据此决定关闭时是否先弹确认。 */
  onDraftChange: (hasDraft: boolean) => void
  /** 需要用户确认的关闭请求（取消按钮）。 */
  onRequestClose: () => void
  /** 直接关闭（保存完成，或已确认丢弃草稿）。 */
  onClose: () => void
}) {
  const { t } = useTranslation()
  const { namespace } = useParams()
  const [editedContainer, setEditedContainer] = useState<Container>(() =>
    cloneContainer(container)
  )
  // 首帧克隆出的容器作为基线；容器只在打开时挂载，不需要额外的重载逻辑。
  const isDirty = useDraftDirty(editedContainer)
  useEffect(() => {
    onDraftChange(isDirty)
  }, [isDirty, onDraftChange])

  const handleSave = () => {
    onSave(editedContainer)
    onClose()
  }

  const handleUpdate = (updates: Partial<Container>) => {
    setEditedContainer((prev) => ({ ...prev, ...updates }))
  }

  return (
    <DialogContent className="!max-w-4xl max-h-[90vh] overflow-y-auto sm:!max-w-4xl">
      <DialogHeader>
        <DialogTitle>
          {t('containerEdit.title', {
            name: editedContainer.name,
            defaultValue: 'Edit Container: {{name}}',
          })}
        </DialogTitle>
        <DialogDescription className="text-sm text-muted-foreground">
          {t(
            'containerEdit.description',
            'More complex changes can be made by modifying in YAML.'
          )}
        </DialogDescription>
      </DialogHeader>

      <Tabs defaultValue="image" className="w-full">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="image">
            {t('containerEdit.tabImage', 'Image')}
          </TabsTrigger>
          <TabsTrigger value="resources">
            {t('containerEdit.tabResources', 'Resources')}
          </TabsTrigger>
          <TabsTrigger value="environment">
            {t('containerEdit.tabEnvironment', 'Environment')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="image" className="space-y-4">
          <ImageEditor container={editedContainer} onUpdate={handleUpdate} />
        </TabsContent>

        <TabsContent value="resources" className="space-y-6">
          <ResourceEditor container={editedContainer} onUpdate={handleUpdate} />
        </TabsContent>

        <TabsContent value="environment" className="space-y-4">
          <EnvironmentEditor
            container={editedContainer}
            onUpdate={handleUpdate}
            namespace={namespace!}
          />
        </TabsContent>
      </Tabs>

      <DialogFooter>
        <Button variant="outline" onClick={onRequestClose}>
          {t('common.actions.cancel', 'Cancel')}
        </Button>
        <Button onClick={handleSave}>{t('common.actions.save', 'Save')}</Button>
      </DialogFooter>
    </DialogContent>
  )
}
