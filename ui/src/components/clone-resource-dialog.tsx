import { useCallback, useEffect, useMemo, useState } from 'react'
import { IconCopy, IconLoader2 } from '@tabler/icons-react'
import * as yaml from 'js-yaml'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

import { ResourceType, ResourceTypeMap } from '@/types/api'
import {
  applyResource,
  createResource,
  fetchResource,
  useResources,
} from '@/lib/api'
import {
  asRecord,
  prepareCloneResource,
  type MutableResource,
} from '@/lib/clone-manifest'
import {
  rewriteServiceSelector,
  serviceCloneName,
  serviceSelectsPodLabels,
} from '@/lib/clone-service'
import { isWorkloadSelectorType } from '@/lib/clone-workload'
import {
  getResourceCatalogEntry,
  getResourceDetailPath,
} from '@/lib/resource-catalog'
import { useUnsavedEdits } from '@/lib/unsaved-edits'
import { translateError } from '@/lib/utils'
import {
  useDraftDirty,
  useUnsavedChangesGuard,
} from '@/hooks/use-unsaved-changes-guard'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SimpleYamlEditor } from '@/components/simple-yaml-editor'
import { UnsavedChangesConfirmDialog } from '@/components/unsaved-changes-confirm-dialog'

interface CloneResourceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  resourceType: ResourceType
  resourceLabel: string
  sourceName: string
  namespace?: string
  resource: unknown
  /** 创建成功后以克隆出的资源名回调。 */
  onCloned?: (targetName: string) => Promise<void> | void
}

/** Pod 模板标签：Service 的 selector 就是与它比对的。 */
function podTemplateLabels(
  resource: unknown
): Record<string, unknown> | undefined {
  const spec = asRecord(asRecord(resource)?.spec)
  return asRecord(asRecord(asRecord(spec?.template)?.metadata)?.labels)
}

/**
 * 草稿可能是多文档（主资源 + 关联 Service）。
 * 必须用 dumpAll：把一个数组交给 dump 会输出成 YAML 序列，而不是多文档流。
 */
function dumpCloneDocuments(documents: MutableResource[]): string {
  const options = { indent: 2, noRefs: true } as const
  if (documents.length === 1) {
    return yaml.dump(documents[0], options)
  }
  // 多文档流手工用 `---` 拼：@types/js-yaml 没有 dumpAll 的声明，
  // 而 yaml.dump(数组) 会输出成 YAML 序列（`- …`），不是多文档。
  return `${documents
    .map((document) => yaml.dump(document, options).trimEnd())
    .join('\n---\n')}\n`
}

