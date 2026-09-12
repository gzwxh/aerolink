import { useRef, useState } from 'react'
import { IconAlertCircle } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import * as YAML from 'js-yaml'
import { ConfigMap } from 'kubernetes-types/core/v1'
import { ArrowLeft, Loader2, Plus, Upload } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

import { applyResource } from '@/lib/api'
import { getClusterScopedStorageKey } from '@/lib/current-cluster'
import { DESCRIPTION_ANNOTATION, resolveCreateNamespace } from '@/lib/k8s'
import { cn, translateError } from '@/lib/utils'
import { useCan } from '@/hooks/use-can'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NamespaceSelector } from '@/components/selector/namespace-selector'
import { SimpleYamlEditor } from '@/components/simple-yaml-editor'

// ConfigMap names follow the DNS subdomain rules; data / binaryData keys are
// restricted to alphanumerics plus '-', '_' and '.'.
const NAME_PATTERN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
const KEY_PATTERN = /^[-._a-zA-Z0-9]+$/
// Label / annotation keys: an optional DNS subdomain prefix, then a name part
// that may also carry uppercase letters.
const META_KEY_PATTERN =
  /^(?:[a-z0-9]([-a-z0-9.]*[a-z0-9])?\/)?[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/

// ConfigMap names that would collide with the create / detail routes.
const RESERVED_NAMES = new Set(['create'])

interface DataRow {
  key: string
  /** Plain text value, or the base64 payload for the binary tab. */
  value: string
  /** Source file name, only used by the binary tab. */
  fileName?: string
}

type EditorTab = 'data' | 'binary' | 'meta' | 'yaml'

const EDITOR_TABS: EditorTab[] = ['data', 'binary', 'meta', 'yaml']

const readAsText = (file: File) => file.text()

/**
 * Reads a file as bare base64 (without the `data:` URL prefix) because that is
 * the format the API server expects in ConfigMap.binaryData.
 */
const readAsBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })

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

/** Keeps the last value for every non-blank key, dropping empty rows. */
function toRecord(rows: DataRow[]) {
  const record: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (key) record[key] = row.value
  }
  return record
}

/** Shared key/value row editor used by the data, binary, labels and annotations forms. */
function ValueRows({
  rows,
  mode,
  keyPlaceholder,
  valuePlaceholder,
  chooseFileLabel,
  binaryLoadedLabel,
  removeLabel,
  onKeyChange,
  onValueChange,
  onRemove,
  onPickFile,
}: {
  rows: DataRow[]
  mode: 'text' | 'binary'
  keyPlaceholder: string
  valuePlaceholder: string
  chooseFileLabel: string
  binaryLoadedLabel: string
  removeLabel: string
  onKeyChange: (index: number, key: string) => void
  onValueChange: (index: number, value: string) => void
  onRemove: (index: number) => void
  onPickFile: (index: number) => void
}) {
  return (
    <div className="space-y-2">
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-3">
          <Input
            value={row.key}
            onChange={(e) => onKeyChange(index, e.target.value)}
            placeholder={keyPlaceholder}
            className="h-9 min-w-0 flex-1"
          />
          {mode === 'text' ? (
            <Input
              value={row.value}
              onChange={(e) => onValueChange(index, e.target.value)}
              placeholder={valuePlaceholder}
              className="h-9 min-w-0 flex-1"
            />
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 min-w-0 flex-1 justify-start font-normal"
              onClick={() => onPickFile(index)}
            >
              <Upload className="mr-2 h-3.5 w-3.5 shrink-0" />
              <span className="truncate">
                {row.fileName ||
                  (row.value ? binaryLoadedLabel : chooseFileLabel)}
              </span>
            </Button>
          )}
          <button
            type="button"
            className="shrink-0 text-sm text-primary transition-colors hover:underline"
            onClick={() => onRemove(index)}
          >
            {removeLabel}
          </button>
        </div>
      ))}
    </div>
  )
}

/** Console-style "add" button shared by every key/value section. */
function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-8 border-primary/40 bg-primary/5 text-xs text-primary hover:bg-primary/10 hover:text-primary"
      onClick={onClick}
    >
      <Plus className="mr-1 h-3.5 w-3.5" />
      {label}
    </Button>
  )
}

