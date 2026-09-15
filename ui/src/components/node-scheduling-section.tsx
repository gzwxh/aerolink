import * as yaml from 'js-yaml'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { useResources } from '@/lib/api'
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
import {
  defaultSchedulingConfig,
  emptySchedulingTerm,
  emptyToleration,
  genSchedulingId,
  SchedulingConfig,
  TolerationForm,
} from '@/components/editors/deployment-form'

const OPERATORS: Array<{
  value: SchedulingRuleOp
  label: string
}> = [
  { value: 'In', label: '在列表中' },
  { value: 'NotIn', label: '不在列表中' },
  { value: 'Exists', label: '存在' },
  { value: 'DoesNotExist', label: '不存在' },
  { value: 'Gt', label: '大于' },
  { value: 'Lt', label: '小于' },
]

type SchedulingRuleOp =
  SchedulingConfig['terms'][number]['expressions'][number]['operator']

const EFFECTS: Array<{
  value: TolerationForm['effect']
  label: string
}> = [
  { value: '', label: '全部' },
  { value: 'NoSchedule', label: 'NoSchedule' },
  { value: 'PreferNoSchedule', label: 'PreferNoSchedule' },
  { value: 'NoExecute', label: 'NoExecute' },
]

const parseValues = (raw: string): string[] =>
  raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)

/** Parse scheduling fields from a workload YAML into panel state. */
export function parseSchedulingFromYaml(content: string): SchedulingConfig {
  const config = defaultSchedulingConfig()
  try {
    const doc = yaml.load(content) as
      | {
          spec?: {
            template?: { spec?: Record<string, unknown> }
            jobTemplate?: {
              spec?: { template?: { spec?: Record<string, unknown> } }
            }
          }
        }
      | undefined
      | null
    let podSpec =
      (doc?.spec?.template?.spec as Record<string, unknown> | undefined) ||
      undefined
    if (!podSpec && doc?.spec?.jobTemplate) {
      podSpec = doc.spec.jobTemplate.spec?.template?.spec
    }
    if (!podSpec) return config

    config.priorityClassName = (podSpec.priorityClassName as string) || ''
    config.tolerations = (
      (podSpec.tolerations as Array<Record<string, unknown>>) || []
    ).map((t) => ({
      id: genSchedulingId(),
      key: (t.key as string) || '',
      operator: t.operator === 'Exists' ? 'Exists' : 'Equal',
      value: (t.value as string) || '',
      effect: ((t.effect as string) || '') as TolerationForm['effect'],
      tolerationSeconds:
        t.tolerationSeconds !== undefined ? String(t.tolerationSeconds) : '',
    }))

    if (podSpec.nodeName) {
      config.mode = 'specific'
      config.nodeName = podSpec.nodeName as string
      return config
    }

    const affinity = podSpec.affinity as
      | {
          nodeAffinity?: {
            requiredDuringSchedulingIgnoredDuringExecution?: {
              nodeSelectorTerms?: Array<{
                matchExpressions?: Array<{
                  key?: string
                  operator?: string
                  values?: string[]
                }>
              }>
            }
          }
        }
      | undefined
    const terms =
      affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution
        ?.nodeSelectorTerms
    if (terms && terms.length > 0) {
      config.mode = 'rules'
      config.terms = terms.map((term) => ({
        id: genSchedulingId(),
        expressions: (term.matchExpressions || []).map((expr) => ({
          id: genSchedulingId(),
          key: expr.key || '',
          operator: (OPERATORS.some((op) => op.value === expr.operator)
            ? expr.operator
            : 'In') as SchedulingRuleOp,
          values: (expr.values || []).join(', '),
        })),
      }))
    }
    return config
  } catch {
    return config
  }
}

/** Write panel state into a workload YAML's spec.template.spec. */
export function applySchedulingToYaml(
  content: string,
  config: SchedulingConfig
): string {
  const doc = yaml.load(content) as
    | { spec?: { template?: { spec?: Record<string, unknown> } } }
    | undefined
    | null
  if (!doc || typeof doc !== 'object') return content

  doc.spec = doc.spec || {}
  doc.spec.template = doc.spec.template || {}
  doc.spec.template.spec = doc.spec.template.spec || {}
  const podSpec = doc.spec.template.spec

  const fields = buildSchedulingPodSpecLocal(config)
  delete podSpec.nodeName
  delete podSpec.nodeSelector
  const affinity = podSpec.affinity as Record<string, unknown> | undefined
  if (affinity) {
    delete affinity.nodeAffinity
    if (Object.keys(affinity).length === 0) delete podSpec.affinity
  }
  delete podSpec.tolerations
  delete podSpec.priorityClassName
  Object.assign(podSpec, fields)

  return yaml.dump(doc, { indent: 2, noRefs: true, lineWidth: -1 })
}