export function CloneResourceDialog({
  open,
  onOpenChange,
  resourceType,
  resourceLabel,
  sourceName,
  namespace,
  resource,
  onCloned,
}: CloneResourceDialogProps) {
  // 草稿在条件挂载的内容组件里，关闭即丢弃，所以「有没有改动」上报到这一层，
  // 由 useUnsavedChangesGuard 拦截遮罩点击 / Esc / 右上角 X。
  const { t } = useTranslation()
  const [isDraftDirty, setIsDraftDirty] = useState(false)
  const close = useCallback(() => onOpenChange(false), [onOpenChange])
  const guard = useUnsavedChangesGuard({ dirty: isDraftDirty, onClose: close })

  // 关联 Service（selector 选中这个工作负载的那些）：克隆时要一并带走并改名，
  // 否则新应用没有访问入口；而直接复制原 Service 又会与它撞名。
  // 等查询完成再渲染内容：草稿是一次性生成的 YAML，异步补写会覆盖用户已改过的内容。
  const attachServices = isWorkloadSelectorType(resourceType) && !!namespace
  const { data: relatedServices, isLoading: isLoadingServices } = useResources(
    'services',
    namespace,
    { disable: !open || !attachServices }
  )

  return (
    <>
      <Dialog open={open} onOpenChange={guard.handleOpenChange}>
        {open && isLoadingServices ? (
          <DialogContent className="sm:max-w-md">
            <div className="text-muted-foreground py-6 text-center text-sm">
              {t(
                'cloneResource.loadingRelatedServices',
                '正在检查关联的 Service…'
              )}
            </div>
          </DialogContent>
        ) : null}
        {open && !isLoadingServices ? (
          <CloneResourceDialogContent
            resourceType={resourceType}
            resourceLabel={resourceLabel}
            sourceName={sourceName}
            namespace={namespace}
            resource={resource}
            relatedServices={attachServices ? relatedServices : undefined}
            onCloned={onCloned}
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

function CloneResourceDialogContent({
  resourceType,
  resourceLabel,
  sourceName,
  namespace,
  resource,
  relatedServices,
  onCloned,
  onDraftChange,
  onRequestClose,
  onClose,
}: Omit<CloneResourceDialogProps, 'open' | 'onOpenChange'> & {
  /** selector 选中该工作负载的 Service：克隆时一并带走并改名（见 lib/clone-service.ts）。 */
  relatedServices?: unknown[]
  /** 上报是否有草稿，父级据此决定关闭时是否先弹确认。 */
  onDraftChange: (hasDraft: boolean) => void
  /** 需要用户确认的关闭请求（取消按钮）。 */
  onRequestClose: () => void
  /** 直接关闭（克隆成功，或已确认丢弃草稿）。 */
  onClose: () => void
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  // 关联 Service 的克隆体：改名 + selector 指向新 Pod 标签（见 lib/clone-service.ts）。
  // 「关联」的判定要用**源对象**的 Pod 标签——Service 的 selector 是它的子集。
  const relatedServiceClones = useMemo(() => {
    const sourcePodLabels = podTemplateLabels(resource)
    if (!sourcePodLabels) {
      return [] as MutableResource[]
    }
    const targetName = `${sourceName}-copy`
    return (relatedServices ?? [])
      .filter((service) => serviceSelectsPodLabels(service, sourcePodLabels))
      .flatMap((service) => {
        const name = asRecord(asRecord(service)?.metadata)?.name
        if (typeof name !== 'string' || !name) {
          return []
        }
        const cloned = prepareCloneResource(service, 'services', name)
        const metadata = asRecord(cloned.metadata) || {}
        metadata.name = serviceCloneName(name, sourceName, targetName)
        cloned.metadata = metadata
        rewriteServiceSelector(cloned, sourceName, targetName)
        return [cloned]
      })
  }, [relatedServices, resource, sourceName])

  const attachedServiceNames = relatedServiceClones
    .map((service) => asRecord(service.metadata)?.name)
    .filter((name): name is string => typeof name === 'string')

  const initialDocuments = useMemo(
    () => [
      prepareCloneResource(resource, resourceType, sourceName),
      ...relatedServiceClones,
    ],
    [resource, resourceType, sourceName, relatedServiceClones]
  )

  const [yamlContent, setYamlContent] = useState(() =>
    dumpCloneDocuments(initialDocuments)
  )
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState('')
  // 首帧的 YAML 作为草稿基线（父组件刷新不会重置它）；改过才算未保存。
  const isDirty = useDraftDirty(yamlContent)
  // 有草稿时切集群会先弹确认（见 ClusterProvider）；确认丢弃后关掉弹窗。
  useUnsavedEdits(isDirty, onClose)
  useEffect(() => {
    onDraftChange(isDirty)
  }, [isDirty, onDraftChange])

  const handleClone = async () => {
    setError('')

    let documents: MutableResource[]
    try {
      // 草稿可能是多文档（主资源 + 关联 Service）：yaml.load 遇到多文档会抛错，用 loadAll。
      documents = yaml.loadAll(yamlContent).flatMap((item) => {
        const record = asRecord(item)
        return record ? [record as MutableResource] : []
      })
    } catch {
      setError(t('cloneResource.invalidYaml'))
      return
    }
    const manifest = documents[0]
    if (!manifest) {
      setError(t('cloneResource.invalidYaml'))
      return
    }

    const metadata = asRecord(manifest.metadata)
    const targetName = metadata?.name
    const targetNamespace = metadata?.namespace
    if (typeof targetName !== 'string' || !targetName.trim()) {
      setError(t('cloneResource.nameRequired'))
      return
    }
    if (
      namespace &&
      (typeof targetNamespace !== 'string' || !targetNamespace.trim())
    ) {
      setError(t('cloneResource.namespaceRequired'))
      return
    }
    if (targetName === sourceName && targetNamespace === namespace) {
      setError(t('cloneResource.targetMustChange'))
      return
    }

    setIsCreating(true)
    try {
      const resolvedNamespace =
        typeof targetNamespace === 'string' && targetNamespace.trim()
          ? targetNamespace
          : undefined
      const catalogEntry = getResourceCatalogEntry(resourceType)

      if (documents.length > 1) {
        // 多文档（克隆体 + 关联 Service）：一次性提交，两者一起创建。
        // 改名等改写已经在草稿生成时完成（见 prepareCloneResource），这里不再动内容，
        // 免得覆盖用户在编辑器里做的调整。
        await applyResource(yamlContent, resolvedNamespace)
      } else if (catalogEntry) {
        await createResource(
          resourceType,
          catalogEntry.clusterScope ? undefined : resolvedNamespace,
          manifest as ResourceTypeMap[ResourceType]
        )
      } else {
        try {
          await fetchResource(
            resourceType,
            targetName,
            resolvedNamespace || '_all'
          )
          setError(t('cloneResource.targetExists'))
          return
        } catch (fetchError) {
          if (
            !(fetchError instanceof Error) ||
            !/not found/i.test(fetchError.message)
          ) {
            throw fetchError
          }
        }
        await applyResource(yaml.dump(manifest, { indent: 2, noRefs: true }))
      }

      onClose()
      if (onCloned) {
        try {
          await onCloned(targetName)
        } catch (error) {
          toast.error(translateError(error, t))
        }
      }
      navigate(
        catalogEntry
          ? getResourceDetailPath(resourceType, targetName, resolvedNamespace)
          : resolvedNamespace
            ? `/crds/${resourceType}/${resolvedNamespace}/${targetName}`
            : `/crds/${resourceType}/${targetName}`
      )
    } catch (createError) {
      setError(translateError(createError, t))
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-4xl">
      <DialogHeader>
        <DialogTitle className="text-balance">
          {t('cloneResource.title', { resource: resourceLabel })}
        </DialogTitle>
        <DialogDescription className="text-pretty">
          {t('cloneResource.description', {
            resource: resourceLabel,
            name: sourceName,
          })}
        </DialogDescription>
      </DialogHeader>

      {/* 关联 Service 一并克隆：不改名会与原 Service 撞名，selector 不改又会继续指着旧 Pod。 */}
      {attachedServiceNames.length > 0 ? (
        <Alert>
          <AlertDescription>
            {t(
              'cloneResource.attachedServices',
              '已附带 {{count}} 个关联的 Service（{{names}}）：名称与 selector 已按新名字改好，可在下面的 YAML 里继续调整。',
              {
                count: attachedServiceNames.length,
                names: attachedServiceNames.join(', '),
              }
            )}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        <SimpleYamlEditor
          value={yamlContent}
          onChange={(value) => {
            setYamlContent(value || '')
            setError('')
          }}
          height="400px"
        />

        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </div>

      <DialogFooter>
        <Button
          variant="outline"
          onClick={onRequestClose}
          disabled={isCreating}
        >
          {t('common.actions.cancel')}
        </Button>
        <Button onClick={() => void handleClone()} disabled={isCreating}>
          {isCreating ? (
            <IconLoader2 className="size-4 animate-spin" />
          ) : (
            <IconCopy className="size-4" />
          )}
          {isCreating ? t('cloneResource.creating') : t('cloneResource.create')}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
