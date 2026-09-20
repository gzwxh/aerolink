import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import * as yaml from 'js-yaml'
import { ArrowLeft, Loader2, Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

import { applyResource } from '@/lib/api'
import { useUnsavedEdits } from '@/lib/unsaved-edits'
import { translateError } from '@/lib/utils'
import { useCan } from '@/hooks/use-can'
import { usePageTitle } from '@/hooks/use-page-title'
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
import { SimpleYamlEditor } from '@/components/simple-yaml-editor'

type ServiceType = 'ClusterIP' | 'NodePort' | 'LoadBalancer' | 'ExternalName'

interface PortRow {
  name: string
  port: string
  targetPort: string
  nodePort: string
  protocol: 'TCP' | 'UDP'
}

interface ServiceFormData {
  name: string
  namespace: string
  serviceType: ServiceType
  externalName: string
  sessionAffinity: 'None' | 'ClientIP'
  selector: Array<{ key: string; value: string }>
  ports: PortRow[]
}

const initialData: ServiceFormData = {
  name: '',
  namespace: 'default',
  serviceType: 'ClusterIP',
  externalName: '',
  sessionAffinity: 'None',
  selector: [{ key: 'app', value: '' }],
  ports: [
    { name: '', port: '80', targetPort: '', nodePort: '', protocol: 'TCP' },
  ],
}

const intOrNull = (v: string) => {
  if (!v.trim()) return undefined
  const n = Number(v)
  return Number.isNaN(n) ? undefined : n
}

function generateServiceYaml(d: ServiceFormData): string {
  const selector = d.selector.reduce<Record<string, string>>((acc, s) => {
    if (s.key.trim() && s.value.trim()) acc[s.key.trim()] = s.value.trim()
    return acc
  }, {})

  const metadata: Record<string, unknown> = {
    name: d.name,
    namespace: d.namespace,
  }
  const spec: Record<string, unknown> = { type: d.serviceType }

  if (d.serviceType === 'ExternalName') {
    spec.externalName = d.externalName
  } else {
    if (Object.keys(selector).length > 0) spec.selector = selector
    if (d.sessionAffinity !== 'None') spec.sessionAffinity = d.sessionAffinity
    const ports = d.ports
      .map((p) => {
        const port = intOrNull(p.port)
        if (!port) return null
        const targetPort = intOrNull(p.targetPort) ?? port
        const nodePort =
          d.serviceType === 'NodePort' ? intOrNull(p.nodePort) : undefined
        return {
          ...(p.name.trim() && { name: p.name.trim() }),
          port,
          targetPort,
          protocol: p.protocol,
          ...(nodePort !== undefined && { nodePort }),
        }
      })
      .filter(Boolean)
    if (ports.length > 0) spec.ports = ports
  }

  return yaml.dump(
    { apiVersion: 'v1', kind: 'Service', metadata, spec },
    { indent: 2, noRefs: true }
  )
}

export function ServiceCreatePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [searchParams] = useSearchParams()
  const { namespace: namespaceParam } = useParams()
  const can = useCan()

  const [formData, setFormData] = useState<ServiceFormData>(() => ({
    ...initialData,
    namespace: namespaceParam || searchParams.get('namespace') || 'default',
  }))
  const [editedYaml, setEditedYaml] = useState('')
  // 表单或 YAML 草稿只要离开过初始快照就算「未保存」：切换集群前据此弹确认
  // （登记处见 lib/unsaved-edits）。
  const [formSnapshot] = useState(() =>
    JSON.stringify({ formData, editedYaml })
  )
  useUnsavedEdits(JSON.stringify({ formData, editedYaml }) !== formSnapshot)
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const pageTitle = t('serviceCreate.pageTitle', 'Service: 创建')
  usePageTitle(pageTitle)

  const canCreate = can('services', 'create', { namespace: formData.namespace })

  const update = (updates: Partial<ServiceFormData>) =>
    setFormData((prev) => ({ ...prev, ...updates }))

  const currentYaml = useMemo(() => generateServiceYaml(formData), [formData])
  const finalYaml = editedYaml || currentYaml

  const portErrors = useMemo(() => {
    const errors = new Map<number, string>()
    formData.ports.forEach((p, i) => {
      const port = intOrNull(p.port)
      if (port === undefined || port < 1 || port > 65535) {
        errors.set(
          i,
          t('serviceCreate.portRangeError', '端口必须为 1-65535 的数字')
        )
        return
      }
      const target = p.targetPort.trim() ? intOrNull(p.targetPort) : undefined
      if (target !== undefined && (target < 1 || target > 65535)) {
        errors.set(
          i,
          t('serviceCreate.targetPortRangeError', '目标端口必须为 1-65535')
        )
        return
      }
      if (formData.serviceType === 'NodePort' && p.nodePort.trim()) {
        const np = intOrNull(p.nodePort)
        if (np === undefined || np < 30000 || np > 32767) {
          errors.set(
            i,
            t('serviceCreate.nodePortRangeError', 'NodePort 必须为 30000-32767')
          )
        }
      }
    })
    return errors
  }, [formData.ports, formData.serviceType, t])

  const hasPortErrors = [...portErrors.values()].length > 0
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
      const firstPortError =
        formData.serviceType === 'ExternalName'
          ? undefined
          : [...portErrors.values()][0]
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
      await applyResource(finalYaml, formData.namespace)
      queryClient.invalidateQueries()
      toast.success(t('common.messages.applied', 'Applied successfully'))
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
                  <SelectItem value="ClusterIP">ClusterIP</SelectItem>
                  <SelectItem value="NodePort">NodePort</SelectItem>
                  <SelectItem value="LoadBalancer">LoadBalancer</SelectItem>
                  <SelectItem value="ExternalName">ExternalName</SelectItem>
                </SelectContent>
              </Select>
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
          <div className="space-y-2 rounded-md border p-3">
            <h4 className="text-sm font-semibold">
              {t('serviceCreate.portsTitle', '端口')}
            </h4>
            {formData.ports.map((port, index) => (
              <div key={index} className="space-y-1">
                {/* A flex row keeps the port fields equally wide, and makes
                    room for the NodePort field without wrapping the remove
                    button onto a second line. */}
                <div className="flex items-center gap-2">
                  <Input
                    value={port.name}
                    onChange={(e) =>
                      update({
                        ports: formData.ports.map((p, i) =>
                          i === index ? { ...p, name: e.target.value } : p
                        ),
                      })
                    }
                    placeholder={t('serviceCreate.portName', '端口名称')}
                    className="h-8 min-w-0 flex-1"
                  />
                  <Input
                    type="number"
                    min={1}
                    max={65535}
                    value={port.port}
                    onChange={(e) =>
                      update({
                        ports: formData.ports.map((p, i) =>
                          i === index ? { ...p, port: e.target.value } : p
                        ),
                      })
                    }
                    placeholder={t('serviceCreate.port', '端口 *')}
                    className={
                      'h-8 min-w-0 flex-1 ' +
                      (portErrors.has(index) &&
                      (intOrNull(port.port) === undefined ||
                        intOrNull(port.port)! < 1 ||
                        intOrNull(port.port)! > 65535)
                        ? 'border-destructive'
                        : '')
                    }
                  />
                  <Input
                    type="number"
                    value={port.targetPort}
                    onChange={(e) =>
                      update({
                        ports: formData.ports.map((p, i) =>
                          i === index ? { ...p, targetPort: e.target.value } : p
                        ),
                      })
                    }
                    placeholder={t('serviceCreate.targetPort', '目标端口')}
                    className="h-8 min-w-0 flex-1"
                  />
                  {formData.serviceType === 'NodePort' && (
                    <Input
                      type="number"
                      min={30000}
                      max={32767}
                      value={port.nodePort}
                      onChange={(e) =>
                        update({
                          ports: formData.ports.map((p, i) =>
                            i === index ? { ...p, nodePort: e.target.value } : p
                          ),
                        })
                      }
                      placeholder={t(
                        'serviceCreate.nodePortPlaceholder',
                        'NodePort 30000-32767'
                      )}
                      className="h-8 min-w-0 flex-1"
                    />
                  )}
                  <Select
                    value={port.protocol}
                    onValueChange={(v) =>
                      update({
                        ports: formData.ports.map((p, i) =>
                          i === index
                            ? { ...p, protocol: v as 'TCP' | 'UDP' }
                            : p
                        ),
                      })
                    }
                  >
                    <SelectTrigger className="h-8 w-24 shrink-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="TCP">TCP</SelectItem>
                      <SelectItem value="UDP">UDP</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() =>
                      update({
                        ports: formData.ports.filter((_, i) => i !== index),
                      })
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {portErrors.has(index) && (
                  <p className="text-xs text-destructive">
                    {portErrors.get(index)}
                  </p>
                )}
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() =>
                update({
                  ports: [
                    ...formData.ports,
                    {
                      name: '',
                      port: '80',
                      targetPort: '',
                      nodePort: '',
                      protocol: 'TCP',
                    },
                  ],
                })
              }
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t('serviceCreate.addPort', '添加端口')}
            </Button>
          </div>
        )}

        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            {t(
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
          {t('serviceCreate.noCreatePermission', {
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
          {t('serviceCreate.createButton', '创建 Service')}
        </Button>
      </div>
    </div>
  )
}

export default ServiceCreatePage
