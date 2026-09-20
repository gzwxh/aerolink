import { useCallback, useMemo, useState } from 'react'
import {
  IconDots,
  IconFileCode,
  IconHistory,
  IconNotes,
  IconPhoto,
  IconPlayerPause,
  IconPlayerPlay,
  IconReload,
  IconTag,
  IconTerminal2,
  IconTrash,
} from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import * as yaml from 'js-yaml'
import type { Deployment } from 'kubernetes-types/apps/v1'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

import {
  deleteResource,
  patchResource,
  restartWorkload,
  updateResource,
} from '@/lib/api'
import { useCan } from '@/hooks/use-can'
import {
  useDraftDirty,
  useUnsavedChangesGuard,
} from '@/hooks/use-unsaved-changes-guard'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DeleteConfirmationDialog } from '@/components/delete-confirmation-dialog'
import { KVEditor, type KVPair } from '@/components/kv-editor'
import { UnsavedChangesConfirmDialog } from '@/components/unsaved-changes-confirm-dialog'
import { WorkloadRevisionsTable } from '@/components/workload-revisions-table'
import { YamlEditor } from '@/components/yaml-editor'

type DialogKind = 'yaml' | 'image' | 'rollback' | 'labels' | 'annotations'

function toPairs(record: Record<string, string> | undefined): KVPair[] {
  return Object.entries(record ?? {}).map(([key, value]) => ({ key, value }))
}

function toRecord(pairs: KVPair[]): Record<string, string> | undefined {
  const record: Record<string, string> = {}
  for (const pair of pairs) {
    const key = pair.key.trim()
    if (key) {
      record[key] = pair.value
    }
  }
  return Object.keys(record).length > 0 ? record : undefined
}

