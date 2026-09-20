import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { Container, EnvFromSource, EnvVar } from 'kubernetes-types/core/v1'
import { useTranslation } from 'react-i18next'

import { useResources } from '@/lib/api'
import { cn } from '@/lib/utils'
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

/**
 * 环境变量行的类型，与控制台的选择器一致：
 * Key/Value Pair、Resource、ConfigMap Key、Secret key、Pod Field、Secret 与
 * ConfigMap（后两者通过 envFrom 注入整个对象）。
 */
type EnvRowType =
  | 'value'
  | 'resource'
  | 'configMapKey'
  | 'secretKey'
  | 'podField'
  | 'secret'
  | 'configMap'

interface EnvRow {
  id: string
  type: EnvRowType
  /** 变量名（envFrom 类型不使用）。 */
  name: string
  /** Key/Value Pair 类型的直接取值。 */
  value: string
  /** 引用类型的 ConfigMap / Secret 名称。 */
  refName: string
  /** ConfigMap / Secret 的 key。 */
  key: string
  /** resourceFieldRef.resource。 */
  resource: string
  /** fieldRef.fieldPath。 */
  fieldPath: string
  /** envFrom 前缀。 */
  prefix: string
}

const RESOURCE_FIELDS = [
  'requests.cpu',
  'requests.memory',
  'requests.ephemeral-storage',
  'limits.cpu',
  'limits.memory',
  'limits.ephemeral-storage',
]

const POD_FIELDS = [
  'metadata.name',
  'metadata.namespace',
  'metadata.uid',
  'metadata.labels',
  'metadata.annotations',
  'spec.nodeName',
  'spec.serviceAccountName',
  'status.hostIP',
  'status.podIP',
  'status.podIPs',
]

let rowSeq = 0
const nextRowId = () => `env-row-${++rowSeq}`

const emptyRow = (type: EnvRowType): EnvRow => ({
  id: nextRowId(),
  type,
  name: '',
  value: '',
  refName: '',
  key: '',
  resource: type === 'resource' ? RESOURCE_FIELDS[0] : '',
  fieldPath: type === 'podField' ? POD_FIELDS[0] : '',
  prefix: '',
})

/** 把已存储的 env 条目解析为可编辑行。 */
const rowFromEnv = (env: EnvVar): EnvRow => {
  const row = emptyRow('value')
  row.name = env.name || ''
  if (env.valueFrom?.secretKeyRef) {
    row.type = 'secretKey'
    row.refName = env.valueFrom.secretKeyRef.name || ''
    row.key = env.valueFrom.secretKeyRef.key || ''
  } else if (env.valueFrom?.configMapKeyRef) {
    row.type = 'configMapKey'
    row.refName = env.valueFrom.configMapKeyRef.name || ''
    row.key = env.valueFrom.configMapKeyRef.key || ''
  } else if (env.valueFrom?.fieldRef) {
    row.type = 'podField'
    row.fieldPath = env.valueFrom.fieldRef.fieldPath || POD_FIELDS[0]
  } else if (env.valueFrom?.resourceFieldRef) {
    row.type = 'resource'
    row.resource = env.valueFrom.resourceFieldRef.resource || RESOURCE_FIELDS[0]
  } else {
    row.value = env.value || ''
  }
  return row
}

/** 把已存储的 envFrom 条目解析为可编辑行。 */
const rowFromEnvFrom = (source: EnvFromSource): EnvRow => {
  const row = emptyRow('configMap')
  row.prefix = source.prefix || ''
  if (source.secretRef) {
    row.type = 'secret'
    row.refName = source.secretRef.name || ''
  } else {
    row.type = 'configMap'
    row.refName = source.configMapRef?.name || ''
  }
  return row
}

