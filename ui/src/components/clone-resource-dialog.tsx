import { useCallback, useEffect, useState } from 'react'
import { IconCopy, IconLoader2 } from '@tabler/icons-react'
import * as yaml from 'js-yaml'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

import { ResourceType, ResourceTypeMap } from '@/types/api'
import { applyResource, createResource, fetchResource } from '@/lib/api'
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

type MutableResource = Record<string, unknown> & {
  metadata?: Record<string, unknown>
  spec?: Record<string, unknown>
}

const serverMetadataFields = [
  'uid',
  'resourceVersion',
  'generation',
  'creationTimestamp',
  'deletionTimestamp',
  'deletionGracePeriodSeconds',
  'managedFields',
  'selfLink',
  'ownerReferences',
  'finalizers',
  'generateName',
]

const controllerLabelKeys = [
  'controller-uid',
  'job-name',
  'batch.kubernetes.io/controller-uid',
  'batch.kubernetes.io/job-name',
  'batch.kubernetes.io/job-completion-index',
  'pod-template-hash',
  'controller-revision-hash',
  'statefulset.kubernetes.io/pod-name',
  'apps.kubernetes.io/pod-index',
]

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  return value as Record<string, unknown>
}

function removeControllerLabels(metadata?: Record<string, unknown>) {
  const labels = asRecord(metadata?.labels)
  if (!labels) return

  controllerLabelKeys.forEach((key) => delete labels[key])
}

function removeInjectedServiceAccountVolumes(spec: Record<string, unknown>) {
  const volumes = Array.isArray(spec.volumes) ? spec.volumes : []
  const injectedVolumeNames = new Set(
    volumes.flatMap((volume) => {
      const item = asRecord(volume)
      const name = item?.name
      return typeof name === 'string' && name.startsWith('kube-api-access-')
        ? [name]
        : []
    })
  )

  if (injectedVolumeNames.size === 0) return

  spec.volumes = volumes.filter((volume) => {
    const name = asRecord(volume)?.name
    return typeof name !== 'string' || !injectedVolumeNames.has(name)
  })

  for (const containerField of ['containers', 'initContainers']) {
    const containers = spec[containerField]
    if (!Array.isArray(containers)) continue

    for (const container of containers) {
      const item = asRecord(container)
      if (!item || !Array.isArray(item.volumeMounts)) continue
      item.volumeMounts = item.volumeMounts.filter((mount) => {
        const name = asRecord(mount)?.name
        return typeof name !== 'string' || !injectedVolumeNames.has(name)
      })
    }
  }
}

function cleanService(resource: MutableResource) {
  const spec = asRecord(resource.spec)
  if (!spec) return

  delete spec.clusterIP
  delete spec.clusterIPs
  delete spec.healthCheckNodePort

  if (Array.isArray(spec.ports)) {
    for (const port of spec.ports) {
      const item = asRecord(port)
      if (item) delete item.nodePort
    }
  }
}

function cleanVolumeClaim(resource: MutableResource) {
  const spec = asRecord(resource.spec)
  if (spec) delete spec.volumeName

  const annotations = asRecord(resource.metadata?.annotations)
  if (!annotations) return

  delete annotations['pv.kubernetes.io/bind-completed']
  delete annotations['pv.kubernetes.io/bound-by-controller']
  delete annotations['volume.kubernetes.io/selected-node']
  delete annotations['volume.kubernetes.io/storage-provisioner']
  delete annotations['volume.beta.kubernetes.io/storage-provisioner']
}

function prepareCloneResource(
  resource: unknown,
  resourceType: ResourceType,
  sourceName: string
) {
  const cloned = structuredClone(resource) as MutableResource
  const metadata = asRecord(cloned.metadata) || {}

  serverMetadataFields.forEach((field) => delete metadata[field])
  metadata.name = `${sourceName}-copy`
  cloned.metadata = metadata
  delete cloned.status
  delete cloned.metrics

  const annotations = asRecord(metadata.annotations)
  if (annotations) {
    delete annotations['kubectl.kubernetes.io/last-applied-configuration']
    delete annotations['deployment.kubernetes.io/revision']
    delete annotations['deprecated.daemonset.template.generation']
    delete annotations['kubernetes.io/config.mirror']
    delete annotations['kubernetes.io/config.seen']
    delete annotations['kubernetes.io/config.source']
  }

  if (resourceType === 'jobs') {
    const spec = asRecord(cloned.spec)
    if (spec) {
      delete spec.selector
      delete spec.manualSelector
      removeControllerLabels(metadata)
      removeControllerLabels(asRecord(asRecord(spec.template)?.metadata))
    }
  }

  if (resourceType === 'pods') {
    const spec = asRecord(cloned.spec)
    if (spec) {
      delete spec.nodeName
      delete spec.ephemeralContainers
      removeInjectedServiceAccountVolumes(spec)
    }
    removeControllerLabels(metadata)
  }

  if (resourceType === 'services') {
    cleanService(cloned)
  }

  if (resourceType === 'persistentvolumeclaims') {
    cleanVolumeClaim(cloned)
  }

  if (resourceType === 'persistentvolumes') {
    const spec = asRecord(cloned.spec)
    if (spec) delete spec.claimRef
  }

  if (resourceType === 'serviceaccounts') {
    delete cloned.secrets
  }

  if (resourceType === 'namespaces') {
    const spec = asRecord(cloned.spec)
    if (spec) delete spec.finalizers
  }

  if (resourceType === 'storageclasses' && annotations) {
    delete annotations['storageclass.kubernetes.io/is-default-class']
    delete annotations['storageclass.beta.kubernetes.io/is-default-class']
  }

  return cloned
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
  const [isDraftDirty, setIsDraftDirty] = useState(false)
  const close = useCallback(() => onOpenChange(false), [onOpenChange])
  const guard = useUnsavedChangesGuard({ dirty: isDraftDirty, onClose: close })

  return (
    <>
      <Dialog open={open} onOpenChange={guard.handleOpenChange}>
        {open ? (
          <CloneResourceDialogContent
            resourceType={resourceType}
            resourceLabel={resourceLabel}
            sourceName={sourceName}
            namespace={namespace}
            resource={resource}
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
  onCloned,
  onDraftChange,
  onRequestClose,
  onClose,
}: Omit<CloneResourceDialogProps, 'open' | 'onOpenChange'> & {
  /** 上报是否有草稿，父级据此决定关闭时是否先弹确认。 */
  onDraftChange: (hasDraft: boolean) => void
  /** 需要用户确认的关闭请求（取消按钮）。 */
  onRequestClose: () => void
  /** 直接关闭（克隆成功，或已确认丢弃草稿）。 */
  onClose: () => void
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [yamlContent, setYamlContent] = useState(() =>
    yaml.dump(prepareCloneResource(resource, resourceType, sourceName), {
      indent: 2,
      noRefs: true,
    })
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

    let manifest: MutableResource
    try {
      const parsed = yaml.load(yamlContent)
      const parsedResource = asRecord(parsed)
      if (!parsedResource) {
        setError(t('cloneResource.invalidYaml'))
        return
      }
      manifest = parsedResource
    } catch {
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

      if (catalogEntry) {
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