export function DeploymentRowActions({
  deployment,
}: {
  deployment: Deployment
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const can = useCan()

  const name = deployment.metadata?.name ?? ''
  const namespace = deployment.metadata?.namespace ?? ''
  const paused = deployment.spec?.paused === true

  const canRead = can('deployments', 'get', { namespace })
  const canUpdate = can('deployments', 'update', { namespace })
  const canDelete = can('deployments', 'delete', { namespace })
  const canExec = can('pods', 'exec', { namespace })

  const [dialog, setDialog] = useState<DialogKind | null>(null)
  const [showDelete, setShowDelete] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [metadataPairs, setMetadataPairs] = useState<KVPair[]>([])
  const [metadataBaseline, setMetadataBaseline] = useState<KVPair[]>([])
  const [images, setImages] = useState<Array<{ name: string; image: string }>>(
    []
  )
  const [imageBaseline, setImageBaseline] = useState<
    Array<{ name: string; image: string }>
  >([])

  // 这两个草稿弹窗都常驻挂载、打开时才重填，所以基线在打开时随草稿一起重置（见
  // openImageDialog / openMetadataDialog），遮罩 / Esc / 取消都先过 guard 确认。
  const imageDirty = useDraftDirty(images, imageBaseline)
  const closeImageDialog = useCallback(() => setDialog(null), [])
  const imageGuard = useUnsavedChangesGuard({
    dirty: imageDirty,
    onClose: closeImageDialog,
  })

  const metadataDirty = useDraftDirty(metadataPairs, metadataBaseline)
  const closeMetadataDialog = useCallback(() => setDialog(null), [])
  const metadataGuard = useUnsavedChangesGuard({
    dirty: metadataDirty,
    onClose: closeMetadataDialog,
  })

  const containerSpecs = useMemo(
    () => ({
      containers: deployment.spec?.template?.spec?.containers ?? [],
      initContainers: deployment.spec?.template?.spec?.initContainers ?? [],
    }),
    [deployment]
  )

  const yamlContent = useMemo(
    () => (dialog === 'yaml' ? yaml.dump(deployment, { indent: 2 }) : ''),
    [dialog, deployment]
  )

  if (!canRead && !canUpdate && !canDelete && !canExec) {
    return null
  }

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['deployments'] })

  const openMetadataDialog = (kind: 'labels' | 'annotations') => {
    const pairs = toPairs(
      kind === 'labels'
        ? deployment.metadata?.labels
        : deployment.metadata?.annotations
    )
    setMetadataPairs(pairs)
    setMetadataBaseline(pairs)
    setDialog(kind)
  }

  const openImageDialog = () => {
    const nextImages = [
      ...containerSpecs.containers,
      ...containerSpecs.initContainers,
    ].map((container) => ({
      name: container.name ?? '',
      image: container.image ?? '',
    }))
    setImages(nextImages)
    setImageBaseline(nextImages)
    setDialog('image')
  }

  const handleTogglePaused = async () => {
    try {
      await patchResource('deployments', name, namespace, {
        spec: { paused: !paused },
      })
      toast.success(
        paused
          ? t('deploymentActions.resumed', { name })
          : t('deploymentActions.paused', { name })
      )
      await refresh()
    } catch {
      // 操作失败已由 API 客户端统一写入站内信，不再弹窗
    }
  }

  const handleRollingRestart = async () => {
    try {
      await restartWorkload('deployments', name, namespace)
      toast.success(t('deploymentActions.rollingRestarted', { name }))
      await refresh()
    } catch {
      // 操作失败已由 API 客户端统一写入站内信，不再弹窗
    }
  }

  const handleSaveImages = async () => {
    const containerNames = new Set(
      containerSpecs.containers.map((container) => container.name)
    )
    const initContainerNames = new Set(
      containerSpecs.initContainers.map((container) => container.name)
    )
    const changed = images
      .map((entry) => ({ name: entry.name, image: entry.image.trim() }))
      .filter((entry) => {
        if (!entry.image) return false
        const original = [
          ...containerSpecs.containers,
          ...containerSpecs.initContainers,
        ].find((container) => container.name === entry.name)
        return (original?.image ?? '') !== entry.image
      })

    if (changed.length === 0) {
      toast.info(t('deploymentActions.imageUnchanged'))
      setDialog(null)
      return
    }

    const containers = changed.filter((entry) => containerNames.has(entry.name))
    const initContainers = changed.filter((entry) =>
      initContainerNames.has(entry.name)
    )

    setIsSaving(true)
    try {
      await patchResource('deployments', name, namespace, {
        spec: {
          template: {
            spec: {
              ...(containers.length > 0 ? { containers } : {}),
              ...(initContainers.length > 0 ? { initContainers } : {}),
            },
          },
        },
      })
      toast.success(t('deploymentActions.imageUpdated', { name }))
      setDialog(null)
      await refresh()
    } catch {
      // 操作失败已由 API 客户端统一写入站内信，不再弹窗
    } finally {
      setIsSaving(false)
    }
  }

  const handleSaveMetadata = async () => {
    const isAnnotations = dialog === 'annotations'
    const record = toRecord(metadataPairs)
    const metadata = isAnnotations
      ? { ...deployment.metadata, annotations: record }
      : { ...deployment.metadata, labels: record }

    setIsSaving(true)
    try {
      // 整体替换而非 merge patch：删除键时不会留下旧值。
      await updateResource('deployments', name, namespace, {
        ...deployment,
        metadata,
      })
      toast.success(
        t('deploymentActions.metadataSaved', {
          name,
          field: isAnnotations
            ? t('common.fields.annotations')
            : t('common.fields.labels'),
        })
      )
      setDialog(null)
      await refresh()
    } catch {
      // 操作失败已由 API 客户端统一写入站内信，不再弹窗
    } finally {
      setIsSaving(false)
    }
  }

  const handleDelete = async () => {
    setIsDeleting(true)
    try {
      await deleteResource('deployments', name, namespace)
      toast.success(t('resourceTable.deleteSuccess', { name }))
      setShowDelete(false)
      await refresh()
    } catch {
      // 操作失败已由 API 客户端统一写入站内信，不再弹窗
    } finally {
      setIsDeleting(false)
    }
  }

  const isAnnotations = dialog === 'annotations'
  const isMetadataDialog = dialog === 'labels' || isAnnotations

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
        <DropdownMenuContent align="end" className="w-44">
          {canRead && (
            <DropdownMenuItem onSelect={() => setDialog('yaml')}>
              <IconFileCode className="size-4" />
              {t('deploymentActions.viewYaml')}
            </DropdownMenuItem>
          )}
          {canExec && (
            <DropdownMenuItem
              onSelect={() =>
                navigate(
                  `/deployments/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}?tab=terminal`
                )
              }
            >
              <IconTerminal2 className="size-4" />
              {t('common.tabs.terminal')}
            </DropdownMenuItem>
          )}
          {canUpdate && (
            <DropdownMenuItem onSelect={openImageDialog}>
              <IconPhoto className="size-4" />
              {t('deploymentActions.editImage')}
            </DropdownMenuItem>
          )}
          {canUpdate && (
            <DropdownMenuItem onSelect={() => void handleTogglePaused()}>
              {paused ? (
                <IconPlayerPlay className="size-4" />
              ) : (
                <IconPlayerPause className="size-4" />
              )}
              {paused
                ? t('deploymentActions.resume')
                : t('deploymentActions.pause')}
            </DropdownMenuItem>
          )}
          {canUpdate && (
            <DropdownMenuItem onSelect={() => void handleRollingRestart()}>
              <IconReload className="size-4" />
              {t('deploymentActions.rollingRestart')}
            </DropdownMenuItem>
          )}
          {canUpdate && (
            <DropdownMenuItem onSelect={() => setDialog('rollback')}>
              <IconHistory className="size-4" />
              {t('workloads.actions.rollback')}
            </DropdownMenuItem>
          )}
          {canUpdate && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => openMetadataDialog('labels')}>
                <IconTag className="size-4" />
                {t('deploymentActions.manageLabels')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => openMetadataDialog('annotations')}
              >
                <IconNotes className="size-4" />
                {t('deploymentActions.manageAnnotations')}
              </DropdownMenuItem>
            </>
          )}
          {canDelete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setShowDelete(true)}
              >
                <IconTrash className="size-4" />
                {t('common.actions.delete')}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        open={dialog === 'yaml'}
        onOpenChange={(open) => !open && setDialog(null)}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>{t('deploymentActions.viewYaml')}</DialogTitle>
            <DialogDescription>
              {t('deploymentActions.viewYamlDescription', { name })}
            </DialogDescription>
          </DialogHeader>
          {yamlContent && (
            <YamlEditor
              value={yamlContent}
              title={t('common.fields.yamlConfiguration')}
              readOnly
              showControls={false}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={dialog === 'image'}
        onOpenChange={imageGuard.handleOpenChange}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('deploymentActions.editImage')}</DialogTitle>
            <DialogDescription>
              {t('deploymentActions.editImageDescription', { name })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {images.map((entry, index) => (
              <div key={entry.name} className="space-y-1.5">
                <Label className="text-xs" htmlFor={`image-${entry.name}`}>
                  {entry.name}
                </Label>
                <Input
                  id={`image-${entry.name}`}
                  value={entry.image}
                  onChange={(event) =>
                    setImages((prev) =>
                      prev.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...item, image: event.target.value }
                          : item
                      )
                    )
                  }
                />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => imageGuard.handleOpenChange(false)}
            >
              {t('common.actions.cancel')}
            </Button>
            <Button disabled={isSaving} onClick={() => void handleSaveImages()}>
              {isSaving ? t('common.actions.saving') : t('common.actions.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={dialog === 'rollback'}
        onOpenChange={(open) => !open && setDialog(null)}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {t('deploymentActions.rollbackTitle', { name })}
            </DialogTitle>
            <DialogDescription>
              {t('deploymentActions.rollbackDescription')}
            </DialogDescription>
          </DialogHeader>
          <WorkloadRevisionsTable
            resourceType="deployments"
            namespace={namespace}
            name={name}
            onRollbackComplete={async () => {
              await refresh()
            }}
          />
        </DialogContent>
      </Dialog>

      <Dialog
        open={isMetadataDialog}
        onOpenChange={metadataGuard.handleOpenChange}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {isAnnotations
                ? t('deploymentActions.manageAnnotations')
                : t('deploymentActions.manageLabels')}
            </DialogTitle>
            <DialogDescription>
              {isAnnotations
                ? t('deploymentActions.annotationsDescription', { name })
                : t('deploymentActions.labelsDescription', { name })}
            </DialogDescription>
          </DialogHeader>
          <KVEditor
            title={
              isAnnotations
                ? t('common.fields.annotations')
                : t('common.fields.labels')
            }
            pairs={metadataPairs}
            addLabel={
              isAnnotations
                ? t('deploymentActions.addAnnotation')
                : t('deploymentActions.addLabel')
            }
            onChange={setMetadataPairs}
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => metadataGuard.handleOpenChange(false)}
            >
              {t('common.actions.cancel')}
            </Button>
            <Button
              disabled={isSaving}
              onClick={() => void handleSaveMetadata()}
            >
              {isSaving ? t('common.actions.saving') : t('common.actions.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DeleteConfirmationDialog
        open={showDelete}
        onOpenChange={setShowDelete}
        resourceName={name}
        resourceType="deployments"
        namespace={namespace}
        onConfirm={() => void handleDelete()}
        isDeleting={isDeleting}
      />

      <UnsavedChangesConfirmDialog {...imageGuard.confirmDialogProps} />
      <UnsavedChangesConfirmDialog {...metadataGuard.confirmDialogProps} />
    </>
  )
}
