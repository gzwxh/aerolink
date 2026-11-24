/**
 * 从任意 Kubernetes 对象的 status 里提取「状态条件」。
 *
 * 起因是验收台账 D-175：Gateway API / cert-manager 这些面的健康信号**只有条件**——
 * HTTPRoute 的 `Accepted` / `ResolvedRefs`、Gateway 的 `Programmed`、Certificate 的
 * `Ready`。界面上原先完全不呈现，只能翻 YAML；而「路由配了却没生效」恰恰只有这里看得出来。
 *
 * 条件在 CR 里的位置不统一，覆盖已实测到的三处：
 *   - `status.conditions[]`              —— 绝大多数（含 cert-manager 各面、Gateway）
 *   - `status.parents[].conditions[]`    —— Gateway API v1 的路由（按 parentRef 分组）
 *   - `status.listeners[].conditions[]`  —— Gateway 的逐监听器状态
 * 其它形态遇到时再补，不做无依据的猜测。
 */

export interface ResourceCondition {
  type: string
  status: string
  reason?: string
  message?: string
  /** 条件来自哪个分组（parent 名 / 监听器名）；顶层条件没有。 */
  scope?: string
  lastTransitionTime?: string
}

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null
}

function asArray(value: unknown): UnknownRecord[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map((item) => asRecord(item))
    .filter((item): item is UnknownRecord => item !== null)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function toCondition(
  raw: UnknownRecord,
  scope?: string
): ResourceCondition | null {
  const type = text(raw.type)
  if (!type) {
    return null
  }
  return {
    type,
    // 条件值规范上是 True/False/Unknown；缺字段时显示 `-` 而不是留空。
    status: text(raw.status) ?? '-',
    reason: text(raw.reason),
    message: text(raw.message),
    scope,
    lastTransitionTime: text(raw.lastTransitionTime),
  }
}

export function extractConditions(resource: unknown): ResourceCondition[] {
  const status = asRecord(asRecord(resource)?.status)
  if (!status) {
    return []
  }

  const out: ResourceCondition[] = []
  const push = (raw: UnknownRecord, scope?: string) => {
    const condition = toCondition(raw, scope)
    if (condition) {
      out.push(condition)
    }
  }

  asArray(status.conditions).forEach((raw) => push(raw))

  // 路由的条件挂在每个 parent 下：不带 parent 名就看不出是哪个网关拒绝的。
  asArray(status.parents).forEach((parent) => {
    const parentName = text(parent.parentName)
    asArray(parent.conditions).forEach((raw) => push(raw, parentName))
  })

  asArray(status.listeners).forEach((listener) => {
    const name = text(listener.name)
    asArray(listener.conditions).forEach((raw) =>
      push(raw, name ? `listener:${name}` : undefined)
    )
  })

  return out
}

/** True 视为通过；False / Unknown 都需要人看一眼。 */
export function isConditionPassing(condition: ResourceCondition): boolean {
  return condition.status === 'True'
}

export function hasFailingCondition(conditions: ResourceCondition[]): boolean {
  return conditions.some((condition) => !isConditionPassing(condition))
}
