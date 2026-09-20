import { useEffect, useRef, useState } from 'react'
import { IconAlertCircle } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import * as YAML from 'js-yaml'
import { ConfigMap } from 'kubernetes-types/core/v1'
import { ArrowLeft, Loader2, Upload } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

import { applyResource, useResource } from '@/lib/api'
import { getClusterScopedStorageKey } from '@/lib/current-cluster'
import {
  DESCRIPTION_ANNOTATION,
  K8S_DATA_KEY_PATTERN,
  K8S_META_KEY_PATTERN,
  K8S_RESOURCE_NAME_PATTERN,
  RESERVED_CREATE_NAMES,
  resolveCreateNamespace,
} from '@/lib/k8s'
import { useUnsavedEdits } from '@/lib/unsaved-edits'
import { cn, translateError } from '@/lib/utils'
import { useCan } from '@/hooks/use-can'
import { usePageTitle } from '@/hooks/use-page-title'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsTrigger } from '@/components/ui/tabs'
import {
  AddButton,
  readAsBase64,
  readAsText,
  toRecord,
  ValueRows,
  type DataRow,
} from '@/components/key-value-rows'
import { NamespaceSelector } from '@/components/selector/namespace-selector'
import { SimpleYamlEditor } from '@/components/simple-yaml-editor'
import { TabStrip } from '@/components/tab-strip'

type EditorTab = 'data' | 'binary' | 'meta' | 'yaml'

const EDITOR_TABS: EditorTab[] = ['data', 'binary', 'meta', 'yaml']

const parseConfigMapYaml = (text: string): ConfigMap | null => {
  try {
    const doc = YAML.load(text) as ConfigMap | undefined
    if (!doc || typeof doc !== 'object' || doc.kind !== 'ConfigMap') {
      return null
    }
    return doc
  } catch {
    return null
  }
}

/**
 * ConfigMap 的表单页：没有 `:name` 时是创建，有 `:name`（路由 `…/:namespace/:name/edit`）
 * 时读出线上对象预填，保存即更新（同一套表单，避免创建与修改两套界面走偏）。
 */
/** 把线上对象的 map 字段转成键/值行；空对象给一行空行，保证表格不为空。 */
function rowsFromRecord(record: Record<string, string> | undefined): DataRow[] {
  const rows = Object.entries(record || {}).map(([key, value]) => ({
    key,
    value,
  }))
  return rows.length > 0 ? rows : [{ key: '', value: '' }]
}