/** 把行转换回容器的 env / envFrom 字段。 */
const serializeRows = (
  rows: EnvRow[]
): { env: EnvVar[]; envFrom: EnvFromSource[] } => {
  const env: EnvVar[] = []
  const envFrom: EnvFromSource[] = []
  for (const row of rows) {
    switch (row.type) {
      case 'value':
        if (row.name.trim()) env.push({ name: row.name, value: row.value })
        break
      case 'resource':
        if (row.name.trim())
          env.push({
            name: row.name,
            valueFrom: {
              resourceFieldRef: {
                resource: row.resource || RESOURCE_FIELDS[0],
              },
            },
          })
        break
      case 'configMapKey':
        if (row.name.trim())
          env.push({
            name: row.name,
            valueFrom: {
              configMapKeyRef: { name: row.refName, key: row.key },
            },
          })
        break
      case 'secretKey':
        if (row.name.trim())
          env.push({
            name: row.name,
            valueFrom: { secretKeyRef: { name: row.refName, key: row.key } },
          })
        break
      case 'podField':
        if (row.name.trim())
          env.push({
            name: row.name,
            valueFrom: {
              fieldRef: { fieldPath: row.fieldPath || POD_FIELDS[0] },
            },
          })
        break
      case 'configMap':
        if (row.refName.trim())
          envFrom.push({
            ...(row.prefix ? { prefix: row.prefix } : {}),
            configMapRef: { name: row.refName },
          })
        break
      case 'secret':
        if (row.refName.trim())
          envFrom.push({
            ...(row.prefix ? { prefix: row.prefix } : {}),
            secretRef: { name: row.refName },
          })
        break
    }
  }
  return { env, envFrom }
}

function Field({
  label,
  children,
  className,
}: {
  label: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('min-w-0 space-y-1.5', className)}>
      <Label className="text-xs font-normal text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  )
}

interface EnvironmentEditorProps {
  container: Container
  namespace: string
  onUpdate: (updates: Partial<Container>) => void
}

