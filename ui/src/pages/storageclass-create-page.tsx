import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import * as yaml from 'js-yaml'
import { ArrowLeft, Loader2, Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'

import { applyResource, updateResource, useResource } from '@/lib/api'
import {
  commonProvisioners,
  findDuplicateParameterKeys,
  formFromStorageClass,
  generateStorageClassYaml,
  initialData,
  isSimpleTopologies,
  parseAllowedTopologies,
  resolveVolumeBindingMode,
  staticProvisioner,
  storageClassUpdateFromForm,
  type ReclaimPolicy,
  type StorageClassFormData,
  type VolumeBindingMode,
} from '@/lib/storageclass-yaml'
import { useUnsavedEdits } from '@/lib/unsaved-edits'
import { translateError } from '@/lib/utils'
import { useCan } from '@/hooks/use-can'
import { usePageTitle } from '@/hooks/use-page-title'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { CurrentClusterBadge } from '@/components/current-cluster-badge'
import { SimpleYamlEditor } from '@/components/simple-yaml-editor'

export function StorageClassCreatePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { name: editName } = useParams()
  const can = useCan()
  const isEdit = Boolean(editName)

  const [formData, setFormData] = useState<StorageClassFormData>(initialData)
  const [editedYaml, setEditedYaml] = useState('')
  // 只要离开过初始快照就算「未保存」，切换集群前据此弹确认（登记处见 lib/unsaved-edits）。
  const [formSnapshot, setFormSnapshot] = useState(() =>
    JSON.stringify({ formData, editedYaml })
  )
  useUnsavedEdits(JSON.stringify({ formData, editedYaml }) !== formSnapshot)
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const pageTitle = isEdit
    ? t('storageClassCreate.editPageTitle', 'StorageClass：编辑')
    : t('storageClassCreate.pageTitle', 'StorageClass：创建')
  usePageTitle(pageTitle)

  // 编辑模式：读回线上对象预填（只在线上对象变化时重填）。
  const { data: existing } = useResource(
    'storageclasses',
    editName || '',
    undefined,
    { enabled: isEdit }
  )
  useEffect(() => {
    if (!existing) return
    const next = formFromStorageClass(existing)
    setFormData(next)
    setFormSnapshot(JSON.stringify({ formData: next, editedYaml: '' }))
  }, [existing])

  // 拓扑写法复杂到一个 term 带多个表达式时，表单那行简写表达不出来：保持线上原值不动。
  const complexTopologies = Boolean(
    isEdit && existing && !isSimpleTopologies(existing)
  )

  // StorageClass 是集群级资源，没有命名空间可以限定权限范围；改写已存在的对象用 update。
  const canCreate = can('storageclasses', isEdit ? 'update' : 'create')

  const update = (updates: Partial<StorageClassFormData>) =>
    setFormData((prev) => ({ ...prev, ...updates }))

  // 纯静态卷必须用 WaitForFirstConsumer：Immediate 会在 PVC 一创建时就去绑任意可用 PV，
  // 对带 nodeAffinity 的 node-local PV 会绑到 Pod 调度不上去的节点，表现为「PVC 已 Bound
  // 但 Pod 一直 Pending」。所以切到 no-provisioner 时自动改掉，用户仍可手动改回。
  const updateProvisioner = (value: string) =>
    setFormData((prev) => ({
      ...prev,
      provisioner: value,
      volumeBindingMode: resolveVolumeBindingMode(
        value,
        prev.volumeBindingMode
      ),
    }))

  const isStaticProvisioner = formData.provisioner.trim() === staticProvisioner

  const currentYaml = useMemo(
    () => generateStorageClassYaml(formData),
    [formData]
  )
  const finalYaml = editedYaml || currentYaml

  // 同名的参数行在生成 YAML 时会按 key 累加，后面的静默覆盖前面的——用户会以为两行都生效。
  const duplicateParameterKeys = useMemo(
    () => findDuplicateParameterKeys(formData.parameters),
    [formData.parameters]
  )

  // allowedTopologies 写错的行：解析不出来就不能提交，否则会静默丢掉这一行。
  const invalidTopologyLines = useMemo(
    () => parseAllowedTopologies(formData.allowedTopologies).invalidLines,
    [formData.allowedTopologies]
  )

  const isValid = useMemo(() => {
    if (editedYaml.trim()) {
      try {
        const docs = yaml.loadAll(editedYaml)
        return docs.length > 0 && !!docs[0]
      } catch {
        return false
      }
    }
    return (
      !!formData.name.trim() &&
      !!formData.provisioner.trim() &&
      duplicateParameterKeys.size === 0 &&
      invalidTopologyLines.length === 0
    )
  }, [editedYaml, formData, duplicateParameterKeys, invalidTopologyLines])

  const handleCreate = async () => {
    if (!isValid) {
      const missing: string[] = []
      if (!formData.name.trim()) {
        missing.push(t('storageClassCreate.name', '名称'))
      }
      if (!formData.provisioner.trim()) {
        missing.push(t('storageClassCreate.provisioner', 'Provisioner'))
      }
      const duplicated = [...duplicateParameterKeys].join('、')
      const message =
        duplicateParameterKeys.size > 0
          ? t('storageClassCreate.duplicateParameters', {
              keys: duplicated,
              defaultValue: `参数名重复：${duplicated}。同名参数只会保留最后一行，请合并或改名。`,
            })
          : invalidTopologyLines.length > 0
            ? t('storageClassCreate.invalidTopologies', {
                lines: invalidTopologyLines.join('、'),
                defaultValue: `allowedTopologies 写法有误：${invalidTopologyLines.join('、')}。每行形如 topology.kubernetes.io/zone=cn-south-1a。`,
              })
            : missing.length
              ? t('workloadWizard.requiredFields', {
                  fields: missing.join('、'),
                  defaultValue: `「${missing.join('、')}」是必填项。`,
                })
              : t('storageClassCreate.invalidForm', '请完善必填信息后再创建')
      setCreateError(message)
      toast.error(message)
      return
    }

    setIsCreating(true)
    setCreateError(null)
    try {
      // 集群级资源不传命名空间。
      if (isEdit && existing) {
        // 只提交表单里真正可变的那几项，其余从线上对象带过去。
        await updateResource(
          'storageclasses',
          existing.metadata?.name || formData.name,
          undefined,
          storageClassUpdateFromForm(formData, existing, {
            keepExistingTopologies: complexTopologies,
          })
        )
        await queryClient.invalidateQueries({ queryKey: ['storageclasses'] })
        toast.success(
          t('common.messages.updated', { resource: 'StorageClass' })
        )
        navigate(`/storageclasses/${existing.metadata?.name || ''}`)
      } else {
        await applyResource(finalYaml)
        await queryClient.invalidateQueries({ queryKey: ['storageclasses'] })
        toast.success(
          t('storageClassCreate.created', 'StorageClass {{name}} 已创建', {
            name: formData.name.trim(),
          })
        )
        navigate('/storageclasses')
      }
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
          onClick={() => navigate('/storageclasses')}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-bold">{pageTitle}</h1>
        <CurrentClusterBadge />
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <div className="space-y-3 rounded-md border p-3">
            <div className="space-y-1.5">
              <Label className="text-xs">
                {t('storageClassCreate.name', '名称')} *
              </Label>
              <Input
                value={formData.name}
                onChange={(e) => update({ name: e.target.value })}
                placeholder="fast-ssd"
                className="h-9"
                disabled={isEdit}
              />
              <p className="text-xs text-muted-foreground">
                {t(
                  'storageClassCreate.nameHint',
                  '资源名需符合 DNS 子域名规则（小写字母、数字、- 与 .）。'
                )}
              </p>
            </div>

            {/* 不可变字段统一禁用：实测 API 对 provisioner / parameters /
                reclaimPolicy / volumeBindingMode 一律 Forbidden，界面上就别装成能改。
                编辑时提交的值由 storageClassUpdateFromForm 只取可变字段。 */}
            <fieldset disabled={isEdit} className="m-0 min-w-0 border-0 p-0">
              <div className="space-y-1.5">
                <Label className="text-xs">
                  {t('storageClassCreate.provisioner', 'Provisioner')} *
                </Label>
                <Input
                  value={formData.provisioner}
                  onChange={(e) => updateProvisioner(e.target.value)}
                  placeholder="rancher.io/local-path"
                  className="h-9"
                  list="storageclass-provisioners"
                />
                <datalist id="storageclass-provisioners">
                  {commonProvisioners.map((item) => (
                    <option key={item} value={item} />
                  ))}
                </datalist>
                <p className="text-xs text-muted-foreground">
                  {t(
                    'storageClassCreate.provisionerHint',
                    '负责动态供给存储的驱动，例如 rancher.io/local-path、nfs.csi.k8s.io；纯静态卷填 kubernetes.io/no-provisioner。'
                  )}
                </p>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">
                  {t('storageClassCreate.reclaimPolicy', '回收策略')}
                </Label>
                <Select
                  value={formData.reclaimPolicy}
                  onValueChange={(v) =>
                    update({ reclaimPolicy: v as ReclaimPolicy })
                  }
                >
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Delete">Delete</SelectItem>
                    <SelectItem value="Retain">Retain</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {t(
                    'storageClassCreate.reclaimPolicyHint',
                    'Delete：PVC 删除后自动回收底层卷；Retain：保留卷需要人工处理。'
                  )}
                </p>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">
                  {t('storageClassCreate.volumeBindingMode', '卷绑定模式')}
                </Label>
                <Select
                  value={formData.volumeBindingMode}
                  onValueChange={(v) =>
                    update({ volumeBindingMode: v as VolumeBindingMode })
                  }
                >
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Immediate">Immediate</SelectItem>
                    <SelectItem value="WaitForFirstConsumer">
                      WaitForFirstConsumer
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {t(
                    'storageClassCreate.volumeBindingModeHint',
                    'WaitForFirstConsumer 会等到 Pod 调度后再绑定卷，适合本地盘等依赖节点位置的后端。'
                  )}
                </p>
                {isStaticProvisioner && (
                  <p className="text-xs text-muted-foreground">
                    {t(
                      'storageClassCreate.staticProvisionerHint',
                      'no-provisioner 是纯静态卷：已自动改用 WaitForFirstConsumer，否则 PVC 可能被绑到 Pod 调度不上去的节点上（Bound 却一直 Pending）。'
                    )}
                  </p>
                )}
              </div>
            </fieldset>
          </div>

          <div className="space-y-4 rounded-md border p-3 lg:col-span-2">
            {isEdit && (
              <p className="text-xs text-muted-foreground">
                {t(
                  'storageClassCreate.editHint',
                  '编辑时只能改允许扩容、默认类标记、挂载选项与允许的拓扑；Provisioner、参数、回收策略与卷绑定模式创建后不可变，下方已置灰。'
                )}
              </p>
            )}
            {complexTopologies && (
              <p className="text-xs text-destructive">
                {t(
                  'storageClassCreate.complexTopologies',
                  '这个 StorageClass 的 allowedTopologies 在一个 term 里写了多个表达式，表单那行简写表达不出来；保存时会保持它不变，要改请用 YAML 标签页。'
                )}
              </p>
            )}
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="sc-allow-expansion"
                  checked={formData.allowVolumeExpansion}
                  onCheckedChange={(checked) =>
                    update({ allowVolumeExpansion: checked === true })
                  }
                />
                <Label htmlFor="sc-allow-expansion" className="text-xs">
                  {t('storageClassCreate.allowVolumeExpansion', '允许扩容')}
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="sc-default"
                  checked={formData.isDefault}
                  onCheckedChange={(checked) =>
                    update({ isDefault: checked === true })
                  }
                />
                <Label htmlFor="sc-default" className="text-xs">
                  {t('storageClassCreate.isDefault', '设为默认 StorageClass')}
                </Label>
              </div>
              <p className="text-xs text-muted-foreground">
                {t(
                  'storageClassCreate.isDefaultHint',
                  '默认 StorageClass 会影响所有未显式指定 storageClassName 的 PVC；集群里通常只保留一个默认。'
                )}
              </p>
            </div>

            <fieldset disabled={isEdit} className="m-0 min-w-0 border-0 p-0">
              <div className="space-y-2">
                <Label className="text-xs">
                  {t('storageClassCreate.parameters', '参数（parameters）')}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t(
                    'storageClassCreate.parametersHint',
                    '各驱动的参数名不同，例如 nfs.csi.k8s.io 需要 server 与 share。'
                  )}
                </p>
                {formData.parameters.map((row, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <Input
                      value={row.key}
                      onChange={(e) =>
                        update({
                          parameters: formData.parameters.map((item, i) =>
                            i === index
                              ? { ...item, key: e.target.value }
                              : item
                          ),
                        })
                      }
                      placeholder={t('common.fields.key', '键')}
                      aria-invalid={
                        duplicateParameterKeys.has(row.key.trim()) || undefined
                      }
                      className={
                        'h-8 min-w-0 flex-1 ' +
                        (duplicateParameterKeys.has(row.key.trim())
                          ? 'border-destructive'
                          : '')
                      }
                    />
                    <Input
                      value={row.value}
                      onChange={(e) =>
                        update({
                          parameters: formData.parameters.map((item, i) =>
                            i === index
                              ? { ...item, value: e.target.value }
                              : item
                          ),
                        })
                      }
                      placeholder={t('common.fields.value', '值')}
                      className="h-8 min-w-0 flex-1"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      aria-label={t('common.actions.delete', '删除')}
                      disabled={formData.parameters.length === 1}
                      onClick={() =>
                        update({
                          parameters: formData.parameters.filter(
                            (_, i) => i !== index
                          ),
                        })
                      }
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
                {duplicateParameterKeys.size > 0 && (
                  <p className="text-xs text-destructive">
                    {t('storageClassCreate.duplicateParameters', {
                      keys: [...duplicateParameterKeys].join('、'),
                      defaultValue:
                        '参数名重复：{{keys}}。同名参数只会保留最后一行，请合并或改名。',
                    })}
                  </p>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() =>
                    update({
                      parameters: [
                        ...formData.parameters,
                        { key: '', value: '' },
                      ],
                    })
                  }
                >
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  {t('storageClassCreate.addParameter', '添加参数')}
                </Button>
              </div>
            </fieldset>

            <div className="space-y-1.5">
              <Label className="text-xs">
                {t('storageClassCreate.mountOptions', '挂载选项')}
              </Label>
              <Input
                value={formData.mountOptions}
                onChange={(e) => update({ mountOptions: e.target.value })}
                placeholder="noatime, nodiratime"
                className="h-9"
              />
              <p className="text-xs text-muted-foreground">
                {t(
                  'storageClassCreate.mountOptionsHint',
                  '以逗号分隔，直接写入挂载参数（mountOptions）。'
                )}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">
                {t(
                  'storageClassCreate.allowedTopologies',
                  '允许的拓扑（可选）'
                )}
              </Label>
              <Textarea
                value={formData.allowedTopologies}
                onChange={(e) => update({ allowedTopologies: e.target.value })}
                placeholder="topology.kubernetes.io/zone=cn-south-1a"
                rows={2}
                className={
                  'font-mono text-xs ' +
                  (invalidTopologyLines.length > 0 ? 'border-destructive' : '')
                }
              />
              <p className="text-xs text-muted-foreground">
                {t(
                  'storageClassCreate.allowedTopologiesHint',
                  '每行一条，写成 键=值1,值2（例如 topology.kubernetes.io/zone=cn-south-1a）。留空表示不限制；一个 term 里要写多个表达式时请用下面的 YAML 编辑器。'
                )}
              </p>
              {invalidTopologyLines.length > 0 && (
                <p className="text-xs text-destructive">
                  {t('storageClassCreate.invalidTopologies', {
                    lines: invalidTopologyLines.join('、'),
                    defaultValue: `写法有误：${invalidTopologyLines.join('、')}。每行形如 topology.kubernetes.io/zone=cn-south-1a。`,
                  })}
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            {isEdit
              ? t(
                  'storageClassCreate.yamlTabEditHint',
                  '这是由上方配置生成的 YAML。编辑模式下保存的是表单里的可变字段，YAML 仅供查看；要改不可变字段请用详情页的 YAML 标签页。'
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
                // 表单重新生成 YAML 时编辑器会把受控值回传，忽略它以免表单失去权威。
                if (value === finalYaml) return
                setEditedYaml(value || '')
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
          {t(
            'storageClassCreate.noCreatePermission',
            '你没有创建 StorageClass 的权限。'
          )}
        </div>
      )}

      <div className="flex items-center justify-end gap-2 border-t pt-3">
        <Button variant="outline" onClick={() => navigate('/storageclasses')}>
          {t('common.actions.cancel', '取消')}
        </Button>
        <Button onClick={handleCreate} disabled={isCreating || !canCreate}>
          {isCreating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {isEdit
            ? t('common.actions.save', '保存')
            : t('storageClassCreate.createButton', '创建 StorageClass')}
        </Button>
      </div>
    </div>
  )
}

export default StorageClassCreatePage
