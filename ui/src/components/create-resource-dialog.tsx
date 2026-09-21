import { useCallback, useEffect, useMemo, useState } from 'react'
import { IconLoader2 } from '@tabler/icons-react'
import * as yaml from 'js-yaml'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { applyResource, useResources, useTemplates } from '@/lib/api'
import { isClusterScopedKind } from '@/lib/resource-catalog'
import { useUnsavedEdits } from '@/lib/unsaved-edits'
import { translateError } from '@/lib/utils'
import { useUnsavedChangesGuard } from '@/hooks/use-unsaved-changes-guard'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  defaultSchedulingConfig,
  type SchedulingConfig,
} from '@/components/editors/deployment-form'
import {
  applySchedulingToYaml,
  NodeSchedulingSection,
  parseSchedulingFromYaml,
} from '@/components/node-scheduling-section'
import { NamespaceSelector } from '@/components/selector/namespace-selector'
import { SimpleYamlEditor } from '@/components/simple-yaml-editor'
import { UnsavedChangesConfirmDialog } from '@/components/unsaved-changes-confirm-dialog'

interface CreateResourceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const YAML_DUMP_OPTIONS = { indent: 2, noRefs: true, lineWidth: -1 }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** 文档的 metadata：没有就当空的补一个；存在但不是对象（用户写了一半）返回 null，表示别动它。 */
function editableMetadata(doc: Record<string, unknown>) {
  const metadata = doc.metadata
  if (metadata === undefined) return {}
  return isPlainObject(metadata) ? metadata : null
}

/**
 * 把选中的命名空间写进 YAML：命名空间级文档改写 metadata.namespace，集群级文档不动
 * （后端 apply 时本来就按 RESTMapping 清掉它）。只有确实要改才重新 dump，
 * 免得白白把注释冲掉。
 */
function applyNamespaceToYaml(content: string, namespace: string): string {
  if (!content.trim() || !namespace || namespace === '_all') return content

  let docs: unknown[]
  try {
    docs = yaml.loadAll(content)
  } catch {
    // YAML 还没写完：保持原样，等用户改好再说。
    return content
  }
  // 多文档里夹着非对象内容（列表、标量之类）时整体不动，避免把用户写的内容丢掉。
  const documents = docs.filter((doc) => doc != null)
  if (!documents.every(isPlainObject)) return content

  let changed = false
  const dumped = documents.map((doc) => {
    const kind = typeof doc.kind === 'string' ? doc.kind : undefined
    const metadata = editableMetadata(doc)
    if (
      metadata &&
      !isClusterScopedKind(kind) &&
      metadata.namespace !== namespace
    ) {
      metadata.namespace = namespace
      doc.metadata = metadata
      changed = true
    }
    return yaml.dump(doc, YAML_DUMP_OPTIONS)
  })

  return changed ? dumped.join('---\n') : content
}

export function CreateResourceDialog({
  open,
  onOpenChange,
}: CreateResourceDialogProps) {
  // 内容组件只在 open 期间挂载，关闭即丢弃草稿，所以「有没有改动」提到这一层：
  // 遮罩点击、Esc、右上角 X、取消按钮都会走 Dialog 根的 onOpenChange(false)，
  // 由 useUnsavedChangesGuard 统一决定是直接关还是先确认，避免误触丢掉写好的 YAML。
  const [isDraftDirty, setIsDraftDirty] = useState(false)
  const close = useCallback(() => onOpenChange(false), [onOpenChange])
  const guard = useUnsavedChangesGuard({ dirty: isDraftDirty, onClose: close })

  return (
    <>
      <Dialog open={open} onOpenChange={guard.handleOpenChange}>
        {open ? (
          <CreateResourceDialogContent
            onDraftChange={setIsDraftDirty}
            onRequestClose={() => guard.handleOpenChange(false)}
            onClose={close}
          />
        ) : null}
      </Dialog>

      <UnsavedChangesConfirmDialog
        {...guard.confirmDialogProps}
        i18nPrefix="dialog.createResourceUnsaved"
      />
    </>
  )
}

interface CreateResourceDialogContentProps {
  /** 上报是否有草稿，父级据此决定关闭时是否先弹确认。 */
  onDraftChange: (hasDraft: boolean) => void
  /** 需要用户确认的关闭请求（取消按钮）。 */
  onRequestClose: () => void
  /** 直接关闭（应用成功，或已确认丢弃草稿）。 */
  onClose: () => void
}

