import { useCallback, useMemo, useState } from 'react'
import {
  IconDots,
  IconFileCode,
  IconHistory,
  IconNotes,
  IconPencil,
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
import type { Container } from 'kubernetes-types/core/v1'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

import type { ResourceTypeMap } from '@/types/api'
import {
  deleteResource,
  patchResource,
  restartWorkload,
  updateResource,
  type DeepPartial,
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

/** 行操作菜单覆盖的工作负载类型。Pod 也在内：它的容器镜像同样可以改。 */
export type WorkloadResourceType =
  'deployments' | 'statefulsets' | 'daemonsets' | 'jobs' | 'cronjobs' | 'pods'

type PodSpecLike = {
  containers?: Container[]
  initContainers?: Container[]
}

/**
 * 只声明本组件用到的字段，这样 6 种工作负载共用一套逻辑，不必为每种各写一遍。
 * 真实的 k8s 类型都能结构化地赋给它。
 */
type WorkloadLike = {
  metadata?: {
    name?: string
    namespace?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
  }
  spec?: {
    paused?: boolean
    containers?: Container[]
    initContainers?: Container[]
    template?: { spec?: PodSpecLike }
    jobTemplate?: { spec?: { template?: PodSpecLike } }
  }
}

/**
 * 各类工作负载的差异全部收敛在这张表里：容器在哪个 spec 路径下、支持哪些菜单项。
 * 其余菜单项（编辑、YAML、标签/注解、删除）对所有类型的行为都一样。
 */
type WorkloadTraits = {
  /** 取容器：Pod 直接取 spec，CronJob 在 jobTemplate 下多一层 */
  containers: (workload: WorkloadLike) => PodSpecLike
  /**
   * 「修改镜像」要提交的 patch 体。Job 的 spec.template 创建后不可变，
   * 因此 Job 改不了镜像，这里是 null。
   */
  imagePatch:
    | ((
        containers: Container[],
        initContainers: Container[]
      ) => Record<string, unknown>)
    | null
  terminal: boolean
  restart: boolean
  rollback: boolean
  pause: boolean
}

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

/** 只提交被改动的镜像；没有任何容器变动时不写这两个字段。 */
function containerFields(containers: Container[], initContainers: Container[]) {
  return {
    ...(containers.length > 0 ? { containers } : {}),
    ...(initContainers.length > 0 ? { initContainers } : {}),
  }
}

const podTemplateOf = (workload: WorkloadLike): PodSpecLike =>
  workload.spec?.template?.spec ?? {}

const podTemplateOfCronJob = (workload: WorkloadLike): PodSpecLike =>
  workload.spec?.jobTemplate?.spec?.template ?? {}

const podOf = (workload: WorkloadLike): PodSpecLike => workload.spec ?? {}

const workloadTraits: Record<WorkloadResourceType, WorkloadTraits> = {
  deployments: {
    containers: podTemplateOf,
    imagePatch: (containers, initContainers) => ({
      spec: { template: { spec: containerFields(containers, initContainers) } },
    }),
    terminal: true,
    restart: true,
    rollback: true,
    pause: true,
  },
  statefulsets: {
    containers: podTemplateOf,
    imagePatch: (containers, initContainers) => ({
      spec: { template: { spec: containerFields(containers, initContainers) } },
    }),
    terminal: true,
    restart: true,
    rollback: true,
    pause: false,
  },
  daemonsets: {
    containers: podTemplateOf,
    imagePatch: (containers, initContainers) => ({
      spec: { template: { spec: containerFields(containers, initContainers) } },
    }),
    terminal: true,
    restart: true,
    rollback: true,
    pause: false,
  },
  jobs: {
    containers: podTemplateOf,
    // Job 的 pod 模板不可变，改镜像只能重建 Job。
    imagePatch: null,
    terminal: true,
    restart: false,
    rollback: false,
    pause: false,
  },
  cronjobs: {
    containers: podTemplateOfCronJob,
    imagePatch: (containers, initContainers) => ({
      spec: {
        jobTemplate: {
          spec: {
            template: { spec: containerFields(containers, initContainers) },
          },
        },
      },
    }),
    terminal: false,
    restart: false,
    rollback: false,
    pause: false,
  },
  pods: {
    containers: podOf,
    imagePatch: (containers, initContainers) => ({
      spec: containerFields(containers, initContainers),
    }),
    terminal: true,
    restart: false,
    rollback: false,
    pause: false,
  },
}

export function WorkloadRowActions<T extends WorkloadResourceType>({
  resourceType,
  workload,
}: {
  resourceType: T
  workload: ResourceTypeMap[T]
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const can = useCan()

  const traits = workloadTraits[resourceType]
  const loose = workload as unknown as WorkloadLike
  const name = loose.metadata?.name ?? ''
  const namespace = loose.metadata?.namespace ?? ''
  const paused = loose.spec?.paused === true

  const canRead = can(resourceType, 'get', { namespace })
  const canUpdate = can(resourceType, 'update', { namespace })
  const canDelete = can(resourceType, 'delete', { namespace })
  // 终端是连进 Pod 执行命令，判的是 pods 的 exec 权限。
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
      containers: traits.containers(loose).containers ?? [],
      initContainers: traits.containers(loose).initContainers ?? [],
    }),
    [traits, loose]
  )

  const yamlContent = useMemo(
    () => (dialog === 'yaml' ? yaml.dump(workload, { indent: 2 }) : ''),
    [dialog, workload]
  )

  if (!canRead && !canUpdate && !canDelete && !canExec) {
    return null
  }

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: [resourceType] })

  const openMetadataDialog = (kind: 'labels' | 'annotations') => {
    const pairs = toPairs(
      kind === 'labels' ? loose.metadata?.labels : loose.metadata?.annotations
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
      await patchResource(resourceType, name, namespace, {
        spec: { paused: !paused },
      } as DeepPartial<ResourceTypeMap[T]>)
      toast.success(
        paused
          ? t('workloadActions.resumed', { name })
          : t('workloadActions.paused', { name })
      )
      await refresh()
    } catch {
      // 操作失败已由 API 客户端统一写入站内信，不再弹窗
    }
  }

  const handleRollingRestart = async () => {
    try {
      await restartWorkload(
        resourceType as 'deployments' | 'statefulsets' | 'daemonsets',
        name,
        namespace
      )
      toast.success(t('workloadActions.rollingRestarted', { name }))
      await refresh()
    } catch {
      // 操作失败已由 API 客户端统一写入站内信，不再弹窗
    }
  }

  const handleSaveImages = async () => {
    const allContainers = [
      ...containerSpecs.containers,
      ...containerSpecs.initContainers,
    ]
    const changed = images
      .map((entry) => ({ name: entry.name, image: entry.image.trim() }))
      .filter((entry) => {
        if (!entry.image) return false
        const original = allContainers.find(
          (container) => container.name === entry.name
        )
        return (original?.image ?? '') !== entry.image
      })

    if (changed.length === 0) {
      toast.info(t('workloadActions.imageUnchanged'))
      setDialog(null)
      return
    }

    const containerNames = new Set(
      containerSpecs.containers.map((container) => container.name)
    )
    const initContainerNames = new Set(
      containerSpecs.initContainers.map((container) => container.name)
    )
    const containers = changed.filter((entry) =>
      containerNames.has(entry.name)
    ) as Container[]
    const initContainers = changed.filter((entry) =>
      initContainerNames.has(entry.name)
    ) as Container[]

    setIsSaving(true)
    try {
      await patchResource(
        resourceType,
        name,
        namespace,
        traits.imagePatch?.(containers, initContainers) as DeepPartial<
          ResourceTypeMap[T]
        >
      )
      toast.success(t('workloadActions.imageUpdated', { name }))
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
      ? { ...loose.metadata, annotations: record }
      : { ...loose.metadata, labels: record }

    setIsSaving(true)
    try {
      // 整体替换而非 merge patch：删除键时不会留下旧值。
      await updateResource(resourceType, name, namespace, {
        ...workload,
        metadata,
      } as ResourceTypeMap[T])
      toast.success(
        t('workloadActions.metadataSaved', {
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
      await deleteResource(resourceType, name, namespace)
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
          {canUpdate && (
            <DropdownMenuItem
              onSelect={() =>
                navigate(
                  `/${resourceType}/${encodeURIComponent(
                    namespace
                  )}/${encodeURIComponent(name)}/edit`
                )
              }
            >
              <IconPencil className="size-4" />
              {t('common.actions.edit')}
            </DropdownMenuItem>
          )}
          {canRead && (
            <DropdownMenuItem onSelect={() => setDialog('yaml')}>
              <IconFileCode className="size-4" />
              {t('workloadActions.viewYaml')}
            </DropdownMenuItem>
          )}
          {traits.terminal && canExec && (
            <DropdownMenuItem
              onSelect={() =>
                navigate(
                  `/${resourceType}/${encodeURIComponent(
                    namespace
                  )}/${encodeURIComponent(name)}?tab=terminal`
                )
              }
            >
              <IconTerminal2 className="size-4" />
              {t('common.tabs.terminal')}
            </DropdownMenuItem>
          )}
          {traits.imagePatch !== null && canUpdate && (
            <DropdownMenuItem onSelect={openImageDialog}>
              <IconPhoto className="size-4" />
              {t('workloadActions.editImage')}
            </DropdownMenuItem>
          )}
          {traits.pause && canUpdate && (
            <DropdownMenuItem onSelect={() => void handleTogglePaused()}>
              {paused ? (
                <IconPlayerPlay className="size-4" />
              ) : (
                <IconPlayerPause className="size-4" />
              )}
              {paused
                ? t('workloadActions.resume')
                : t('workloadActions.pause')}
            </DropdownMenuItem>
          )}
          {traits.restart && canUpdate && (
            <DropdownMenuItem onSelect={() => void handleRollingRestart()}>
              <IconReload className="size-4" />
              {t('workloadActions.rollingRestart')}
            </DropdownMenuItem>
          )}
          {traits.rollback && canUpdate && (
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
                {t('workloadActions.manageLabels')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => openMetadataDialog('annotations')}
              >
                <IconNotes className="size-4" />
                {t('workloadActions.manageAnnotations')}
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
            <DialogTitle>{t('workloadActions.viewYaml')}</DialogTitle>
            <DialogDescription>
              {t('workloadActions.viewYamlDescription', { name })}
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
            <DialogTitle>{t('workloadActions.editImage')}</DialogTitle>
            <DialogDescription>
              {t('workloadActions.editImageDescription', { name })}
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
              {t('workloadActions.rollbackTitle', { name })}
            </DialogTitle>
            <DialogDescription>
              {t('workloadActions.rollbackDescription')}
            </DialogDescription>
          </DialogHeader>
          <WorkloadRevisionsTable
            resourceType={
              resourceType as 'deployments' | 'statefulsets' | 'daemonsets'
            }
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
                ? t('workloadActions.manageAnnotations')
                : t('workloadActions.manageLabels')}
            </DialogTitle>
            <DialogDescription>
              {isAnnotations
                ? t('workloadActions.annotationsDescription', { name })
                : t('workloadActions.labelsDescription', { name })}
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
                ? t('workloadActions.addAnnotation')
                : t('workloadActions.addLabel')
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
        resourceType={resourceType}
        namespace={namespace}
        onConfirm={() => void handleDelete()}
        isDeleting={isDeleting}
      />

      <UnsavedChangesConfirmDialog {...imageGuard.confirmDialogProps} />
      <UnsavedChangesConfirmDialog {...metadataGuard.confirmDialogProps} />
    </>
  )
}