function buildSchedulingPodSpecLocal(
  scheduling: SchedulingConfig
): Record<string, unknown> {
  const podSpec: Record<string, unknown> = {}
  if (scheduling.mode === 'specific' && scheduling.nodeName.trim()) {
    podSpec.nodeName = scheduling.nodeName.trim()
  }
  if (scheduling.mode === 'rules') {
    const terms = scheduling.terms
      .map((term) => ({
        matchExpressions: term.expressions
          .filter((expr) => expr.key.trim())
          .map((expr) => ({
            key: expr.key.trim(),
            operator: expr.operator,
            ...(expr.operator !== 'Exists' && expr.operator !== 'DoesNotExist'
              ? { values: parseValues(expr.values) }
              : {}),
          })),
      }))
      .filter((term) => term.matchExpressions.length > 0)
    if (terms.length > 0) {
      podSpec.affinity = {
        nodeAffinity: {
          requiredDuringSchedulingIgnoredDuringExecution: {
            nodeSelectorTerms: terms,
          },
        },
      }
    }
  }
  if (scheduling.tolerations.length > 0) {
    podSpec.tolerations = scheduling.tolerations.map((t) => {
      const toleration: Record<string, unknown> = {
        key: t.key.trim(),
        operator: t.operator,
      }
      if (t.operator === 'Equal') toleration.value = t.value.trim()
      if (t.effect) toleration.effect = t.effect
      const seconds = Number(t.tolerationSeconds)
      if (
        t.effect === 'NoExecute' &&
        t.tolerationSeconds &&
        !Number.isNaN(seconds)
      ) {
        toleration.tolerationSeconds = seconds
      }
      return toleration
    })
  }
  if (scheduling.priorityClassName.trim()) {
    podSpec.priorityClassName = scheduling.priorityClassName.trim()
  }
  return podSpec
}

/** Shared hook: sorted node names of the current cluster. */
function useNodeNames(): string[] {
  const { data: nodes = [] } = useResources<'nodes'>('nodes', undefined, {
    staleTime: 60_000,
  })
  return nodes
    .map((n) => n.metadata?.name)
    .filter((n): n is string => !!n)
    .sort((a, b) => a.localeCompare(b))
}

/**
 * Tencent-cloud-style node scheduling panel (controlled component).
 * Also used by the YAML-editing dialogs through the parse/apply helpers.
 */