export function ConfigMapCreatePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { namespace: namespaceParam, name: editName } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const can = useCan()
  const isEdit = Boolean(editName)

  const pageTitle = isEdit
    ? t('configmapCreate.editPageTitle', 'ConfigMap: 编辑')
    : t('configmapCreate.pageTitle', 'ConfigMap: 创建')
  usePageTitle(pageTitle)

  const [namespace, setNamespace] = useState(() =>
    resolveCreateNamespace(
      namespaceParam,
      searchParams.get('namespace'),
      sessionStorage.getItem(getClusterScopedStorageKey('selectedNamespace')),
      localStorage.getItem(getClusterScopedStorageKey('selectedNamespace'))
    )
  )
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [tab, setTab] = useState<EditorTab>(() => {
    const requested = searchParams.get('tab') as EditorTab | null
    return requested && EDITOR_TABS.includes(requested) ? requested : 'data'
  })
  const [dataRows, setDataRows] = useState<DataRow[]>([{ key: '', value: '' }])
  const [binaryRows, setBinaryRows] = useState<DataRow[]>([
    { key: '', value: '', fileName: '' },
  ])
  const [labels, setLabels] = useState<DataRow[]>([{ key: '', value: '' }])
  const [annotations, setAnnotations] = useState<DataRow[]>([
    { key: '', value: '' },
  ])
  /** 手工编辑的 YAML；设置后优先于生成的 manifest。 */
  const [editedYaml, setEditedYaml] = useState('')
  // 表单内容（不含命名空间选择）只要离开过初始快照就算「未保存」，
  // 切换集群前据此弹确认（登记处见 lib/unsaved-edits）。
  const [formSnapshot] = useState(() =>
    JSON.stringify({
      name,
      description,
      dataRows,
      binaryRows,
      labels,
      annotations,
      editedYaml,
    })
  )
  useUnsavedEdits(
    JSON.stringify({
      name,
      description,
      dataRows,
      binaryRows,
      labels,
      annotations,
      editedYaml,
    }) !== formSnapshot
  )
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // 编辑模式：把线上对象读回来预填（创建模式下不发请求）。
  const { data: existing } = useResource(
    'configmaps',
    editName || '',
    namespace,
    { enabled: isEdit }
  )
  useEffect(() => {
    if (!existing) return
    const annotations = existing.metadata?.annotations || {}
    const { [DESCRIPTION_ANNOTATION]: description, ...rest } = annotations
    setName(existing.metadata?.name || '')
    setNamespace(existing.metadata?.namespace || namespace)
    setDescription(description || '')
    setDataRows(rowsFromRecord(existing.data))
    setBinaryRows(rowsFromRecord(existing.binaryData))
    setLabels(rowsFromRecord(existing.metadata?.labels))
    setAnnotations(rowsFromRecord(rest))
    // 只有线上对象变化时重填，否则会把用户正在编辑的内容冲掉。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing])

  // 支撑"从文件读取" / "选择文件"操作的隐藏 input。
  const dataFileInputRef = useRef<HTMLInputElement>(null)
  const binaryBulkInputRef = useRef<HTMLInputElement>(null)
  const binaryRowInputRef = useRef<HTMLInputElement>(null)
  const binaryRowIndexRef = useRef<number | null>(null)

  const yamlOverrides = editedYaml.trim().length > 0
  // 手工编辑的 manifest 可能自带命名空间，而对象就会创建在
  // 那个命名空间下，因此权限校验跟随它。
  const targetNamespace =
    (yamlOverrides
      ? parseConfigMapYaml(editedYaml)?.metadata?.namespace?.trim()
      : '') || namespace
  const canCreate = can('configmaps', isEdit ? 'update' : 'create', {
    namespace: targetNamespace,
  })

  const updateRow = (
    rows: DataRow[],
    setRows: (next: DataRow[]) => void,
    index: number,
    patch: Partial<DataRow>
  ) => setRows(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))

  const buildConfigMap = (): ConfigMap => {
    const data = toRecord(dataRows)
    const binaryData = toRecord(binaryRows)
    const labelRecord = toRecord(labels)
    const annotationRecord = toRecord(annotations)
    if (description.trim()) {
      annotationRecord[DESCRIPTION_ANNOTATION] = description.trim()
    }
    return {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: name.trim(),
        namespace,
        ...(Object.keys(labelRecord).length > 0 && { labels: labelRecord }),
        ...(Object.keys(annotationRecord).length > 0 && {
          annotations: annotationRecord,
        }),
      },
      ...(Object.keys(data).length > 0 && { data }),
      ...(Object.keys(binaryData).length > 0 && { binaryData }),
    }
  }

  // 每次渲染重新生成：manifest 很小，保持派生
  // 可以让 YAML 标签页始终与表单一致。
  const generatedYaml = YAML.dump(buildConfigMap(), { indent: 2, noRefs: true })
  const finalYaml = yamlOverrides ? editedYaml : generatedYaml

  /** 返回第一个阻塞性的表单问题，表单合法时返回 null。 */
  const formIssue = (): string | null => {
    if (!namespace) {
      return t('configmapCreate.namespaceRequired', 'Select a namespace first.')
    }
    const trimmedName = name.trim()
    if (!trimmedName || !K8S_RESOURCE_NAME_PATTERN.test(trimmedName)) {
      return t(
        'configmapCreate.invalidName',
        'Name may only contain lowercase letters, numbers and dashes.'
      )
    }
    // "/configmaps/<ns>/create" 本身就是创建路由，因此名为
    // "create" 的 ConfigMap 将永远无法再次打开（编辑已有对象时不存在这个问题）。
    if (!isEdit && RESERVED_CREATE_NAMES.has(trimmedName)) {
      return t('configmapCreate.reservedName', {
        name: trimmedName,
        defaultValue:
          '"{{name}}" is used by the create page URL, please pick another name.',
      })
    }
    const dataKeys = new Set<string>()
    for (const row of dataRows) {
      const key = row.key.trim()
      if (!key && !row.value) continue
      if (!key) {
        return t('configmapCreate.keyRequired', 'Every entry needs a key.')
      }
      if (!K8S_DATA_KEY_PATTERN.test(key)) {
        return t('configmapCreate.invalidKey', {
          key,
          defaultValue:
            'Key "{{key}}" may only contain letters, numbers, "-", "_" and "."',
        })
      }
      if (dataKeys.has(key)) {
        return t('configmapCreate.duplicateKey', {
          key,
          defaultValue: 'Duplicate key "{{key}}"',
        })
      }
      dataKeys.add(key)
    }
    const binaryKeys = new Set<string>()
    for (const row of binaryRows) {
      const key = row.key.trim()
      if (!key && !row.value) continue
      if (!key) {
        return t('configmapCreate.keyRequired', 'Every entry needs a key.')
      }
      if (!K8S_DATA_KEY_PATTERN.test(key)) {
        return t('configmapCreate.invalidKey', {
          key,
          defaultValue:
            'Key "{{key}}" may only contain letters, numbers, "-", "_" and "."',
        })
      }
      if (binaryKeys.has(key)) {
        return t('configmapCreate.duplicateKey', {
          key,
          defaultValue: 'Duplicate key "{{key}}"',
        })
      }
      if (!row.value) {
        return t(
          'configmapCreate.binaryValueRequired',
          'Choose a file for "{{key}}"',
          { key }
        )
      }
      // API Server 会拒绝在 data 与 binaryData 中同时存在的键。
      if (dataKeys.has(key)) {
        return t('configmapCreate.overlappingKeys', {
          key,
          defaultValue:
            '"{{key}}" is already used by data; data and binaryData must not share keys.',
        })
      }
      binaryKeys.add(key)
    }
    for (const rows of [labels, annotations]) {
      const metaKeys = new Set<string>()
      for (const row of rows) {
        const key = row.key.trim()
        if (!key && !row.value) continue
        if (!key) {
          return t('configmapCreate.keyRequired', 'Every entry needs a key.')
        }
        if (!K8S_META_KEY_PATTERN.test(key)) {
          return t('configmapCreate.invalidMetaKey', {
            key,
            defaultValue:
              'Label / annotation key "{{key}}" is not a valid Kubernetes key',
          })
        }
        if (metaKeys.has(key)) {
          return t('configmapCreate.duplicateKey', {
            key,
            defaultValue: 'Duplicate key "{{key}}"',
          })
        }
        metaKeys.add(key)
      }
    }
    return null
  }

  const switchTab = (next: EditorTab) => {
    // 回到表单标签页会重新生成 manifest，因此手写的
    // YAML 会被丢弃（与 YAML 标签页上的提示一致）。
    if (tab === 'yaml' && next !== 'yaml') {
      setEditedYaml('')
    }
    setTab(next)
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev)
        params.set('tab', next)
        return params
      },
      { replace: true }
    )
  }

  /** 追加导入的文件：文件名作为 key，内容作为 value。 */
  const importFiles = async (
    files: FileList | null,
    mode: 'text' | 'binary'
  ) => {
    if (!files || files.length === 0) return
    const rows = mode === 'text' ? dataRows : binaryRows
    const setRows = mode === 'text' ? setDataRows : setBinaryRows
    const imported: DataRow[] = []
    for (const file of Array.from(files)) {
      try {
        const value =
          mode === 'text' ? await readAsText(file) : await readAsBase64(file)
        imported.push({ key: file.name, value, fileName: file.name })
      } catch {
        // 文件读取失败时跳过这一个文件，继续导入其余文件
      }
    }
    if (imported.length === 0) return

    // 按 key 合并：导入的文件会替换同 key 的行，空白的
    // 起始行会被丢弃，使列表保持整洁。
    const merged = rows.filter((row) => row.key.trim() || row.value)
    for (const row of imported) {
      const existing = merged.findIndex(
        (candidate) => candidate.key === row.key
      )
      if (existing >= 0) merged[existing] = row
      else merged.push(row)
    }
    setRows(merged.length > 0 ? merged : [{ key: '', value: '' }])
  }

  const pickBinaryRowFile = (index: number) => {
    binaryRowIndexRef.current = index
    binaryRowInputRef.current?.click()
  }

  const handleBinaryRowFile = async (files: FileList | null) => {
    const index = binaryRowIndexRef.current
    binaryRowIndexRef.current = null
    const file = files?.[0]
    if (!file || index === null) return
    try {
      const value = await readAsBase64(file)
      setBinaryRows((rows) =>
        rows.map((row, i) =>
          i === index
            ? { key: row.key || file.name, value, fileName: file.name }
            : row
        )
      )
    } catch {
      // 文件读取失败时跳过本次赋值，保持该行不变
    }
  }

  const handleCreate = async () => {
    let yamlText: string
    let target: { namespace: string; name: string }

    if (yamlOverrides) {
      const doc = parseConfigMapYaml(finalYaml)
      const parsedNamespace = String(doc?.metadata?.namespace || '').trim()
      const parsedName = String(doc?.metadata?.name || '').trim()
      if (!doc || !parsedNamespace || !parsedName) {
        const message = t(
          'configmapCreate.invalidYaml',
          'The YAML is not a valid ConfigMap or is missing name / namespace.'
        )
        setCreateError(message)
        toast.error(message)
        return
      }
      yamlText = finalYaml
      target = { namespace: parsedNamespace, name: parsedName }
    } else {
      const issue = formIssue()
      if (issue) {
        setCreateError(issue)
        toast.error(issue)
        return
      }
      const body = buildConfigMap()
      yamlText = generatedYaml
      target = {
        namespace: String(body.metadata?.namespace),
        name: String(body.metadata?.name),
      }
    }

    setIsCreating(true)
    setCreateError(null)
    try {
      await applyResource(yamlText, target.namespace)
      queryClient.invalidateQueries()
      toast.success(t('common.messages.applied', 'Applied successfully'))
      navigate(
        `/configmaps/${encodeURIComponent(target.namespace)}/${
          isEdit && editName ? editName : target.name
        }`
      )
    } catch (err) {
      const message = translateError(err, t)
      setCreateError(message)
    } finally {
      setIsCreating(false)
    }
  }

  const tabs: Array<{ key: EditorTab; label: string }> = [
    { key: 'data', label: t('configmapCreate.tabData', 'Data') },
    { key: 'binary', label: t('configmapCreate.tabBinary', 'Binary data') },
    {
      key: 'meta',
      label: t('configmapCreate.tabMeta', 'Labels & Annotations'),
    },
    {
      key: 'yaml',
      label: t('workloadWizard.stepYaml', 'Edit YAML and create'),
    },
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          aria-label={t('common.actions.backToList', '返回列表')}
          title={t('common.actions.backToList', '返回列表')}
          onClick={() =>
            isEdit && editName
              ? navigate(
                  `/configmaps/${encodeURIComponent(namespace)}/${editName}`
                )
              : navigate('/configmaps')
          }
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-bold">{pageTitle}</h1>
      </div>

      {/* Scrollable content */}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        {/* Basic info */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_2fr]">
          <div className="space-y-1.5">
            <Label className="text-xs">{t('workloadWizard.namespace')} *</Label>
            <NamespaceSelector
              selectedNamespace={namespace}
              handleNamespaceChange={(ns) => {
                const next = ns || 'default'
                setNamespace(next)
                navigate(
                  `/configmaps/${encodeURIComponent(next)}/create?tab=${tab}`,
                  { replace: true }
                )
              }}
              triggerClassName="w-full sm:w-full sm:max-w-none"
              disabled={isEdit}
              modal
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="configmap-name">
              {t('common.fields.name', 'Name')} *
            </Label>
            <div className="relative">
              <Input
                id="configmap-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t(
                  'configmapCreate.namePlaceholder',
                  'Enter a name'
                )}
                disabled={isEdit}
                className={cn('h-9', !name.trim() && 'border-destructive')}
              />
              {!name.trim() && (
                <IconAlertCircle className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-destructive" />
              )}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="configmap-description">
              {t('workloadWizard.description', 'Description')}
            </Label>
            <Input
              id="configmap-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t(
                'workloadWizard.descriptionPlaceholder',
                'Text that helps identify this resource'
              )}
              className="h-9"
            />
          </div>
        </div>

        {/* Main tabs */}
        <Tabs
          value={tab}
          onValueChange={(next) => switchTab(next as EditorTab)}
        >
          <TabStrip>
            {tabs.map(({ key, label }) => (
              <TabsTrigger key={key} value={key}>
                {label}
              </TabsTrigger>
            ))}
          </TabStrip>
        </Tabs>

        {/* Tab content */}
        <div className="pb-4">
          {tab === 'data' && (
            <div className="space-y-4 rounded-md border p-4">
              <h3 className="text-base font-medium">
                {t('configmapCreate.tabData', 'Data')}
              </h3>
              <ValueRows
                rows={dataRows}
                mode="text"
                multilineValues
                keyPlaceholder={t(
                  'workloadWizard.labelKeyPlaceholder',
                  'e.g. foo'
                )}
                valuePlaceholder={t(
                  'workloadWizard.labelValuePlaceholder',
                  'e.g. bar'
                )}
                chooseFileLabel={t('configmapCreate.chooseFile', 'Choose file')}
                binaryLoadedLabel={t(
                  'configmapCreate.binaryLoaded',
                  'Base64 data loaded'
                )}
                removeLabel={t('workloadWizard.remove', 'Remove')}
                onKeyChange={(index, key) =>
                  updateRow(dataRows, setDataRows, index, { key })
                }
                onValueChange={(index, value) =>
                  updateRow(dataRows, setDataRows, index, { value })
                }
                onRemove={(index) =>
                  setDataRows((rows) =>
                    rows.length > 1
                      ? rows.filter((_, i) => i !== index)
                      : [{ key: '', value: '' }]
                  )
                }
                onPickFile={() => undefined}
              />
              <div className="flex flex-wrap gap-2">
                <AddButton
                  label={t('common.actions.add', 'Add')}
                  onClick={() =>
                    setDataRows((rows) => [...rows, { key: '', value: '' }])
                  }
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => dataFileInputRef.current?.click()}
                >
                  <Upload className="mr-1 h-3.5 w-3.5" />
                  {t('common.actions.readFromFile', 'Read from file')}
                </Button>
              </div>
            </div>
          )}

          {tab === 'binary' && (
            <div className="space-y-4 rounded-md border p-4">
              <h3 className="text-base font-medium">
                {t('configmapCreate.tabBinary', 'Binary data')}
              </h3>
              <p className="text-xs text-muted-foreground">
                {t(
                  'configmapCreate.binaryHint',
                  'Binary values are stored base64-encoded.'
                )}
              </p>
              <ValueRows
                rows={binaryRows}
                mode="binary"
                keyPlaceholder={t(
                  'workloadWizard.labelKeyPlaceholder',
                  'e.g. foo'
                )}
                valuePlaceholder={t(
                  'workloadWizard.labelValuePlaceholder',
                  'e.g. bar'
                )}
                chooseFileLabel={t('configmapCreate.chooseFile', 'Choose file')}
                binaryLoadedLabel={t(
                  'configmapCreate.binaryLoaded',
                  'Base64 data loaded'
                )}
                removeLabel={t('workloadWizard.remove', 'Remove')}
                onKeyChange={(index, key) =>
                  updateRow(binaryRows, setBinaryRows, index, { key })
                }
                onValueChange={(index, value) =>
                  updateRow(binaryRows, setBinaryRows, index, { value })
                }
                onRemove={(index) =>
                  setBinaryRows((rows) =>
                    rows.length > 1
                      ? rows.filter((_, i) => i !== index)
                      : [{ key: '', value: '', fileName: '' }]
                  )
                }
                onPickFile={pickBinaryRowFile}
              />
              <div className="flex flex-wrap gap-2">
                <AddButton
                  label={t('common.actions.add', 'Add')}
                  onClick={() =>
                    setBinaryRows((rows) => [
                      ...rows,
                      { key: '', value: '', fileName: '' },
                    ])
                  }
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => binaryBulkInputRef.current?.click()}
                >
                  <Upload className="mr-1 h-3.5 w-3.5" />
                  {t('common.actions.readFromFile', 'Read from file')}
                </Button>
              </div>
            </div>
          )}

          {tab === 'meta' && (
            <div className="space-y-6 rounded-md border p-4">
              <h3 className="text-base font-medium">
                {t('workloadWizard.labelsAnnotations', 'Labels & Annotations')}
              </h3>
              <div className="space-y-3">
                <h4 className="text-sm font-medium">
                  {t('common.fields.labels', 'Labels')}
                </h4>
                <p className="text-xs text-muted-foreground">
                  {t(
                    'configmapCreate.labelsHint',
                    'Key/value pairs used to identify and select this ConfigMap.'
                  )}
                </p>
                <ValueRows
                  rows={labels}
                  mode="text"
                  keyPlaceholder={t(
                    'workloadWizard.labelKeyPlaceholder',
                    'e.g. foo'
                  )}
                  valuePlaceholder={t(
                    'workloadWizard.labelValuePlaceholder',
                    'e.g. bar'
                  )}
                  chooseFileLabel={t(
                    'configmapCreate.chooseFile',
                    'Choose file'
                  )}
                  binaryLoadedLabel={t(
                    'configmapCreate.binaryLoaded',
                    'Base64 data loaded'
                  )}
                  removeLabel={t('workloadWizard.remove', 'Remove')}
                  onKeyChange={(index, key) =>
                    updateRow(labels, setLabels, index, { key })
                  }
                  onValueChange={(index, value) =>
                    updateRow(labels, setLabels, index, { value })
                  }
                  onRemove={(index) =>
                    setLabels((rows) =>
                      rows.length > 1
                        ? rows.filter((_, i) => i !== index)
                        : [{ key: '', value: '' }]
                    )
                  }
                  onPickFile={() => undefined}
                />
                <AddButton
                  label={t('configmapCreate.addLabel', 'Add label')}
                  onClick={() =>
                    setLabels((rows) => [...rows, { key: '', value: '' }])
                  }
                />
              </div>
              <div className="space-y-3">
                <h4 className="text-sm font-medium">
                  {t('common.fields.annotations', 'Annotations')}
                </h4>
                <p className="text-xs text-muted-foreground">
                  {t(
                    'configmapCreate.annotationsHint',
                    'Key/value pairs for non-identifying metadata.'
                  )}
                </p>
                <ValueRows
                  rows={annotations}
                  mode="text"
                  keyPlaceholder={t(
                    'workloadWizard.labelKeyPlaceholder',
                    'e.g. foo'
                  )}
                  valuePlaceholder={t(
                    'workloadWizard.labelValuePlaceholder',
                    'e.g. bar'
                  )}
                  chooseFileLabel={t(
                    'configmapCreate.chooseFile',
                    'Choose file'
                  )}
                  binaryLoadedLabel={t(
                    'configmapCreate.binaryLoaded',
                    'Base64 data loaded'
                  )}
                  removeLabel={t('workloadWizard.remove', 'Remove')}
                  onKeyChange={(index, key) =>
                    updateRow(annotations, setAnnotations, index, { key })
                  }
                  onValueChange={(index, value) =>
                    updateRow(annotations, setAnnotations, index, { value })
                  }
                  onRemove={(index) =>
                    setAnnotations((rows) =>
                      rows.length > 1
                        ? rows.filter((_, i) => i !== index)
                        : [{ key: '', value: '' }]
                    )
                  }
                  onPickFile={() => undefined}
                />
                <AddButton
                  label={t('configmapCreate.addAnnotation', 'Add annotation')}
                  onClick={() =>
                    setAnnotations((rows) => [...rows, { key: '', value: '' }])
                  }
                />
              </div>
            </div>
          )}

          {tab === 'yaml' && (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                {t(
                  'workloadWizard.yamlTabHint',
                  'This YAML is generated from the form above and can be edited. Once edited it takes precedence; returning to a form tab regenerates it.'
                )}
              </p>
              <div className="min-h-[400px] rounded-md border">
                <SimpleYamlEditor
                  value={finalYaml}
                  onChange={(value) => {
                    const next = value || ''
                    // 忽略 Monaco 为受控 value 回传的
                    // 回声，使表单在被编辑之前保持权威。
                    if (next === finalYaml) return
                    setEditedYaml(next)
                  }}
                  height="500px"
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {createError && (
        <div className="rounded-md border border-destructive/40 border-l-4 border-l-destructive bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {createError}
        </div>
      )}

      {!canCreate && (
        <div className="rounded-md border border-destructive/40 border-l-4 border-l-destructive bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {t('configmapCreate.noCreatePermission', {
            namespace: targetNamespace,
            defaultValue: `You do not have permission to create ConfigMaps in namespace {{namespace}}.`,
          })}
        </div>
      )}

      {/* Footer actions */}
      <div className="flex items-center justify-end gap-2 border-t pt-3">
        <Button
          variant="outline"
          onClick={() =>
            isEdit && editName
              ? navigate(
                  `/configmaps/${encodeURIComponent(namespace)}/${editName}`
                )
              : navigate('/configmaps')
          }
        >
          {t('common.actions.cancel', 'Cancel')}
        </Button>
        {/* Kept clickable while invalid so the banner can name the problem. */}
        <Button onClick={handleCreate} disabled={isCreating || !canCreate}>
          {isCreating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {isEdit
            ? t('common.actions.save', '保存')
            : t('configmapCreate.createButton', 'Create ConfigMap')}
        </Button>
      </div>

      <input
        ref={dataFileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          void importFiles(e.target.files, 'text')
          e.target.value = ''
        }}
      />
      <input
        ref={binaryBulkInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          void importFiles(e.target.files, 'binary')
          e.target.value = ''
        }}
      />
      <input
        ref={binaryRowInputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          void handleBinaryRowFile(e.target.files)
          e.target.value = ''
        }}
      />
    </div>
  )
}

export default ConfigMapCreatePage