function CreateResourceDialogContent({
  onDraftChange,
  onRequestClose,
  onClose,
}: CreateResourceDialogContentProps) {
  const { t } = useTranslation()
  const { data: templates = [] } = useTemplates()
  // 命名空间列表后端按权限过滤（见 pkg/resources/generic_resource_handler_list.go），
  // 所以列表为空就等于没有命名空间权限：这时不展示下拉框，免得给出一个必然选不出东西的入口。
  const { data: namespaces, isLoading: isLoadingNamespaces } =
    useResources('namespaces')
  const canSelectNamespace = (namespaces?.length ?? 0) > 0
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('')
  const [selectedNamespace, setSelectedNamespace] = useState<string>()
  const [yamlContent, setYamlContent] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [scheduling, setScheduling] = useState<SchedulingConfig>(
    defaultSchedulingConfig()
  )
  const hasDraft = yamlContent.trim() !== ''
  // 草稿存在时切集群会先弹确认（见 ClusterProvider）：内容非空即视为草稿，
  // 因为这里初始为空，任何内容都来自用户输入或模板。确认丢弃后关掉弹窗。
  useUnsavedEdits(hasDraft, onClose)

  useEffect(() => {
    onDraftChange(hasDraft)
  }, [hasDraft, onDraftChange])
  const isWorkloadYaml = useMemo(() => {
    if (!yamlContent.trim()) return false
    try {
      const doc = yaml.load(yamlContent) as
        | { kind?: string; spec?: { template?: { spec?: unknown } } }
        | undefined
        | null
      const kind = doc?.kind || ''
      return (
        ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet'].includes(
          kind
        ) && !!doc?.spec?.template?.spec
      )
    } catch {
      return false
    }
  }, [yamlContent])

  const hasNamespaceConflict = useMemo(() => {
    if (!selectedNamespace) return false

    try {
      let conflict = false
      yaml.loadAll(yamlContent, (document) => {
        if (!document || typeof document !== 'object') return

        const namespace = (document as { metadata?: { namespace?: unknown } })
          .metadata?.namespace
        if (typeof namespace === 'string' && namespace !== selectedNamespace) {
          conflict = true
        }
      })
      return conflict
    } catch {
      return false
    }
  }, [selectedNamespace, yamlContent])

  const handleTemplateChange = (templateName: string) => {
    if (templateName === 'empty') {
      setYamlContent('')
      setSelectedTemplateId('')
      setScheduling(defaultSchedulingConfig())
      return
    }

    const template = templates.find((t) => t.name === templateName)
    if (template) {
      // 已经选过命名空间的话，模板 YAML 也直接带上它，和下面的下拉框保持一致。
      const nextYaml = applyNamespaceToYaml(
        template.yaml,
        selectedNamespace ?? ''
      )
      setYamlContent(nextYaml)
      setSelectedTemplateId(template.name)
      setScheduling(parseSchedulingFromYaml(nextYaml))
    }
  }

  const handleNamespaceChange = (namespace: string) => {
    setSelectedNamespace(namespace)
    // 选中的命名空间同步写进 YAML：编辑器里看到的就是实际会下发的命名空间。
    setYamlContent((prev) => applyNamespaceToYaml(prev, namespace))
  }

  const handleApply = async () => {
    if (!yamlContent) return

    setIsLoading(true)
    try {
      await applyResource(yamlContent, selectedNamespace)
      toast.success(t('common.messages.applied', 'Applied successfully'))
      onClose()
    } catch (err) {
      console.error('Failed to apply resource', err)
      toast.error(translateError(err, t))
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <DialogContent className="flex max-h-[80vh] flex-col overflow-hidden !max-w-4xl sm:!max-w-4xl">
      <DialogHeader>
        <DialogTitle>
          {t('dialog.createResource', 'Create Resource')}
        </DialogTitle>
        <DialogDescription>
          {t(
            'dialog.createResourceDescription',
            'Paste one or more Kubernetes resource YAML documents and apply them to the cluster'
          )}
        </DialogDescription>
      </DialogHeader>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="template">
              {t('common.fields.template', 'Template')}
            </Label>
            <Select
              value={selectedTemplateId || 'empty'}
              onValueChange={handleTemplateChange}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={t(
                    'common.placeholders.selectTemplate',
                    'Select a template'
                  )}
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="empty">
                  {t('common.values.emptyTemplate', 'Empty Template')}
                </SelectItem>
                {templates.map((template) => (
                  <SelectItem key={template.name} value={template.name}>
                    {template.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {!isLoadingNamespaces && canSelectNamespace ? (
            <div className="space-y-2">
              <Label>{t('common.fields.namespace', 'Namespace')}</Label>
              <NamespaceSelector
                selectedNamespace={selectedNamespace}
                handleNamespaceChange={handleNamespaceChange}
                triggerClassName="sm:w-full sm:max-w-none"
                modal
              />
              {hasNamespaceConflict ? (
                <p className="text-xs text-muted-foreground">
                  {t('common.messages.namespaceOverride', {
                    namespace: selectedNamespace,
                    defaultValue:
                      'The selected namespace will override different namespaces in the YAML when applying.',
                  })}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
        {isWorkloadYaml && (
          <NodeSchedulingSection
            value={scheduling}
            onChange={(next) => {
              setScheduling(next)
              setYamlContent(applySchedulingToYaml(yamlContent, next))
            }}
          />
        )}
        <div className="space-y-2">
          <Label htmlFor="yaml">
            {t('common.fields.yamlConfiguration', 'YAML Configuration')}
          </Label>
          <div className="min-h-[300px] border rounded-md">
            <SimpleYamlEditor
              value={yamlContent}
              onChange={(value) => setYamlContent(value || '')}
              height="400px"
            />
          </div>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onRequestClose} disabled={isLoading}>
          {t('common.actions.cancel', 'Cancel')}
        </Button>
        <Button onClick={handleApply} disabled={isLoading || !yamlContent}>
          {isLoading ? (
            <>
              <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('common.messages.applying', 'Applying...')}
            </>
          ) : (
            t('common.actions.apply', 'Apply')
          )}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
