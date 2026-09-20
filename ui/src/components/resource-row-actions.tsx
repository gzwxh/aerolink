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
import { getResourceFormEditPath } from '@/lib/resource-catalog'
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

/**
 * 行操作菜单覆盖的资源类型。
 *
 * 分组的依据是「有独立详情页、且能被表单编辑」：工作负载六类（Pod 也在内，它的容器镜像
 * 同样可以改）加 Service、ConfigMap / Secret 与两种存储资源。要再加一类资源，在这里加
 * 类型、在 `resourceTraits` 里声明它支持哪些项即可——菜单项本身对所有类型是同一套
 * （编辑 / 查看 YAML / 终端 / 修改镜像 / 暂停恢复 / 滚动重启 / 回滚 / 标签注解 / 删除）。
 *
 * 新增表单编辑页时记得同步 `lib/resource-catalog.ts` 的 `getResourceFormEditPath`：
 * 详情页标题栏的编辑按钮也从那里取路径。
 */
export type RowActionResourceType =
  | 'deployments'
  | 'statefulsets'
  | 'daemonsets'
  | 'jobs'
  | 'cronjobs'
  | 'pods'
  | 'services'
  | 'configmaps'
  | 'secrets'
  | 'persistentvolumes'
  | 'storageclasses'

type PodSpecLike = {
  containers?: Container[]
  initContainers?: Container[]
}

/**
 * 只声明本组件用到的字段，这样所有受支持的资源共用一套逻辑，不必为每种各写一遍。
 * 真实的 k8s 类型都能结构化地赋给它（Service 没有这些字段，全为可选所以也没问题）。
 */
