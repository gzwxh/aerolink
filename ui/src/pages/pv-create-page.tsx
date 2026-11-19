import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import * as yaml from 'js-yaml'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router-dom'
import { toast } from 'sonner'

import {
  applyResource,
  updateResource,
  useResource,
  useResources,
} from '@/lib/api'
import { useClusterNavigate } from '@/lib/cluster-path'
import {
  accessModeOptions,
  capacityPattern,
  formFromPV,
  generatePVYaml,
  hasPartialClaimRef,
  hostPathTypeOptions,
  initialData,
  pvUpdateFromForm,
  reclaimPolicyOptions,
  volumeSourceOf,
  type PVFormData,
  type ReclaimPolicy,
  type VolumeMode,
  type VolumeSourceType,
} from '@/lib/pv-yaml'
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
import { CurrentClusterBadge } from '@/components/current-cluster-badge'
import { SimpleYamlEditor } from '@/components/simple-yaml-editor'

export function PVCreatePage() {
  const { t } = useTranslation()
  const navigate = useClusterNavigate()
  const queryClient = useQueryClient()
  const { name: editName } = useParams()
  const can = useCan()
  const isEdit = Boolean(editName)

  const [formData, setFormData] = useState<PVFormData>(initialData)
  const [editedYaml, setEditedYaml] = useState('')
  const [formSnapshot, setFormSnapshot] = useState(() =>
    JSON.stringify({ formData, editedYaml })
  )
  useUnsavedEdits(JSON.stringify({ formData, editedYaml }) !== formSnapshot)
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const pageTitle = isEdit
    ? t('pvCreate.editPageTitle', 'PersistentVolume：编辑')
    : t('pvCreate.pageTitle', 'PersistentVolume：创建')
  usePageTitle(pageTitle)

  // 编辑模式：读回线上对象预填（只在线上对象变化时重填，免得冲掉正在编辑的内容）。
  const { data: existing } = useResource(
    'persistentvolumes',
    editName || '',
    undefined,
    { enabled: isEdit }
  )
  useEffect(() => {
    if (!existing) return
    const next = formFromPV(existing)
    setFormData(next)
    setFormSnapshot(JSON.stringify({ formData: next, editedYaml: '' }))
  }, [existing])

  // 集群级资源，没有命名空间可限定权限范围；改写已存在的对象用的是 update。
  const canCreate = can('persistentvolumes', isEdit ? 'update' : 'create')

  // 线上卷的来源类型；表单只支持四种，其余（rbd、iscsi…）在编辑模式下只能提示去 YAML 改。
  const liveSource = existing ? volumeSourceOf(existing) : null
  const unsupportedSource = isEdit && existing && liveSource === null

  // 供「存储类」下拉选择已有 StorageClass（也可手填）。
  const { data: storageClasses = [] } = useResources('storageclasses')

  const update = (updates: Partial<PVFormData>) =>
    setFormData((prev) => ({ ...prev, ...updates }))

  const currentYaml = useMemo(() => generatePVYaml(formData), [formData])
  const finalYaml = editedYaml || currentYaml

  const fieldError = useMemo(() => {
    const errors: Record<string, string> = {}
    if (
      formData.capacity.trim() &&
      !capacityPattern.test(formData.capacity.trim())
    ) {
      errors.capacity = t(
        'pvCreate.capacityInvalid',
        '容量格式形如 10Gi、500Mi、1Ti'
      )
    }
    if (formData.accessModes.length === 0) {
      errors.accessModes = t(
        'pvCreate.accessModesRequired',
        '至少选择一种访问模式'
      )
    }
    if (hasPartialClaimRef(formData)) {
      errors.claimRef = t(
        'pvCreate.claimRefIncomplete',
        '预绑定需要同时填写命名空间与 PVC 名称'
      )
    }
    switch (formData.sourceType) {
      case 'hostPath':
        if (!formData.hostPathPath.trim()) {
          errors.source = t('pvCreate.hostPathRequired', '请填写宿主节点路径')
        }
        break
      case 'nfs':
        if (!formData.nfsServer.trim() || !formData.nfsPath.trim()) {
          errors.source = t(
            'pvCreate.nfsRequired',
            'NFS 需要服务器地址与共享路径'
          )
        }
        break
      case 'local':
        if (!formData.localPath.trim()) {
          errors.source = t('pvCreate.localPathRequired', '请填写本地卷路径')
        } else if (!formData.localNodeName.trim()) {
          errors.source = t(
            'pvCreate.localNodeRequired',
            '本地卷必须指定所在节点（用于生成节点亲和）'
          )
        }
        break
      case 'csi':
        if (!formData.csiDriver.trim() || !formData.csiVolumeHandle.trim()) {
          errors.source = t(
            'pvCreate.csiRequired',
            'CSI 需要驱动名与卷标识（volumeHandle）'
          )
        }
        break
    }
    return errors
  }, [formData, t])

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
      !!formData.capacity.trim() &&
      Object.keys(fieldError).length === 0
    )
  }, [editedYaml, fieldError, formData.capacity, formData.name])

  const handleCreate = async () => {
    if (!isValid) {
      const missing: string[] = []
      if (!formData.name.trim()) {
        missing.push(t('pvCreate.name', '名称'))
      }
      if (!formData.capacity.trim()) {
        missing.push(t('pvCreate.capacity', '容量'))
      }
      const firstError = Object.values(fieldError)[0]
      const message =
        firstError ||
        (missing.length
          ? t('workloadWizard.requiredFields', {
              fields: missing.join('、'),
              defaultValue: `「${missing.join('、')}」是必填项。`,
            })
          : t('pvCreate.invalidForm', '请完善必填信息后再创建'))
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
          'persistentvolumes',
          existing.metadata?.name || formData.name,
          undefined,
          pvUpdateFromForm(formData, existing)
        )
        await queryClient.invalidateQueries({ queryKey: ['persistentvolumes'] })
        toast.success(
          t('common.messages.updated', { resource: 'PersistentVolume' })
        )
        navigate(`/persistentvolumes/${existing.metadata?.name || ''}`)
      } else {
        await applyResource(finalYaml)
        await queryClient.invalidateQueries({ queryKey: ['persistentvolumes'] })
        toast.success(
          t('pvCreate.created', 'PersistentVolume {{name}} 已创建', {
            name: formData.name.trim(),
          })
        )
        navigate('/persistentvolumes')
      }
    } catch (err) {
      setCreateError(translateError(err, t))
    } finally {
      setIsCreating(false)
    }
  }

  const toggleAccessMode = (mode: string) => {
    update({
      accessModes: formData.accessModes.includes(mode)
        ? formData.accessModes.filter((item) => item !== mode)
        : [...formData.accessModes, mode],
    })
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
          onClick={() => navigate('/persistentvolumes')}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-bold">{pageTitle}</h1>
        {!isEdit && <CurrentClusterBadge />}
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <div className="space-y-3 rounded-md border p-3">
            <div className="space-y-1.5">
              <Label className="text-xs">{t('pvCreate.name', '名称')} *</Label>
              <Input
                value={formData.name}
                onChange={(e) => update({ name: e.target.value })}
                placeholder="pv-data-01"
                className="h-9"
                disabled={isEdit}
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">
                {t('pvCreate.capacity', '容量')} *
              </Label>
              <Input
                value={formData.capacity}
                onChange={(e) => update({ capacity: e.target.value })}
                placeholder="10Gi"
                className={
                  'h-9 ' + (fieldError.capacity ? 'border-destructive' : '')
                }
              />
              <p className="text-xs text-muted-foreground">
                {t(
                  'pvCreate.capacityHint',
                  '支持 Ki/Mi/Gi/Ti 等单位，例如 10Gi；不带单位按字节解释（填 10 就是 10 字节）。'
                )}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">
                {t('pvCreate.accessModes', '访问模式')} *
              </Label>
              <div className="space-y-1.5">
                {accessModeOptions.map((mode) => (
                  <div key={mode} className="flex items-center gap-2">
                    <Checkbox
                      id={`pv-access-${mode}`}
                      checked={formData.accessModes.includes(mode)}
                      onCheckedChange={() => toggleAccessMode(mode)}
                    />
                    <Label
                      htmlFor={`pv-access-${mode}`}
                      className="text-xs font-normal"
                    >
                      {mode}
                    </Label>
                  </div>
                ))}
              </div>
              {fieldError.accessModes && (
                <p className="text-xs text-destructive">
                  {fieldError.accessModes}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">
                {t('pvCreate.reclaimPolicy', '回收策略')}
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
                  {reclaimPolicyOptions.map((policy) => (
                    <SelectItem key={policy} value={policy}>
                      {policy}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t(
                  'pvCreate.reclaimPolicyHint',
                  'Retain 保留底层数据，Delete 随 PVC 释放而删除卷。'
                )}
              </p>
            </div>
          </div>

          <div className="space-y-4 rounded-md border p-3 lg:col-span-2">
            {isEdit && (
              <p className="text-xs text-muted-foreground">
                {t(
                  'pvCreate.editHint',
                  '编辑时只能改容量（只增）、访问模式、回收策略与挂载参数；卷来源、卷模式、存储类与预绑定创建后不可变，下方已置灰。'
                )}
              </p>
            )}
            {unsupportedSource && (
              <p className="text-xs text-destructive">
                {t(
                  'pvCreate.unsupportedSource',
                  '这个卷的来源类型不在表单支持范围内（hostPath / local / nfs / csi），下方来源字段无法显示；如需修改请用「查看 YAML」标签页。'
                )}
              </p>
            )}
            {/* 不可变字段统一禁用：置灰比藏起来好——值还能看见，也不会让人白填一遍。
                编辑时提交的值由 pvUpdateFromForm 只取可变字段，这里的输入不会进请求体。 */}
            <fieldset disabled={isEdit} className="m-0 min-w-0 border-0 p-0">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-xs">
                    {t('pvCreate.storageClassName', '存储类')}
                  </Label>
                  <Select
                    value={formData.storageClassName || '__none__'}
                    onValueChange={(v) =>
                      update({
                        storageClassName: v === '__none__' ? '' : v,
                      })
                    }
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">
                        {t('pvCreate.storageClassNone', '（不指定）')}
                      </SelectItem>
                      {storageClasses.map((sc) => (
                        <SelectItem
                          key={sc.metadata?.name}
                          value={sc.metadata?.name || ''}
                        >
                          {sc.metadata?.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">
                    {t('pvCreate.volumeMode', '卷模式')}
                  </Label>
                  <Select
                    value={formData.volumeMode || '__none__'}
                    onValueChange={(v) =>
                      update({
                        volumeMode: v === '__none__' ? '' : (v as VolumeMode),
                      })
                    }
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Filesystem">Filesystem</SelectItem>
                      <SelectItem value="Block">Block</SelectItem>
                      <SelectItem value="__none__">
                        {t('pvCreate.volumeModeDefault', '（默认）')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </fieldset>

            <div className="space-y-1.5">
              <Label className="text-xs">
                {t('pvCreate.mountOptions', '挂载参数')}
              </Label>
              <Input
                value={formData.mountOptions}
                onChange={(e) => update({ mountOptions: e.target.value })}
                placeholder="hard, nfsvers=4.1"
                className="h-9"
              />
              <p className="text-xs text-muted-foreground">
                {t(
                  'pvCreate.mountOptionsHint',
                  '以逗号或换行分隔，直接写入挂载参数（mountOptions）。'
                )}
              </p>
            </div>

            <fieldset disabled={isEdit} className="m-0 min-w-0 border-0 p-0">
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">
                    {t('pvCreate.sourceType', '卷来源')} *
                  </Label>
                  <Select
                    value={formData.sourceType}
                    onValueChange={(v) =>
                      update({ sourceType: v as VolumeSourceType })
                    }
                  >
                    <SelectTrigger className="h-9 w-full md:w-72">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="hostPath">
                        HostPath（节点本地目录）
                      </SelectItem>
                      <SelectItem value="local">Local（本地卷）</SelectItem>
                      <SelectItem value="nfs">NFS（网络文件系统）</SelectItem>
                      <SelectItem value="csi">CSI（存储驱动）</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {formData.sourceType === 'hostPath' && (
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label className="text-xs">
                        {t('pvCreate.hostPathPath', '节点路径')} *
                      </Label>
                      <Input
                        value={formData.hostPathPath}
                        onChange={(e) =>
                          update({ hostPathPath: e.target.value })
                        }
                        placeholder="/data/volumes/pv-data-01"
                        className="h-9"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">
                        {t('pvCreate.hostPathType', '路径类型')}
                      </Label>
                      <Select
                        value={formData.hostPathType || '__none__'}
                        onValueChange={(v) =>
                          update({ hostPathType: v === '__none__' ? '' : v })
                        }
                      >
                        <SelectTrigger className="h-9">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {hostPathTypeOptions.map((type) => (
                            <SelectItem
                              key={type || '__none__'}
                              value={type || '__none__'}
                            >
                              {type ||
                                t('pvCreate.hostPathTypeNone', '（不指定）')}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )}

                {formData.sourceType === 'local' && (
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label className="text-xs">
                        {t('pvCreate.localPath', '本地路径')} *
                      </Label>
                      <Input
                        value={formData.localPath}
                        onChange={(e) => update({ localPath: e.target.value })}
                        placeholder="/mnt/disks/ssd1"
                        className="h-9"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">
                        {t('pvCreate.localNodeName', '所在节点')} *
                      </Label>
                      <Input
                        value={formData.localNodeName}
                        onChange={(e) =>
                          update({ localNodeName: e.target.value })
                        }
                        placeholder="node-1"
                        className="h-9"
                      />
                      <p className="text-xs text-muted-foreground">
                        {t(
                          'pvCreate.localNodeHint',
                          '用于生成 nodeAffinity（kubernetes.io/hostname）。'
                        )}
                      </p>
                    </div>
                  </div>
                )}

                {formData.sourceType === 'nfs' && (
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label className="text-xs">
                        {t('pvCreate.nfsServer', 'NFS 服务器')} *
                      </Label>
                      <Input
                        value={formData.nfsServer}
                        onChange={(e) => update({ nfsServer: e.target.value })}
                        placeholder="10.0.0.10"
                        className="h-9"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">
                        {t('pvCreate.nfsPath', '共享路径')} *
                      </Label>
                      <Input
                        value={formData.nfsPath}
                        onChange={(e) => update({ nfsPath: e.target.value })}
                        placeholder="/exports/data"
                        className="h-9"
                      />
                    </div>
                    <div className="flex items-center gap-2 md:col-span-2">
                      <Checkbox
                        id="pv-nfs-readonly"
                        checked={formData.nfsReadOnly}
                        onCheckedChange={(checked) =>
                          update({ nfsReadOnly: checked === true })
                        }
                      />
                      <Label
                        htmlFor="pv-nfs-readonly"
                        className="text-xs font-normal"
                      >
                        {t('pvCreate.readOnly', '只读挂载')}
                      </Label>
                    </div>
                  </div>
                )}

                {formData.sourceType === 'csi' && (
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label className="text-xs">
                        {t('pvCreate.csiDriver', '驱动名称')} *
                      </Label>
                      <Input
                        value={formData.csiDriver}
                        onChange={(e) => update({ csiDriver: e.target.value })}
                        placeholder="disk.csi.azure.com"
                        className="h-9"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">
                        {t('pvCreate.csiVolumeHandle', '卷标识')} *
                      </Label>
                      <Input
                        value={formData.csiVolumeHandle}
                        onChange={(e) =>
                          update({ csiVolumeHandle: e.target.value })
                        }
                        placeholder="vol-0123456789"
                        className="h-9"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">
                        {t('pvCreate.csiFsType', '文件系统类型')}
                      </Label>
                      <Input
                        value={formData.csiFsType}
                        onChange={(e) => update({ csiFsType: e.target.value })}
                        placeholder="ext4"
                        className="h-9"
                      />
                    </div>
                    <div className="flex items-center gap-2 md:pt-6">
                      <Checkbox
                        id="pv-csi-readonly"
                        checked={formData.csiReadOnly}
                        onCheckedChange={(checked) =>
                          update({ csiReadOnly: checked === true })
                        }
                      />
                      <Label
                        htmlFor="pv-csi-readonly"
                        className="text-xs font-normal"
                      >
                        {t('pvCreate.readOnly', '只读挂载')}
                      </Label>
                    </div>
                  </div>
                )}

                {fieldError.source && (
                  <p className="text-xs text-destructive">
                    {fieldError.source}
                  </p>
                )}
              </div>

              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">
                    {t('pvCreate.claimRef', '预绑定到 PVC（可选）')}
                  </Label>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <Input
                      value={formData.claimRefNamespace}
                      onChange={(e) =>
                        update({ claimRefNamespace: e.target.value })
                      }
                      placeholder={t('pvCreate.claimRefNamespace', '命名空间')}
                      className={
                        'h-9 ' +
                        (fieldError.claimRef ? 'border-destructive' : '')
                      }
                    />
                    <Input
                      value={formData.claimRefName}
                      onChange={(e) => update({ claimRefName: e.target.value })}
                      placeholder={t('pvCreate.claimRefName', 'PVC 名称')}
                      className={
                        'h-9 ' +
                        (fieldError.claimRef ? 'border-destructive' : '')
                      }
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t(
                      'pvCreate.claimRefHint',
                      '填上命名空间与 PVC 名称，就把这个卷锁定给该声明（claimRef）。两个要一起填；留空则不预绑定。'
                    )}
                  </p>
                  {fieldError.claimRef && (
                    <p className="text-xs text-destructive">
                      {fieldError.claimRef}
                    </p>
                  )}
                </div>
              </div>
            </fieldset>
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            {isEdit
              ? t(
                  'pvCreate.yamlTabEditHint',
                  '这是由上方配置生成的 YAML。编辑模式下保存的是表单里的可变字段，YAML 仅供查看；要改不可变字段请用「查看 YAML」标签页。'
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
          {isEdit
            ? t(
                'pvCreate.noUpdatePermission',
                '你没有修改 PersistentVolume 的权限。'
              )
            : t(
                'pvCreate.noCreatePermission',
                '你没有创建 PersistentVolume 的权限。'
              )}
        </div>
      )}

      <div className="flex items-center justify-end gap-2 border-t pt-3">
        <Button
          variant="outline"
          onClick={() => navigate('/persistentvolumes')}
        >
          {t('common.actions.cancel', '取消')}
        </Button>
        <Button onClick={handleCreate} disabled={isCreating || !canCreate}>
          {isCreating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {isEdit
            ? t('common.actions.save', '保存')
            : t('pvCreate.createButton', '创建 PersistentVolume')}
        </Button>
      </div>
    </div>
  )
}

export default PVCreatePage
