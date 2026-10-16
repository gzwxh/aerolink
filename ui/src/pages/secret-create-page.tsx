import { useEffect, useRef, useState } from 'react'
import { IconAlertCircle } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import * as YAML from 'js-yaml'
import { Secret } from 'kubernetes-types/core/v1'
import { ArrowLeft, Loader2, Upload } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

import { applyResource, useResource } from '@/lib/api'
import { splitSecretData } from '@/lib/base64'
import { prepareCloneResource } from '@/lib/clone-manifest'
import { useClusterNavigate } from '@/lib/cluster-path'
import { getClusterScopedStorageKey } from '@/lib/current-cluster'
import {
  DESCRIPTION_ANNOTATION,
  K8S_DATA_KEY_PATTERN,
  K8S_META_KEY_PATTERN,
  K8S_RESOURCE_NAME_PATTERN,
  LEGACY_DESCRIPTION_ANNOTATION,
  readDescription,
  RESERVED_CREATE_NAMES,
  resolveCreateNamespace,
} from '@/lib/k8s'
import { useUnsavedEdits } from '@/lib/unsaved-edits'
import { cn, translateError } from '@/lib/utils'
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

/** 把 `[key, value]` 序列转成键/值行；空列表给一行空行，保证表格不为空。 */
function rowsFromPairs(pairs: Array<[string, string]>): DataRow[] {
  const rows = pairs.map(([key, value]) => ({ key, value }))
  return rows.length > 0 ? rows : [{ key: '', value: '' }]
}

const EDITOR_TABS: EditorTab[] = ['data', 'binary', 'meta', 'yaml']

const SECRET_TYPE_OPAQUE = 'Opaque'
/** 下拉里的「自定义」哨兵值，真正的类型由旁边的输入框决定。 */
const SECRET_TYPE_CUSTOM = 'custom'

/**
 * `requiredKeys` 是 apiserver 会强制校验的键：缺键的 Secret 一定会被拒绝，
 * 所以在表单里提前拦住比让用户对着后端报错猜更好。
 * `recommendedKeys` 是第三方类型（bootstrap token / istio / helm / fleet）
 * 约定俗成的键，核心校验不会检查，选这些类型时只提示、不强制。
 */
const SECRET_TYPES: Array<{
  value: string
  requiredKeys: string[]
  recommendedKeys?: string[]
}> = [
  { value: SECRET_TYPE_CUSTOM, requiredKeys: [] },
  { value: SECRET_TYPE_OPAQUE, requiredKeys: [] },
  { value: 'kubernetes.io/service-account-token', requiredKeys: [] },
  {
    value: 'kubernetes.io/dockerconfigjson',
    requiredKeys: ['.dockerconfigjson'],
  },
  { value: 'kubernetes.io/basic-auth', requiredKeys: ['username', 'password'] },
  { value: 'kubernetes.io/ssh-auth', requiredKeys: ['ssh-privatekey'] },
  { value: 'kubernetes.io/tls', requiredKeys: ['tls.crt', 'tls.key'] },
  { value: 'kubernetes.io/dockercfg', requiredKeys: ['.dockercfg'] },
  {
    value: 'bootstrap.kubernetes.io/token',
    requiredKeys: [],
    recommendedKeys: ['token-id', 'token-secret'],
  },
  {
    value: 'istio.io/key-and-cert',
    requiredKeys: [],
    recommendedKeys: ['key', 'cert', 'cacert'],
  },
  {
    value: 'helm.sh/release.v1',
    requiredKeys: [],
    recommendedKeys: ['release'],
  },
  {
    value: 'fleet.cattle.io/cluster-registration-values',
    requiredKeys: [],
    recommendedKeys: ['values'],
  },
  { value: 'provisioning.cattle.io/cloud-credential', requiredKeys: [] },
  { value: 'rke.cattle.io/auth-config', requiredKeys: [] },
]

/** 下拉里能选到的内置类型；线上对象用了别的类型时走「自定义」分支。 */
const KNOWN_SECRET_TYPES: string[] = SECRET_TYPES.map((item) => item.value)

const requiredKeysOf = (type: string) =>
  SECRET_TYPES.find((candidate) => candidate.value === type)?.requiredKeys ?? []

const recommendedKeysOf = (type: string) =>
  SECRET_TYPES.find((candidate) => candidate.value === type)?.recommendedKeys ??
  []