export function ConfigMapCreatePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { namespace: namespaceParam } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const can = useCan()

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
  /** YAML edited by hand; when set it wins over the generated manifest. */
  const [editedYaml, setEditedYaml] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // Hidden inputs backing the "read from file" / "choose file" actions.
  const dataFileInputRef = useRef<HTMLInputElement>(null)
  const binaryBulkInputRef = useRef<HTMLInputElement>(null)
  const binaryRowInputRef = useRef<HTMLInputElement>(null)
  const binaryRowIndexRef = useRef<number | null>(null)

  const yamlOverrides = editedYaml.trim().length > 0
  // A hand-edited manifest may name its own namespace, and that is where the
  // object gets created, so the permission check follows it.
  const targetNamespace =
    (yamlOverrides
      ? parseConfigMapYaml(editedYaml)?.metadata?.namespace?.trim()
      : '') || namespace
  const canCreate = can('configmaps', 'create', {
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

  // Regenerated on every render: the manifest is small and keeping it derived
  // means the YAML tab always mirrors the form.
  const generatedYaml = YAML.dump(buildConfigMap(), { indent: 2, noRefs: true })
  const finalYaml = yamlOverrides ? editedYaml : generatedYaml

  /** Returns the first blocking form problem, or null when the form is valid. */
  const formIssue = (): string | null => {
    if (!namespace) {
      return t('configmapCreate.namespaceRequired', 'Select a namespace first.')
    }
    const trimmedName = name.trim()
    if (!trimmedName || !NAME_PATTERN.test(trimmedName)) {
      return t(
        'configmapCreate.invalidName',
        'Name may only contain lowercase letters, numbers and dashes.'
      )
    }
    // "/configmaps/<ns>/create" is the create route itself, so a ConfigMap
    // called "create" could never be opened again.
    if (RESERVED_NAMES.has(trimmedName)) {
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
      if (!KEY_PATTERN.test(key)) {
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
      if (!KEY_PATTERN.test(key)) {
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
      // The API server rejects a key that exists in both data and binaryData.
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
        if (!META_KEY_PATTERN.test(key)) {
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
    // Returning to a form tab regenerates the manifest, so the hand-written
    // YAML is dropped (matches the hint shown on the YAML tab).
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

  /** Appends imported files: the file name becomes the key, content the value. */
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
        toast.error(
          t('configmapCreate.fileReadFailed', {
            name: file.name,
            defaultValue: 'Failed to read {{name}}',
          })
        )
      }
    }
    if (imported.length === 0) return

    // Merge by key: an imported file replaces a row with the same key, blank
    // starter rows are dropped so the list stays clean.
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
      toast.error(
        t('configmapCreate.fileReadFailed', {
          name: file.name,
          defaultValue: 'Failed to read {{name}}',
        })
      )
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
        `/configmaps/${encodeURIComponent(target.namespace)}/${target.name}`
      )
    } catch (err) {
      const message = translateError(err, t)
      setCreateError(message)
      toast.error(message)
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
          onClick={() => navigate('/configmaps')}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-xl font-semibold">
          {t('configmapCreate.pageTitle', 'ConfigMap: Create')}
        </h1>
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
        <div className="flex flex-wrap items-center gap-1 border-b">
          {tabs.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => switchTab(key)}
              className={`rounded-t-md border-b-2 px-4 py-2 text-sm transition-colors ${
                tab === key
                  ? 'border-primary font-medium text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

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
                    // Ignore the echoes Monaco sends back for the controlled
                    // value so the form stays authoritative until edited.
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
        <Button variant="outline" onClick={() => navigate('/configmaps')}>
          {t('common.actions.cancel', 'Cancel')}
        </Button>
        {/* Kept clickable while invalid so the banner can name the problem. */}
        <Button onClick={handleCreate} disabled={isCreating || !canCreate}>
          {isCreating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t('configmapCreate.createButton', 'Create ConfigMap')}
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