export function NodeSchedulingSection({
  value,
  onChange,
}: {
  value: SchedulingConfig
  onChange: (next: SchedulingConfig) => void
}) {
  const { t } = useTranslation()
  const nodeNames = useNodeNames()

  const config = value

  const modeLabels: Record<SchedulingConfig['mode'], string> = {
    any: t('nodeScheduling.anyNode', '在任何可用节点上运行 Pod'),
    specific: t('nodeScheduling.specificNode', '在指定节点上运行 Pod'),
    rules: t('nodeScheduling.matchRules', '在匹配调度规则的节点上运行 Pod'),
  }

  return (
    <div className="space-y-3 rounded-md border p-3">
      <h3 className="text-sm font-semibold">
        {t('nodeScheduling.title', '节点调度')}
      </h3>

      {/* Scheduling mode */}
      <div className="space-y-1.5">
        {(['any', 'specific', 'rules'] as SchedulingConfig['mode'][]).map(
          (mode) => (
            <label
              key={mode}
              className="flex cursor-pointer items-center gap-2 text-sm"
            >
              <input
                type="radio"
                name="scheduling-mode"
                className="h-4 w-4 accent-primary"
                checked={config.mode === mode}
                onChange={() => onChange({ ...config, mode })}
              />
              {modeLabels[mode]}
            </label>
          )
        )}
      </div>

      {/* Specific node */}
      {config.mode === 'specific' && (
        <div className="space-y-2 pl-6">
          <Label className="text-xs">
            {t('nodeScheduling.nodeName', '节点名称')}
          </Label>
          <Select
            value={config.nodeName}
            onValueChange={(v) => onChange({ ...config, nodeName: v })}
          >
            <SelectTrigger className="h-9">
              <SelectValue
                placeholder={t('nodeScheduling.selectNode', '选择节点...')}
              />
            </SelectTrigger>
            <SelectContent>
              {nodeNames.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {nodeNames.length === 0 && (
            <p className="text-xs text-muted-foreground">
              {t('nodeScheduling.noNodes', '暂无可用节点。')}
            </p>
          )}
        </div>
      )}

      {/* Scheduling rules (node affinity) */}
      {config.mode === 'rules' && (
        <div className="space-y-3 pl-6">
          {config.terms.map((term, termIdx) => (
            <div key={term.id} className="rounded-md border p-2.5">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold text-muted-foreground">
                  {t('nodeScheduling.selectorN', {
                    index: termIdx + 1,
                    defaultValue: `节点选择器 ${termIdx + 1}`,
                  })}
                </span>
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-destructive"
                  onClick={() =>
                    onChange({
                      ...config,
                      terms: config.terms.filter((tm) => tm.id !== term.id),
                    })
                  }
                >
                  {t('nodeScheduling.removeSelector', '移除')}
                </button>
              </div>
              <div className="space-y-2">
                {term.expressions.map((expr) => (
                  <div
                    key={expr.id}
                    className="grid grid-cols-[minmax(0,1fr)_130px_minmax(0,1fr)_auto] items-center gap-2"
                  >
                    <Input
                      value={expr.key}
                      onChange={(e) =>
                        onChange({
                          ...config,
                          terms: config.terms.map((tm) =>
                            tm.id !== term.id
                              ? tm
                              : {
                                  ...tm,
                                  expressions: tm.expressions.map((ex) =>
                                    ex.id !== expr.id
                                      ? ex
                                      : { ...ex, key: e.target.value }
                                  ),
                                }
                          ),
                        })
                      }
                      placeholder={t('nodeScheduling.key', '键')}
                      className="h-8"
                    />
                    <Select
                      value={expr.operator}
                      onValueChange={(v) =>
                        onChange({
                          ...config,
                          terms: config.terms.map((tm) =>
                            tm.id !== term.id
                              ? tm
                              : {
                                  ...tm,
                                  expressions: tm.expressions.map((ex) =>
                                    ex.id !== expr.id
                                      ? ex
                                      : {
                                          ...ex,
                                          operator: v as SchedulingRuleOp,
                                        }
                                  ),
                                }
                          ),
                        })
                      }
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {OPERATORS.map((op) => (
                          <SelectItem key={op.value} value={op.value}>
                            {op.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      value={expr.values}
                      onChange={(e) =>
                        onChange({
                          ...config,
                          terms: config.terms.map((tm) =>
                            tm.id !== term.id
                              ? tm
                              : {
                                  ...tm,
                                  expressions: tm.expressions.map((ex) =>
                                    ex.id !== expr.id
                                      ? ex
                                      : { ...ex, values: e.target.value }
                                  ),
                                }
                          ),
                        })
                      }
                      placeholder={
                        expr.operator === 'In' || expr.operator === 'NotIn'
                          ? t('nodeScheduling.valuesHint', '值（逗号分隔）')
                          : expr.operator === 'Gt' || expr.operator === 'Lt'
                            ? t('nodeScheduling.numberHint', '数值')
                            : t('nodeScheduling.notRequired', '无需填写')
                      }
                      className="h-8"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 px-2 text-xs text-muted-foreground hover:text-destructive"
                      onClick={() =>
                        onChange({
                          ...config,
                          terms: config.terms.map((tm) =>
                            tm.id !== term.id
                              ? tm
                              : {
                                  ...tm,
                                  expressions: tm.expressions.filter(
                                    (ex) => ex.id !== expr.id
                                  ),
                                }
                          ),
                        })
                      }
                    >
                      {t('nodeScheduling.remove', '移除')}
                    </Button>
                  </div>
                ))}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2 h-7 text-xs"
                onClick={() =>
                  onChange({
                    ...config,
                    terms: config.terms.map((tm) =>
                      tm.id !== term.id
                        ? tm
                        : {
                            ...tm,
                            expressions: [
                              ...tm.expressions,
                              {
                                id: genSchedulingId(),
                                key: '',
                                operator: 'In',
                                values: '',
                              },
                            ],
                          }
                    ),
                  })
                }
              >
                {t('nodeScheduling.addRule', '添加规则')}
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => {
              if (config.terms.length >= 5) {
                toast.warning(
                  t('nodeScheduling.maxSelectors', '最多支持 5 个节点选择器')
                )
                return
              }
              onChange({
                ...config,
                terms: [...config.terms, emptySchedulingTerm()],
              })
            }}
          >
            {t('nodeScheduling.addSelector', '添加节点选择器')}
          </Button>
          <p className="text-xs text-muted-foreground">
            {t(
              'nodeScheduling.selectorHint',
              '同一选择器内的规则同时满足（AND），多个选择器之间满足其一即可（OR）。'
            )}
          </p>
        </div>
      )}

      {/* Tolerations */}
      <div className="space-y-2 border-t pt-3">
        <h4 className="text-sm font-semibold">
          {t('nodeScheduling.tolerationsTitle', '容忍度')}
        </h4>
        {config.tolerations.map((tol) => (
          <div
            key={tol.id}
            className="grid grid-cols-[minmax(0,1fr)_100px_minmax(0,1fr)_150px_110px_auto] items-center gap-2"
          >
            <Input
              value={tol.key}
              onChange={(e) =>
                onChange({
                  ...config,
                  tolerations: config.tolerations.map((item) =>
                    item.id !== tol.id ? item : { ...item, key: e.target.value }
                  ),
                })
              }
              placeholder={t('nodeScheduling.key', '键')}
              className="h-8"
            />
            <Select
              value={tol.operator}
              onValueChange={(v) =>
                onChange({
                  ...config,
                  tolerations: config.tolerations.map((item) =>
                    item.id !== tol.id
                      ? item
                      : { ...item, operator: v as TolerationForm['operator'] }
                  ),
                })
              }
            >
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Equal">
                  {t('nodeScheduling.opEqual', '等于')}
                </SelectItem>
                <SelectItem value="Exists">
                  {t('nodeScheduling.opExists', '存在')}
                </SelectItem>
              </SelectContent>
            </Select>
            <Input
              value={tol.value}
              onChange={(e) =>
                onChange({
                  ...config,
                  tolerations: config.tolerations.map((item) =>
                    item.id !== tol.id
                      ? item
                      : { ...item, value: e.target.value }
                  ),
                })
              }
              placeholder={
                tol.operator === 'Exists'
                  ? t('nodeScheduling.notRequired', '无需填写')
                  : t('nodeScheduling.value', '值')
              }
              className="h-8"
            />
            <Select
              value={tol.effect || 'all'}
              onValueChange={(v) =>
                onChange({
                  ...config,
                  tolerations: config.tolerations.map((item) =>
                    item.id !== tol.id
                      ? item
                      : {
                          ...item,
                          effect:
                            v === 'all' ? '' : (v as TolerationForm['effect']),
                        }
                  ),
                })
              }
            >
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EFFECTS.map((eff) => (
                  <SelectItem
                    key={eff.value || 'all'}
                    value={eff.value || 'all'}
                  >
                    {eff.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              type="number"
              min={0}
              value={tol.tolerationSeconds}
              onChange={(e) =>
                onChange({
                  ...config,
                  tolerations: config.tolerations.map((item) =>
                    item.id !== tol.id
                      ? item
                      : { ...item, tolerationSeconds: e.target.value }
                  ),
                })
              }
              placeholder={t('nodeScheduling.tolerationSeconds', '容忍(秒)')}
              className="h-8"
              disabled={tol.effect !== 'NoExecute'}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-xs text-muted-foreground hover:text-destructive"
              onClick={() =>
                onChange({
                  ...config,
                  tolerations: config.tolerations.filter(
                    (item) => item.id !== tol.id
                  ),
                })
              }
            >
              {t('nodeScheduling.remove', '移除')}
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() =>
            onChange({
              ...config,
              tolerations: [...config.tolerations, emptyToleration()],
            })
          }
        >
          {t('nodeScheduling.addToleration', '添加容忍度')}
        </Button>
      </div>

      {/* Priority class */}
      <div className="space-y-2 border-t pt-3">
        <h4 className="text-sm font-semibold">
          {t('nodeScheduling.priorityTitle', '优先级')}
        </h4>
        <Input
          value={config.priorityClassName}
          onChange={(e) =>
            onChange({ ...config, priorityClassName: e.target.value })
          }
          placeholder={t('nodeScheduling.priorityClassName', '优先级名称')}
          className="h-8"
        />
        <p className="text-xs text-muted-foreground">
          {t(
            'nodeScheduling.priorityHint',
            '填写集群中已存在的 PriorityClass 名称，留空则不设置。'
          )}
        </p>
      </div>
    </div>
  )
}
