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
  emptySchedulingTerm,
  emptyToleration,
  genSchedulingId,
  SCHEDULING_OPERATORS,
  SchedulingConfig,
  SchedulingTerm,
  TolerationForm,
  type SchedulingOperator,
} from '@/components/editors/deployment-form'

type SchedulingRuleOp = SchedulingOperator

const OPERATORS = SCHEDULING_OPERATORS

const EFFECTS: Array<{ value: TolerationForm['effect']; label: string }> = [
  { value: '', label: '全部' },
  { value: 'NoSchedule', label: 'NoSchedule' },
  { value: 'PreferNoSchedule', label: 'PreferNoSchedule' },
  { value: 'NoExecute', label: 'NoExecute' },
]

/** 共享 hook：当前集群排序后的节点名。 */
function useNodeNames(): string[] {
  const { data: nodes = [] } = useResources<'nodes'>('nodes', undefined, {
    staleTime: 60_000,
  })
  return nodes
    .map((n) => n.metadata?.name)
    .filter((n): n is string => !!n)
    .sort((a, b) => a.localeCompare(b))
}

const newExpression = () => ({
  id: genSchedulingId(),
  key: '',
  operator: 'In' as SchedulingRuleOp,
  values: '',
})

/** 节点调度 tab: scheduling mode + node affinity rules. */
export function NodeSchedulingBasic({
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
    <div className="space-y-3">
      <div className="space-y-1.5">
        {(['any', 'specific', 'rules'] as SchedulingConfig['mode'][]).map(
          (mode) => (
            <label
              key={mode}
              className="flex cursor-pointer items-center gap-2 text-sm"
            >
              <input
                type="radio"
                name="scheduling-mode-basic"
                className="h-4 w-4 accent-primary"
                checked={config.mode === mode}
                onChange={() => onChange({ ...config, mode })}
              />
              {modeLabels[mode]}
            </label>
          )
        )}
      </div>

      {config.mode === 'specific' && (
        <div className="space-y-2 pl-6">
          <Label className="text-xs font-normal text-muted-foreground">
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

      {config.mode === 'rules' && (
        <div className="space-y-3 pl-6">
          {config.terms.map((term: SchedulingTerm, termIdx: number) => (
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
                      className="h-9"
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
                      <SelectTrigger className="h-9">
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
                      className="h-9"
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
                className="mt-2 border-primary/40 bg-primary/5 text-xs text-primary hover:bg-primary/10 hover:text-primary"
                onClick={() =>
                  onChange({
                    ...config,
                    terms: config.terms.map((tm) =>
                      tm.id !== term.id
                        ? tm
                        : {
                            ...tm,
                            expressions: [...tm.expressions, newExpression()],
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
            className="border-primary/40 bg-primary/5 text-xs text-primary hover:bg-primary/10 hover:text-primary"
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
    </div>
  )
}

/** 资源 tab: tolerations editor. */
export function TolerationsEditor({
  value,
  onChange,
}: {
  value: SchedulingConfig
  onChange: (next: SchedulingConfig) => void
}) {
  const { t } = useTranslation()
  const config = value
  return (
    <div className="space-y-2">
      <h4 className="text-base font-medium">
        {t('nodeScheduling.tolerationsTitle', '容忍度')}
      </h4>
      {config.tolerations.map((tol: TolerationForm) => (
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
            className="h-9"
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
            <SelectTrigger className="h-9">
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
                  item.id !== tol.id ? item : { ...item, value: e.target.value }
                ),
              })
            }
            placeholder={
              tol.operator === 'Exists'
                ? t('nodeScheduling.notRequired', '无需填写')
                : t('nodeScheduling.value', '值')
            }
            className="h-9"
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
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EFFECTS.map((eff) => (
                <SelectItem key={eff.value || 'all'} value={eff.value || 'all'}>
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
            className="h-9"
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
        className="border-primary/40 bg-primary/5 text-xs text-primary hover:bg-primary/10 hover:text-primary"
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
  )
}

/** 资源 tab: priority class name. */
export function PriorityEditor({
  value,
  onChange,
}: {
  value: SchedulingConfig
  onChange: (next: SchedulingConfig) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="space-y-2">
      <h4 className="text-base font-medium">
        {t('nodeScheduling.priorityTitle', '优先级')}
      </h4>
      <div className="grid grid-cols-2 gap-3">
        <Input
          value={value.priorityClassName}
          onChange={(e) =>
            onChange({ ...value, priorityClassName: e.target.value })
          }
          placeholder={t('nodeScheduling.priorityClassName', '优先级名称')}
          className="h-9"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          'nodeScheduling.priorityHint',
          '填写集群中已存在的 PriorityClass 名称，留空则不设置。'
        )}
      </p>
    </div>
  )
}