export function EnvironmentEditor({
  container,
  namespace,
  onUpdate,
}: EnvironmentEditorProps) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<EnvRow[]>(() => [
    ...(container.env || []).map(rowFromEnv),
    ...(container.envFrom || []).map(rowFromEnvFrom),
  ])

  // 集群资源：提供名称及其 key 作为选择器。
  const { data: configMaps } = useResources('configmaps', namespace)
  const { data: secrets } = useResources('secrets', namespace)

  const configMapNames = useMemo(
    () =>
      (configMaps || [])
        .map((cm) => cm.metadata?.name)
        .filter((name): name is string => !!name)
        .sort(),
    [configMaps]
  )
  const secretNames = useMemo(
    () =>
      (secrets || [])
        .filter((s) => s.type !== 'helm.sh/release.v1')
        .map((s) => s.metadata?.name)
        .filter((name): name is string => !!name)
        .sort(),
    [secrets]
  )

  const configMapKeys = (name: string) =>
    Object.keys(
      configMaps?.find((cm) => cm.metadata?.name === name)?.data || {}
    )
  const secretKeys = (name: string) =>
    Object.keys(secrets?.find((s) => s.metadata?.name === name)?.data || {})

  const commit = (next: EnvRow[]) => {
    setRows(next)
    const { env, envFrom } = serializeRows(next)
    onUpdate({ env, envFrom })
  }

  const updateRow = (index: number, updates: Partial<EnvRow>) =>
    commit(rows.map((row, i) => (i === index ? { ...row, ...updates } : row)))

  const changeType = (index: number, type: EnvRowType) => {
    const current = rows[index]
    const next = emptyRow(type)
    // 保留仍然适用于新类型的部分。
    next.name = current.name
    commit(rows.map((row, i) => (i === index ? next : row)))
  }

  const renderResourcePicker = (
    row: EnvRow,
    index: number,
    names: string[],
    kind: string
  ) => (
    <Select
      value={row.refName}
      onValueChange={(value) => updateRow(index, { refName: value, key: '' })}
    >
      <SelectTrigger className="h-9 w-full">
        <SelectValue
          placeholder={t('workloadWizard.envSelectResource', {
            kind,
            defaultValue: `选择 ${kind}`,
          })}
        />
      </SelectTrigger>
      <SelectContent>
        {row.refName && !names.includes(row.refName) && (
          <SelectItem value={row.refName}>{row.refName}</SelectItem>
        )}
        {names.length === 0 && (
          <SelectItem disabled value="_empty">
            {t('workloadWizard.envNoResources', {
              kind,
              defaultValue: `暂无 ${kind}`,
            })}
          </SelectItem>
        )}
        {names.map((name) => (
          <SelectItem key={name} value={name}>
            {name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  const renderKeyPicker = (row: EnvRow, index: number, keys: string[]) => {
    const disabled = !row.refName
    return (
      <Select
        value={row.key}
        onValueChange={(value) => updateRow(index, { key: value })}
        disabled={disabled}
      >
        <SelectTrigger className="h-9 w-full">
          <SelectValue
            placeholder={
              disabled
                ? t('workloadWizard.envSelectResourceFirst', '请先选择资源')
                : t('workloadWizard.envSelectKey', '选择键')
            }
          />
        </SelectTrigger>
        <SelectContent>
          {row.key && !keys.includes(row.key) && (
            <SelectItem value={row.key}>{row.key}</SelectItem>
          )}
          {keys.length === 0 && (
            <SelectItem disabled value="_empty">
              {t('workloadWizard.envNoKeys', '暂无可选键')}
            </SelectItem>
          )}
          {keys.map((key) => (
            <SelectItem key={key} value={key}>
              {key}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }

  const renderFields = (row: EnvRow, index: number) => {
    const nameInput = (
      <Field label={t('workloadWizard.envName', '变量名')}>
        <Input
          value={row.name}
          onChange={(e) => updateRow(index, { name: e.target.value })}
          placeholder={t('workloadWizard.envNamePlaceholder', '例如: FOO')}
          className="h-9"
        />
      </Field>
    )

    switch (row.type) {
      case 'value':
        return (
          <>
            {nameInput}
            <Field
              label={t('workloadWizard.envValue', '值')}
              className="col-span-2"
            >
              <Input
                value={row.value}
                onChange={(e) => updateRow(index, { value: e.target.value })}
                placeholder={t(
                  'workloadWizard.envValuePlaceholder',
                  '例如: bar'
                )}
                className="h-9"
              />
            </Field>
          </>
        )
      case 'resource':
        return (
          <>
            {nameInput}
            <Field
              label={t('workloadWizard.envResource', '资源')}
              className="col-span-2"
            >
              <Select
                value={row.resource || RESOURCE_FIELDS[0]}
                onValueChange={(value) => updateRow(index, { resource: value })}
              >
                <SelectTrigger className="h-9 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RESOURCE_FIELDS.map((field) => (
                    <SelectItem key={field} value={field}>
                      {field}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </>
        )
      case 'podField':
        return (
          <>
            {nameInput}
            <Field
              label={t('workloadWizard.envFieldPath', '字段路径')}
              className="col-span-2"
            >
              <Select
                value={row.fieldPath || POD_FIELDS[0]}
                onValueChange={(value) =>
                  updateRow(index, { fieldPath: value })
                }
              >
                <SelectTrigger className="h-9 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {POD_FIELDS.map((field) => (
                    <SelectItem key={field} value={field}>
                      {field}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </>
        )
      case 'configMapKey':
        return (
          <>
            {nameInput}
            <Field label={t('workloadWizard.envConfigMap', 'ConfigMap')}>
              {renderResourcePicker(row, index, configMapNames, 'ConfigMap')}
            </Field>
            <Field label={t('workloadWizard.envKey', '键')}>
              {renderKeyPicker(row, index, configMapKeys(row.refName))}
            </Field>
          </>
        )
      case 'secretKey':
        return (
          <>
            {nameInput}
            <Field label={t('workloadWizard.envSecret', '密文')}>
              {renderResourcePicker(row, index, secretNames, 'Secret')}
            </Field>
            <Field label={t('workloadWizard.envKey', '键')}>
              {renderKeyPicker(row, index, secretKeys(row.refName))}
            </Field>
          </>
        )
      case 'configMap':
        return (
          <>
            <Field label={t('workloadWizard.envPrefix', '前缀')}>
              <Input
                value={row.prefix}
                onChange={(e) => updateRow(index, { prefix: e.target.value })}
                placeholder={t(
                  'workloadWizard.envPrefixPlaceholder',
                  '例如: FOO_'
                )}
                className="h-9"
              />
            </Field>
            <Field
              label={t('workloadWizard.envConfigMap', 'ConfigMap')}
              className="col-span-2"
            >
              {renderResourcePicker(row, index, configMapNames, 'ConfigMap')}
            </Field>
          </>
        )
      case 'secret':
        return (
          <>
            <Field label={t('workloadWizard.envPrefix', '前缀')}>
              <Input
                value={row.prefix}
                onChange={(e) => updateRow(index, { prefix: e.target.value })}
                placeholder={t(
                  'workloadWizard.envPrefixPlaceholder',
                  '例如: FOO_'
                )}
                className="h-9"
              />
            </Field>
            <Field
              label={t('workloadWizard.envSecret', '密文')}
              className="col-span-2"
            >
              {renderResourcePicker(row, index, secretNames, 'Secret')}
            </Field>
          </>
        )
    }
  }

  const typeOptions: Array<{ value: EnvRowType; label: string }> = [
    {
      value: 'value',
      label: t('workloadWizard.envTypeValue', 'Key/Value Pair'),
    },
    {
      value: 'resource',
      label: t('workloadWizard.envTypeResource', 'Resource'),
    },
    {
      value: 'configMapKey',
      label: t('workloadWizard.envTypeConfigMapKey', 'ConfigMap Key'),
    },
    {
      value: 'secretKey',
      label: t('workloadWizard.envTypeSecretKey', 'Secret key'),
    },
    {
      value: 'podField',
      label: t('workloadWizard.envTypePodField', 'Pod Field'),
    },
    { value: 'secret', label: t('workloadWizard.envTypeSecret', 'Secret') },
    {
      value: 'configMap',
      label: t('workloadWizard.envTypeConfigMap', 'ConfigMap'),
    },
  ]

  return (
    <div className="space-y-4">
      <h4 className="text-base font-medium">
        {t('workloadWizard.envTitle', '环境变量')}
      </h4>
      <div className="space-y-3">
        {rows.map((row, index) => (
          <div
            key={row.id}
            className="grid grid-cols-[150px_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] items-start gap-3"
          >
            <Field label={t('workloadWizard.envType', '类型')}>
              <Select
                value={row.type}
                onValueChange={(value) =>
                  changeType(index, value as EnvRowType)
                }
              >
                <SelectTrigger className="h-9 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {typeOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {renderFields(row, index)}
            <div className="space-y-1.5">
              <Label
                aria-hidden
                className="select-none text-xs font-normal text-transparent"
              >
                .
              </Label>
              <button
                type="button"
                className="flex h-9 items-center text-sm text-primary transition-colors hover:underline"
                onClick={() => commit(rows.filter((_, i) => i !== index))}
              >
                {t('workloadWizard.remove', '移除')}
              </button>
            </div>
          </div>
        ))}
      </div>

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 border-primary/40 bg-primary/5 text-xs text-primary hover:bg-primary/10 hover:text-primary"
        onClick={() => commit([...rows, emptyRow('value')])}
      >
        {t('workloadWizard.addVariable', '添加变量')}
      </Button>
    </div>
  )
}