const parseSecretYaml = (text: string): Secret | null => {
  try {
    const doc = YAML.load(text) as Secret | undefined
    if (!doc || typeof doc !== 'object' || doc.kind !== 'Secret') {
      return null
    }
    return doc
  } catch {
    return null
  }
}

export function SecretCreatePage({ clone = false }: { clone?: boolean }) {
  const { t } = useTranslation()
  const navigate = useClusterNavigate()
  const queryClient = useQueryClient()
  const { namespace: namespaceParam, name: editName } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const can = useCan()

  // 克隆路由也有 :name，但保存走创建：名称与命名空间保持可编辑。
  const isEdit = Boolean(editName) && !clone

  const pageTitle = isEdit
    ? t('secretCreate.editPageTitle', 'Secret: 编辑')
    : clone && editName
      ? t('secretCreate.clonePageTitle', {
          name: editName,
          defaultValue: `Secret: 从 ${editName} 克隆`,
        })
      : t('secretCreate.pageTitle', 'Secret: 创建')
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
  const [secretType, setSecretType] = useState(SECRET_TYPE_OPAQUE)
  /** 仅在选中「自定义」时生效。 */
  const [customType, setCustomType] = useState('')
  const [immutable, setImmutable] = useState(false)
  const [tab, setTab] = useState<EditorTab>(() => {
    const requested = searchParams.get('tab') as EditorTab | null
    return requested && EDITOR_TABS.includes(requested) ? requested : 'data'
  })
  // 明文值走 stringData（由 apiserver 编码成 base64 存进 data），
  // 二进制/文件走 data（这里已经读成 base64）。
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
      secretType,
      customType,
      immutable,
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
      secretType,
      customType,
      immutable,
      dataRows,
      binaryRows,
      labels,
      annotations,
      editedYaml,
    }) !== formSnapshot
  )
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // 编辑/克隆模式：把线上对象读回来预填（纯创建模式下不发请求）。
  const { data: existing } = useResource('secrets', editName || '', namespace, {
    enabled: Boolean(editName),
  })
  useEffect(() => {
    if (!existing) return
    // 克隆：先做通用预处理（剥离服务端字段、改名 <源名>-copy）再反显。
    const source = clone
      ? (prepareCloneResource(
          existing,
          'secrets',
          editName || '',
          `${editName || ''}-copy`
        ) as Secret)
      : existing
    const annotations = source.metadata?.annotations || {}
    // 描述注解：读新键并兼容改名前的旧键；两者都不作为「额外注解」展示。
    const rest = { ...annotations }
    delete rest[DESCRIPTION_ANNOTATION]
    delete rest[LEGACY_DESCRIPTION_ANNOTATION]
    setName(source.metadata?.name || '')
    setNamespace(source.metadata?.namespace || namespace)
    setDescription(readDescription(annotations))
    setSecretType(source.type || SECRET_TYPE_OPAQUE)
    setCustomType(
      source.type && !KNOWN_SECRET_TYPES.includes(source.type)
        ? source.type
        : ''
    )
    setImmutable(source.immutable === true)
    // data 里既有明文值（stringData 写入后由 apiserver 编码）也有二进制值，
    // 二者用「能否安全编码往返」区分，避免把 keystore 这类内容当文本改坏。
    const { text, binary } = splitSecretData(source.data)
    setDataRows(rowsFromPairs(text))
    setBinaryRows(
      rowsFromPairs(binary).map((row) => ({ ...row, fileName: row.key }))
    )
    setLabels(rowsFromPairs(Object.entries(source.metadata?.labels || {})))
    setAnnotations(rowsFromPairs(Object.entries(rest)))
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
      ? parseSecretYaml(editedYaml)?.metadata?.namespace?.trim()
      : '') || namespace
  const canCreate = can('secrets', isEdit ? 'update' : 'create', {
    namespace: targetNamespace,
  })

  // 下拉选「自定义」时，真正写进 manifest 的类型来自旁边的输入框。
  const isCustomType = secretType === SECRET_TYPE_CUSTOM
  const effectiveSecretType = isCustomType ? customType.trim() : secretType
  const customTypeMissing = isCustomType && !effectiveSecretType
  const requiredKeys = requiredKeysOf(effectiveSecretType)
  const recommendedKeys = recommendedKeysOf(effectiveSecretType)

  const secretTypeLabel = (value: string) => {
    if (value === SECRET_TYPE_CUSTOM) {
      return t('secretCreate.typeCustom', 'Custom')
    }
    if (value === SECRET_TYPE_OPAQUE) {
      return t('secretCreate.typeOpaque', 'Opaque (default)')
    }
    return value
  }

  const updateRow = (
    rows: DataRow[],
    setRows: (next: DataRow[]) => void,
    index: number,
    patch: Partial<DataRow>
  ) => setRows(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))

  const buildSecret = (): Secret => {
    const stringData = toRecord(dataRows)
    const data = toRecord(binaryRows)
    const labelRecord = toRecord(labels)
    const annotationRecord = toRecord(annotations)
    if (description.trim()) {
      annotationRecord[DESCRIPTION_ANNOTATION] = description.trim()
    }
    return {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: name.trim(),
        namespace,
        ...(Object.keys(labelRecord).length > 0 && { labels: labelRecord }),
        ...(Object.keys(annotationRecord).length > 0 && {
          annotations: annotationRecord,
        }),
      },
      ...(effectiveSecretType &&
        effectiveSecretType !== SECRET_TYPE_OPAQUE && {
          type: effectiveSecretType,
        }),
      ...(immutable && { immutable: true }),
      ...(Object.keys(stringData).length > 0 && { stringData }),
      ...(Object.keys(data).length > 0 && { data }),
    }
  }

  // 每次渲染重新生成：manifest 很小，保持派生
  // 可以让 YAML 标签页始终与表单一致。
  const generatedYaml = YAML.dump(buildSecret(), { indent: 2, noRefs: true })
  const finalYaml = yamlOverrides ? editedYaml : generatedYaml

  /** 返回第一个阻塞性的表单问题，表单合法时返回 null。 */
  const formIssue = (): string | null => {
    if (!namespace) {
      return t('secretCreate.namespaceRequired', 'Select a namespace first.')
    }
    const trimmedName = name.trim()
    if (!trimmedName || !K8S_RESOURCE_NAME_PATTERN.test(trimmedName)) {
      return t(
        'secretCreate.invalidName',
        'Name may only contain lowercase letters, numbers and dashes.'
      )
    }
    // "/secrets/<ns>/create" 本身就是创建路由，因此名为
    // "create" 的 Secret 将永远无法再次打开。
    if (!isEdit && RESERVED_CREATE_NAMES.has(trimmedName)) {
      return t('secretCreate.reservedName', {
        name: trimmedName,
        defaultValue:
          '"{{name}}" is used by the create page URL, please pick another name.',
      })
    }
    // 「自定义」类型必须自己填类型名，否则会退化成 Opaque。
    if (customTypeMissing) {
      return t('secretCreate.customTypeRequired', 'Enter a custom type.')
    }
    const dataKeys = new Set<string>()
    for (const row of dataRows) {
      const key = row.key.trim()
      if (!key && !row.value) continue
      if (!key) {
        return t('secretCreate.keyRequired', 'Every entry needs a key.')
      }
      if (!K8S_DATA_KEY_PATTERN.test(key)) {
        return t('secretCreate.invalidKey', {
          key,
          defaultValue:
            'Key "{{key}}" may only contain letters, numbers, "-", "_" and "."',
        })
      }
      if (dataKeys.has(key)) {
        return t('secretCreate.duplicateKey', {
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
        return t('secretCreate.keyRequired', 'Every entry needs a key.')
      }
      if (!K8S_DATA_KEY_PATTERN.test(key)) {
        return t('secretCreate.invalidKey', {
          key,
          defaultValue:
            'Key "{{key}}" may only contain letters, numbers, "-", "_" and "."',
        })
      }
      if (binaryKeys.has(key)) {
        return t('secretCreate.duplicateKey', {
          key,
          defaultValue: 'Duplicate key "{{key}}"',
        })
      }
      if (!row.value) {
        return t(
          'secretCreate.binaryValueRequired',
          'Choose a file for "{{key}}"',
          {
            key,
          }
        )
      }
      // 同一个键不能同时出现在 data 与 stringData 里：apiserver 会用 stringData
      // 覆盖 data，静默覆盖比直接报错更让人困惑。
      if (dataKeys.has(key)) {
        return t('secretCreate.overlappingKeys', {
          key,
          defaultValue:
            '"{{key}}" is already used by the plain-text data; data and stringData must not share keys.',
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
          return t('secretCreate.keyRequired', 'Every entry needs a key.')
        }
        if (!K8S_META_KEY_PATTERN.test(key)) {
          return t('secretCreate.invalidMetaKey', {
            key,
            defaultValue:
              'Label / annotation key "{{key}}" is not a valid Kubernetes key',
          })
        }
        if (metaKeys.has(key)) {
          return t('secretCreate.duplicateKey', {
            key,
            defaultValue: 'Duplicate key "{{key}}"',
          })
        }
        metaKeys.add(key)
      }
    }
    // 内置类型要求的键必须存在且非空，否则 apiserver 必然拒绝。
    for (const key of requiredKeys) {
      const row =
        dataRows.find((candidate) => candidate.key.trim() === key) ??
        binaryRows.find((candidate) => candidate.key.trim() === key)
      if (!row || !row.value) {
        return t('secretCreate.requiredKeyEmpty', {
          key,
          defaultValue:
            '"{{key}}" is required by this Secret type and cannot be empty.',
        })
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

  /**
   * 选择内置类型时把它要求的键补成空行：用户只需要填值，不用记键名。
   * 已存在同名键（两个页签里）的行不动。
   */
  const handleTypeChange = (next: string) => {
    setSecretType(next)
    const missing = requiredKeysOf(next).filter(
      (key) =>
        !dataRows.some((row) => row.key.trim() === key) &&
        !binaryRows.some((row) => row.key.trim() === key)
    )
    if (missing.length > 0) {
      setDataRows((rows) => [
        ...rows.filter((row) => row.key.trim() || row.value),
        ...missing.map((key) => ({ key, value: '' })),
      ])
    }
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
      const doc = parseSecretYaml(finalYaml)
      const parsedNamespace = String(doc?.metadata?.namespace || '').trim()
      const parsedName = String(doc?.metadata?.name || '').trim()
      if (!doc || !parsedNamespace || !parsedName) {
        const message = t(
          'secretCreate.invalidYaml',
          'The YAML is not a valid Secret or is missing name / namespace.'
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
      const body = buildSecret()
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
        `/secrets/${encodeURIComponent(target.namespace)}/${
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
    { key: 'data', label: t('secretCreate.tabData', 'Data') },
    { key: 'binary', label: t('secretCreate.tabBinary', 'Binary data') },
    {
      key: 'meta',
      label: t('secretCreate.tabMeta', 'Labels & Annotations'),
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
            editName
              ? navigate(
                  `/secrets/${encodeURIComponent(namespace)}/${editName}`
                )
              : navigate('/secrets')
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
                  `/secrets/${encodeURIComponent(next)}/create?tab=${tab}`,
                  { replace: true }
                )
              }}
              triggerClassName="w-full sm:w-full sm:max-w-none"
              disabled={isEdit}
              modal
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="secret-name">
              {t('common.fields.name', 'Name')} *
            </Label>
            <div className="relative">
              <Input
                id="secret-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('secretCreate.namePlaceholder', 'Enter a name')}
                disabled={isEdit}
                className={cn('h-9', !name.trim() && 'border-destructive')}
              />
              {!name.trim() && (
                <IconAlertCircle className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-destructive" />
              )}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="secret-description">
              {t('workloadWizard.description', 'Description')}
            </Label>
            <Input
              id="secret-description"
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
                {t('secretCreate.tabData', 'Data')}
              </h3>
              <p className="text-xs text-muted-foreground">
                {t(
                  'secretCreate.dataHint',
                  'Plain values are sent as stringData and base64-encoded by the API server.'
                )}
              </p>
              <div
                className={cn(
                  'grid grid-cols-1 gap-3',
                  isCustomType
                    ? 'sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,1fr)]'
                    : 'sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]'
                )}
              >
                <div className="space-y-1.5">
                  <Label className="text-xs" htmlFor="secret-type">
                    {t('secretCreate.typeLabel', '类型')}
                  </Label>
                  <Select
                    value={secretType}
                    onValueChange={handleTypeChange}
                    disabled={isEdit}
                  >
                    <SelectTrigger id="secret-type" className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SECRET_TYPES.map((candidate) => (
                        <SelectItem
                          key={candidate.value}
                          value={candidate.value}
                        >
                          {secretTypeLabel(candidate.value)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {isCustomType && (
                  <div className="space-y-1.5">
                    <Label className="text-xs" htmlFor="secret-custom-type">
                      {t('secretCreate.customTypeLabel', '自定义类型')} *
                    </Label>
                    <div className="relative">
                      <Input
                        id="secret-custom-type"
                        value={customType}
                        onChange={(e) => setCustomType(e.target.value)}
                        placeholder={t(
                          'secretCreate.customTypePlaceholder',
                          'e.g. example.com/my-type'
                        )}
                        className={cn(
                          'h-9',
                          customTypeMissing && 'border-destructive'
                        )}
                      />
                      {customTypeMissing && (
                        <IconAlertCircle className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-destructive" />
                      )}
                    </div>
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label className="text-xs">
                    {t('secretCreate.immutableLabel', '不可变')}
                  </Label>
                  <label className="flex h-9 items-center gap-2 text-sm">
                    <Checkbox
                      checked={immutable}
                      onCheckedChange={(checked) =>
                        setImmutable(checked === true)
                      }
                    />
                    {t('secretCreate.immutableHint', '创建后不允许再修改')}
                  </label>
                </div>
              </div>
              {requiredKeys.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t('secretCreate.requiredKeysHint', {
                    keys: requiredKeys.join(', '),
                    defaultValue:
                      'This type requires these keys (they cannot be empty): {{keys}}',
                  })}
                </p>
              )}
              {recommendedKeys.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t('secretCreate.recommendedKeysHint', {
                    keys: recommendedKeys.join(', '),
                    defaultValue:
                      'This type commonly uses these keys (optional): {{keys}}',
                  })}
                </p>
              )}
              <ValueRows
                rows={dataRows}
                mode="text"
                maskValues
                multilineValues
                keyPlaceholder={t(
                  'workloadWizard.labelKeyPlaceholder',
                  'e.g. foo'
                )}
                valuePlaceholder={t(
                  'workloadWizard.labelValuePlaceholder',
                  'e.g. bar'
                )}
                chooseFileLabel={t('secretCreate.chooseFile', 'Choose file')}
                binaryLoadedLabel={t(
                  'secretCreate.binaryLoaded',
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
                {t('secretCreate.tabBinary', 'Binary data')}
              </h3>
              <p className="text-xs text-muted-foreground">
                {t(
                  'secretCreate.binaryHint',
                  'File contents are stored base64-encoded in data — use this for certificates, keystores and other binary values.'
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
                chooseFileLabel={t('secretCreate.chooseFile', 'Choose file')}
                binaryLoadedLabel={t(
                  'secretCreate.binaryLoaded',
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
                    'secretCreate.labelsHint',
                    'Key/value pairs used to identify and select this Secret.'
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
                  chooseFileLabel={t('secretCreate.chooseFile', 'Choose file')}
                  binaryLoadedLabel={t(
                    'secretCreate.binaryLoaded',
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
                  label={t('secretCreate.addLabel', 'Add label')}
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
                    'secretCreate.annotationsHint',
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
                  chooseFileLabel={t('secretCreate.chooseFile', 'Choose file')}
                  binaryLoadedLabel={t(
                    'secretCreate.binaryLoaded',
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
                  label={t('secretCreate.addAnnotation', 'Add annotation')}
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
          {t('secretCreate.noCreatePermission', {
            namespace: targetNamespace,
            defaultValue: `You do not have permission to create Secrets in namespace {{namespace}}.`,
          })}
        </div>
      )}

      {/* Footer actions */}
      <div className="flex items-center justify-end gap-2 border-t pt-3">
        <Button
          variant="outline"
          onClick={() =>
            editName
              ? navigate(
                  `/secrets/${encodeURIComponent(namespace)}/${editName}`
                )
              : navigate('/secrets')
          }
        >
          {t('common.actions.cancel', 'Cancel')}
        </Button>
        {/* Kept clickable while invalid so the banner can name the problem. */}
        <Button onClick={handleCreate} disabled={isCreating || !canCreate}>
          {isCreating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {isEdit
            ? t('common.actions.save', '保存')
            : t('secretCreate.createButton', 'Create Secret')}
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

export default SecretCreatePage