type ResourceLike = {
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
 * 各类资源的差异全部收敛在这张表里：容器在哪个 spec 路径下、支持哪些菜单项。
 * 其余菜单项（编辑、YAML、标签/注解、删除）对所有类型的行为都一样。
 */
type ResourceTraits = {
  /**
   * 取容器：Pod 直接取 spec，CronJob 在 jobTemplate 下多一层；
   * 没有容器的资源（Service）为 null，也就没有「修改镜像」。
   */
  containers: ((resource: ResourceLike) => PodSpecLike) | null
  /**
   * 「修改镜像」要提交的 patch 体；null 表示不给这个入口。
   * Job 的 spec.template 创建后不可变，同样不给。
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

const podTemplateOf = (workload: ResourceLike): PodSpecLike =>
  workload.spec?.template?.spec ?? {}

const podTemplateOfCronJob = (workload: ResourceLike): PodSpecLike =>
  workload.spec?.jobTemplate?.spec?.template ?? {}

const podOf = (workload: ResourceLike): PodSpecLike => workload.spec ?? {}

const resourceTraits: Record<RowActionResourceType, ResourceTraits> = {
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
  services: {
    // Service 没有容器、终端、滚动重启、回滚与暂停这些概念：
    // 列表里只留「编辑 / 查看 YAML / 标签注解 / 删除」。
    containers: null,
    imagePatch: null,
    terminal: false,
    restart: false,
    rollback: false,
    pause: false,
  },
  // ConfigMap / Secret 与 Service 同理：内容在 data 里，没有容器也没有历史版本。
  configmaps: {
    containers: null,
    imagePatch: null,
    terminal: false,
    restart: false,
    rollback: false,
    pause: false,
  },
  secrets: {
    containers: null,
    imagePatch: null,
    terminal: false,
    restart: false,
    rollback: false,
    pause: false,
  },
  persistentvolumes: {
    // 集群级资源：同样只有元数据与编辑（路径不带命名空间段）。
    containers: null,
    imagePatch: null,
    terminal: false,
    restart: false,
    rollback: false,
    pause: false,
  },
  storageclasses: {
    containers: null,
    imagePatch: null,
    terminal: false,
    restart: false,
    rollback: false,
    pause: false,
  },
}

export function ResourceRowActions<T extends RowActionResourceType>({
  resourceType,
  resource,
}: {
  resourceType: T
  resource: ResourceTypeMap[T]
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const can = useCan()

  const traits = resourceTraits[resourceType]
  const loose = resource as unknown as ResourceLike
  const name = loose.metadata?.name ?? ''
  const namespace = loose.metadata?.namespace ?? ''
  const paused = loose.spec?.paused === true
  /**
   * 详情页路径。集群级资源（PV / StorageClass）没有命名空间段：
   * 路由是 `/:resource/:name`，不是 `/:resource/:namespace/:name`。
   */
  const detailPath = namespace
    ? `/${resourceType}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`
    : `/${resourceType}/${encodeURIComponent(name)}`
  // 编辑页的路径模板集中在 resource-catalog 里（详情页标题栏的编辑按钮同源）。
  const editPath = getResourceFormEditPath(resourceType, name, namespace)

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

  const containerSpecs = useMemo(() => {
    const spec = traits.containers?.(loose) ?? {}
    return {
      containers: spec.containers ?? [],
      initContainers: spec.initContainers ?? [],
    }
  }, [traits, loose])

  const yamlContent = useMemo(
    () => (dialog === 'yaml' ? yaml.dump(resource, { indent: 2 }) : ''),
    [dialog, resource]
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
          ? t('resourceActions.resumed', { name })
          : t('resourceActions.paused', { name })
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
      toast.success(t('resourceActions.rollingRestarted', { name }))
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
      toast.info(t('resourceActions.imageUnchanged'))
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
      toast.success(t('resourceActions.imageUpdated', { name }))
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
        ...resource,
        metadata,
      } as ResourceTypeMap[T])
      toast.success(
        t('resourceActions.metadataSaved', {
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
          {canUpdate && editPath && (
            <DropdownMenuItem onSelect={() => navigate(editPath)}>
              <IconPencil className="size-4" />
              {t('common.actions.edit')}
            </DropdownMenuItem>
          )}
          {canRead && (
            <DropdownMenuItem onSelect={() => setDialog('yaml')}>
              <IconFileCode className="size-4" />
              {t('resourceActions.viewYaml')}
            </DropdownMenuItem>
          )}
          {traits.terminal && canExec && (
            <DropdownMenuItem
              onSelect={() => navigate(`${detailPath}?tab=terminal`)}
            >
              <IconTerminal2 className="size-4" />
              {t('common.tabs.terminal')}
            </DropdownMenuItem>
          )}
          {traits.imagePatch !== null && canUpdate && (
            <DropdownMenuItem onSelect={openImageDialog}>
              <IconPhoto className="size-4" />
              {t('resourceActions.editImage')}
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
                ? t('resourceActions.resume')
                : t('resourceActions.pause')}
            </DropdownMenuItem>
          )}
          {traits.restart && canUpdate && (
            <DropdownMenuItem onSelect={() => void handleRollingRestart()}>
              <IconReload className="size-4" />
              {t('resourceActions.rollingRestart')}
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
                {t('resourceActions.manageLabels')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => openMetadataDialog('annotations')}
              >
                <IconNotes className="size-4" />
                {t('resourceActions.manageAnnotations')}
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
            <DialogTitle>{t('resourceActions.viewYaml')}</DialogTitle>
            <DialogDescription>
              {t('resourceActions.viewYamlDescription', { name })}
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
            <DialogTitle>{t('resourceActions.editImage')}</DialogTitle>
            <DialogDescription>
              {t('resourceActions.editImageDescription', { name })}
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
              {t('resourceActions.rollbackTitle', { name })}
            </DialogTitle>
            <DialogDescription>
              {t('resourceActions.rollbackDescription')}
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
                ? t('resourceActions.manageAnnotations')
                : t('resourceActions.manageLabels')}
            </DialogTitle>
            <DialogDescription>
              {isAnnotations
                ? t('resourceActions.annotationsDescription', { name })
                : t('resourceActions.labelsDescription', { name })}
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
                ? t('resourceActions.addAnnotation')
                : t('resourceActions.addLabel')
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
