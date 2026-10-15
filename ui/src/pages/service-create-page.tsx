import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import * as yaml from 'js-yaml'
import type { Service } from 'kubernetes-types/core/v1'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

import { applyResource, updateResource, useResource } from '@/lib/api'
import { prepareCloneResource } from '@/lib/clone-manifest'
import {
  allowedServiceTypes,
  formFromService,
  generateServiceYaml,
  initialData,
  intOrNull,
  mergeServiceUpdate,
  servicePortErrorCodes,
  type ServiceFormData,
  type ServiceType,
} from '@/lib/service-yaml'
import { useUnsavedEdits } from '@/lib/unsaved-edits'
import { translateError } from '@/lib/utils'
import { useCan } from '@/hooks/use-can'
import { useNodePortRange } from '@/hooks/use-node-port-range'
import { usePageTitle } from '@/hooks/use-page-title'
import { useServicePortErrorText } from '@/hooks/use-service-port-error-text'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { LabelSelectorEditor } from '@/components/label-selector-editor'
import { NamespaceSelector } from '@/components/selector/namespace-selector'
import { ServicePortsEditor } from '@/components/service-ports-editor'
import { SimpleYamlEditor } from '@/components/simple-yaml-editor'

export function ServiceCreatePage({ clone = false }: { clone?: boolean }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [searchParams] = useSearchParams()
  const { namespace: namespaceParam, name: editName } = useParams()
  const can = useCan()
  // 克隆路由也有 :name，但保存走创建：名称与命名空间保持可编辑。
  const isEdit = Boolean(editName) && !clone

  const [formData, setFormData] = useState<ServiceFormData>(() => ({
    ...initialData,
    namespace: namespaceParam || searchParams.get('namespace') || 'default',
  }))
  const [editedYaml, setEditedYaml] = useState('')
  // 表单或 YAML 草稿只要离开过初始快照就算「未保存」：切换集群前据此弹确认
  // （登记处见 lib/unsaved-edits）。预填线上对象时会把初值同步过去，
  // 否则一进编辑页就被当成「改过」。
  const [formSnapshot, setFormSnapshot] = useState(() =>
    JSON.stringify({ formData, editedYaml })
  )
  useUnsavedEdits(JSON.stringify({ formData, editedYaml }) !== formSnapshot)
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const pageTitle = isEdit
    ? t('serviceCreate.editPageTitle', 'Service: 编辑')
    : clone && editName
      ? t('serviceCreate.clonePageTitle', {
          name: editName,
          defaultValue: `Service: 从 ${editName} 克隆`,
        })
      : t('serviceCreate.pageTitle', 'Service: 创建')
  usePageTitle(pageTitle)

  // 编辑/克隆模式：读回线上对象预填（纯创建模式下不发请求）。
  const { data: existing } = useResource(
    'services',
    editName || '',
    namespaceParam,
    { enabled: Boolean(editName) }
  )
  useEffect(() => {
    if (!existing) return
    // 克隆：先做通用预处理（剥离服务端字段、改名 <源名>-copy、清理
    // clusterIP / nodePort 等不可复用的字段），再走与编辑相同的反显路径。
    const source = clone
      ? (prepareCloneResource(
          existing,
          'services',
          editName || '',
          `${editName || ''}-copy`
        ) as unknown as Service)
      : existing
    const next = formFromService(source)
    setFormData(next)
    setFormSnapshot(JSON.stringify({ formData: next, editedYaml: '' }))
    // 只在线上对象变化时重填，否则会把正在编辑的内容冲掉。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing])

  // 写入一个已存在的 Service 用的是 update 权限。
  const canCreate = can('services', isEdit ? 'update' : 'create', {
    namespace: formData.namespace,
  })
  const typeOptions = isEdit
    ? allowedServiceTypes(formData.serviceType)
    : allowedServiceTypes('ClusterIP').concat('ExternalName')

  const update = (updates: Partial<ServiceFormData>) =>
    setFormData((prev) => ({ ...prev, ...updates }))

  const currentYaml = useMemo(() => generateServiceYaml(formData), [formData])
  const finalYaml = editedYaml || currentYaml

  const nodePortRange = useNodePortRange()
  const portErrorText = useServicePortErrorText()
  // 端口行的校验与文案都在共享实现里（见 components/service-ports-editor.tsx）。
  const portErrors = useMemo(
    () =>
      servicePortErrorCodes(
        formData.ports,
        formData.serviceType,
        nodePortRange
      ),
    [formData.ports, formData.serviceType, nodePortRange]
  )

  const hasPortErrors = portErrors.size > 0
  const isValid = useMemo(() => {
    if (editedYaml.trim()) {
      try {
        const docs = yaml.loadAll(editedYaml)
        return docs.length > 0 && !!docs[0]
      } catch {
        return false
      }
    }
    if (!formData.name || !formData.namespace) return false
    if (formData.serviceType === 'ExternalName' && !formData.externalName)
      return false
    if (formData.serviceType !== 'ExternalName') {
      if (formData.ports.length === 0 || hasPortErrors) return false
      if (formData.ports.some((p) => !intOrNull(p.port))) return false
    }
    return true
  }, [editedYaml, formData, hasPortErrors])

  const handleCreate = async () => {
    if (!isValid) {
      // 明确指出缺失的字段，让提示条可操作，
      // 而不是笼统地"请补全表单"。
      const firstPortCode =
        formData.serviceType === 'ExternalName'
          ? undefined
          : [...portErrors.values()][0]
      const firstPortError = firstPortCode
        ? portErrorText(firstPortCode)
        : undefined
      const missing: string[] = []
      if (!formData.name.trim()) {
        missing.push(t('serviceCreate.serviceName', '服务名称'))
      }
      if (!formData.namespace.trim()) {
        missing.push(t('workloadWizard.namespace', '命名空间'))
      }
      if (
        formData.serviceType === 'ExternalName' &&
        !formData.externalName.trim()
      ) {
        missing.push(t('serviceCreate.externalName', '外部名称'))
      }
      if (
        formData.serviceType !== 'ExternalName' &&
        formData.ports.some((p) => !intOrNull(p.port))
      ) {
        missing.push(t('serviceCreate.portsTitle', '端口'))
      }
      const message =
        firstPortError ||
        (missing.length
          ? t('workloadWizard.requiredFields', {
              fields: missing.join('、'),
              defaultValue: `「${missing.join('、')}」是必填项。`,
            })
          : t('serviceCreate.invalidForm', '请完善必填信息后再创建'))
      setCreateError(message)
      toast.error(message)
      return
    }
    setIsCreating(true)
    setCreateError(null)
    try {
      if (isEdit && existing) {
        // 编辑：把表单（或手改的 YAML）算出来的 spec 叠到线上对象上，
        // 保住 clusterIP 这类不可变字段与表单没建模的字段。
        const generated = (yaml.load(finalYaml) || {}) as Record<
          string,
          unknown
        >
        await updateResource(
          'services',
          existing.metadata?.name || formData.name,
          formData.namespace,
          mergeServiceUpdate(generated, existing)
        )
        queryClient.invalidateQueries()
        toast.success(t('common.messages.updated', { resource: 'Service' }))
      } else {
        await applyResource(finalYaml, formData.namespace)
        queryClient.invalidateQueries()
        toast.success(t('common.messages.applied', 'Applied successfully'))
      }
      navigate(`/services/${formData.namespace}/${formData.name}`)
    } catch (err) {
      setCreateError(translateError(err, t))
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          aria-label={t('common.actions.backToList', '返回列表')}
          title={t('common.actions.backToList', '返回列表')}
          onClick={() => navigate('/services')}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-bold">{pageTitle}</h1>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <div className="space-y-3 rounded-md border p-3">
            <div className="space-y-1.5">
              <Label className="text-xs">
                {t('workloadWizard.namespace')} *
              </Label>
              <NamespaceSelector
                selectedNamespace={formData.namespace}
                // 编辑时命名空间是身份的一部分，不能改。
                disabled={isEdit}
                handleNamespaceChange={(ns) => {
                  const next = ns || 'default'
                  update({ namespace: next })
                  navigate(`/services/${encodeURIComponent(next)}/create`, {
                    replace: true,
                  })
                }}
                triggerClassName="w-full"
                modal
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">
                {t('serviceCreate.serviceName', '服务名称')} *
              </Label>
              <Input
                value={formData.name}
                onChange={(e) => update({ name: e.target.value })}
                placeholder="my-service"
                className="h-9"
                // 名字是身份的一部分，改名字等于换一个对象。
                disabled={isEdit}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">
                {t('serviceCreate.serviceType', '服务类型')} *
              </Label>
              <Select
                value={formData.serviceType}
                onValueChange={(v) => update({ serviceType: v as ServiceType })}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {typeOptions.map((type) => (
                    <SelectItem key={type} value={type}>
                      {type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {isEdit && typeOptions.length === 1 && (
                <p className="text-xs text-muted-foreground">
                  {t(
                    'serviceCreate.typeImmutableHint',
                    'ExternalName 与其他类型之间不能互相转换，类型已锁定。'
                  )}
                </p>
              )}
            </div>
          </div>

          <div className="space-y-4 rounded-md border p-3 lg:col-span-2">
            {formData.serviceType === 'ExternalName' ? (
              <div className="space-y-1.5">
                <Label className="text-xs">
                  {t('serviceCreate.externalName', '外部名称 (External Name)')}{' '}
                  *
                </Label>
                <Input
                  value={formData.externalName}
                  onChange={(e) => update({ externalName: e.target.value })}
                  placeholder="example.database.com"
                  className="h-9"
                />
                <p className="text-xs text-muted-foreground">
                  {t(
                    'serviceCreate.externalNameHint',
                    'ExternalName 类型的 Service 通过 CNAME 记录指向外部 DNS 名称。'
                  )}
                </p>
              </div>
            ) : (
              <>
                <LabelSelectorEditor
                  title={t('serviceCreate.selectorTitle', '选择器')}
                  hint={t(
                    'serviceCreate.selectorHint',
                    '选择器的键和值用于匹配现有 Pod 上的标签和值。'
                  )}
                  emptyNote={t(
                    'serviceCreate.selectorEmptyNote',
                    '如果没有创建选择器，则必须进行手动锚点。'
                  )}
                  pairs={formData.selector}
                  addLabel={t('common.actions.add', '添加')}
                  namespace={formData.namespace}
                  onChange={(selector) => update({ selector })}
                />
                <div className="space-y-1.5">
                  <Label className="text-xs">
                    {t('serviceCreate.sessionAffinity', '会话保持')}
                  </Label>
                  <Select
                    value={formData.sessionAffinity}
                    onValueChange={(v) =>
                      update({
                        sessionAffinity:
                          v as ServiceFormData['sessionAffinity'],
                      })
                    }
                  >
                    <SelectTrigger className="h-9 w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="None">None</SelectItem>
                      <SelectItem value="ClientIP">ClientIP</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}
          </div>
        </div>

        {formData.serviceType !== 'ExternalName' && (
          <ServicePortsEditor
            ports={formData.ports}
            serviceType={formData.serviceType}
            errors={portErrors}
            onChange={(ports) => update({ ports })}
          />
        )}

        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            {isEdit
              ? t(
                  'serviceCreate.yamlTabEditHint',
                  '这是由上方配置生成的 YAML，可直接编辑。手动编辑后将以该 YAML 为准更新；返回修改表单会重新生成。'
                )
              : t(
                  'workloadWizard.yamlTabHint',
                  '这是由上方配置生成的 YAML，可直接编辑。手动编辑后将以该 YAML 为准创建；返回修改表单会重新生成。'
                )}
          </p>
          <div className="min-h-[300px] rounded-md border">
            <SimpleYamlEditor
              value={finalYaml}
              onChange={(value) => {
                // 表单重新生成 YAML 时 Monaco 会把受控 value
                // 回传；忽略这些回传可以让表单保持权威，
                // 而不是绕经解析器来回转换。
                if (value === finalYaml) return
                setEditedYaml(value || '')
                if (value) {
                  try {
                    const docs =
                      (yaml.loadAll(value) as Array<Record<string, unknown>>) ||
                      []
                    const doc = docs[0]
                    if (doc && doc.kind === 'Service') {
                      const meta = (doc.metadata || {}) as Record<
                        string,
                        unknown
                      >
                      const spec = (doc.spec || {}) as Record<string, unknown>
                      // 选择器位于 spec.selector —— metadata.labels
                      // 是 Service 自身的标签，与它无关。
                      const selectorObj = (spec.selector || {}) as Record<
                        string,
                        string
                      >
                      setFormData((prev) => ({
                        ...prev,
                        name: (meta.name as string) || prev.name,
                        namespace: (meta.namespace as string) || prev.namespace,
                        serviceType:
                          (spec.type as ServiceType) || prev.serviceType,
                        externalName:
                          (spec.externalName as string) || prev.externalName,
                        sessionAffinity:
                          (spec.sessionAffinity as 'None' | 'ClientIP') ||
                          prev.sessionAffinity,
                        selector: Object.entries(selectorObj).map(
                          ([key, v]) => ({
                            key,
                            value: v,
                          })
                        ),
                        ports: (
                          (spec.ports as Array<Record<string, unknown>>) || []
                        ).map((p) => ({
                          name: (p.name as string) || '',
                          port: p.port !== undefined ? String(p.port) : '',
                          targetPort:
                            p.targetPort !== undefined
                              ? String(p.targetPort)
                              : '',
                          nodePort:
                            p.nodePort !== undefined ? String(p.nodePort) : '',
                          protocol:
                            (p.protocol as 'TCP' | 'UDP') || ('TCP' as const),
                        })),
                      }))
                      setEditedYaml('')
                    }
                  } catch {
                    // 解析出错时保留原始编辑
                  }
                }
              }}
              height="400px"
            />
          </div>
        </div>
      </div>

      {createError && (
        <div className="rounded-md border border-destructive/40 border-l-4 border-l-destructive bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {createError}
        </div>
      )}

      {!canCreate && (
        <div className="rounded-md border border-destructive/40 border-l-4 border-l-destructive bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {isEdit
            ? t('serviceCreate.noUpdatePermission', {
                namespace: formData.namespace,
                defaultValue: `你没有权限在命名空间 {{namespace}} 中修改 Service。`,
              })
            : t('serviceCreate.noCreatePermission', {
                namespace: formData.namespace,
                defaultValue: `你没有权限在命名空间 {{namespace}} 中创建 Service。`,
              })}
        </div>
      )}

      <div className="flex items-center justify-end gap-2 border-t pt-3">
        <Button variant="outline" onClick={() => navigate('/services')}>
          {t('common.actions.cancel', '取消')}
        </Button>
        <Button onClick={handleCreate} disabled={isCreating || !canCreate}>
          {isCreating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {isEdit
            ? t('common.actions.save', '保存')
            : t('serviceCreate.createButton', '创建 Service')}
        </Button>
      </div>
    </div>
  )
}

export default ServiceCreatePage
