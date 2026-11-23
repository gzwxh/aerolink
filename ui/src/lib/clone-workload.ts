/**
 * 克隆工作负载时改写 selector 与 Pod 模板标签。
 *
 * 为什么必须做：Deployment / StatefulSet / DaemonSet / ReplicaSet 靠 `spec.selector`
 * 认领 Pod。原样复制 selector 会让新旧两个工作负载的 selector 一模一样——k8s 不会拦
 * （它不检查跨对象的 selector 重叠），但两边控制器会争抢同一批 Pod，**界面上两个详情页
 * 的 Pod 列表也会互相串**（Pod 列表就是按 selector 查的，见 pages/deployment-detail.tsx）。
 *
 * 单独放在 lib 而不是留在组件文件里：组件文件导出非组件会破坏 fast refresh，
 * 而这段是纯数据变换，测试也不该依赖 DOM（见 clone-workload.test.ts）。
 */

type MutableResource = Record<string, unknown> & {
  metadata?: Record<string, unknown>
  spec?: Record<string, unknown>
}

/** 带 selector 的工作负载：Pod 由 selector 认领，克隆时必须换掉 selector 与模板标签。 */
const WORKLOAD_SELECTOR_TYPES = [
  'deployments',
  'statefulsets',
  'daemonsets',
  'replicasets',
]

/** 该资源类型是否靠 selector 认领 Pod（克隆时需要改写 selector 与关联 Service）。 */
export function isWorkloadSelectorType(resourceType: string): boolean {
  return WORKLOAD_SELECTOR_TYPES.includes(resourceType)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  return value as Record<string, unknown>
}

/** 两个标签表是否逐项相同（键集合与取值都一致）。 */
function sameLabels(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined
) {
  if (!left || !right) {
    return false
  }
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  if (
    leftKeys.length !== rightKeys.length ||
    leftKeys.some((key, index) => key !== rightKeys[index])
  ) {
    return false
  }
  return leftKeys.every((key) => left[key] === right[key])
}

/**
 * 把克隆出来的工作负载的 selector 与 Pod 模板标签指向新名字。
 *
 * 改写策略：取值等于源名字的标签（`app: nginx`、`name: nginx`…）改成新名字；
 * 兜底：若 selector 与源对象逐项相同（说明没有任何值等于源名字，例如 `app: web`），
 * 挑一个键指向新名字——否则 selector 仍然与源对象相同。
 * 模板标签必须同步改：k8s 要求 selector 匹配模板标签，否则创建会被拒绝。
 *
 * 返回值是同一个对象（就地修改），便于调用方继续用原来的 manifest 提交。
 */
export function alignWorkloadSelector(
  cloned: MutableResource,
  source: unknown,
  resourceType: string,
  sourceName: string,
  targetName: string
): void {
  if (!WORKLOAD_SELECTOR_TYPES.includes(resourceType)) {
    return
  }

  const spec = asRecord(cloned.spec)
  const sourceSpec = asRecord(asRecord(source)?.spec)
  if (!spec || !sourceSpec) {
    return
  }

  const selectorWrapper = asRecord(spec.selector)
  const selector = asRecord(selectorWrapper?.matchLabels)
  const templateLabels = asRecord(
    asRecord(asRecord(spec.template)?.metadata)?.labels
  )
  if (!selector || !templateLabels) {
    return
  }

  const rename = (labels: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(labels)) {
      if (value === sourceName) {
        labels[key] = targetName
      }
    }
  }
  rename(selector)
  rename(templateLabels)

  if (Array.isArray(selectorWrapper?.matchExpressions)) {
    for (const expression of selectorWrapper.matchExpressions) {
      const item = asRecord(expression)
      if (item && Array.isArray(item.values)) {
        item.values = item.values.map((value) =>
          value === sourceName ? targetName : value
        )
      }
    }
  }

  const sourceSelector = asRecord(
    asRecord(sourceSpec.selector as unknown)?.matchLabels
  )
  if (sameLabels(selector, sourceSelector)) {
    const key = Object.keys(selector).sort()[0]
    if (key) {
      selector[key] = targetName
      templateLabels[key] = targetName
    }
  }
}

/**
 * 工作负载的 `spec.selector.matchLabels`。
 * 带 matchExpressions 时返回 undefined：那种 selector 的集合关系在这里算不准，
 * 宁可放过也不误拦合法的克隆。
 */
function selectorMatchLabels(
  resource: unknown
): Record<string, unknown> | undefined {
  const selector = asRecord(asRecord(asRecord(resource)?.spec)?.selector)
  if (!selector || selector.matchExpressions !== undefined) {
    return undefined
  }
  const matchLabels = asRecord(selector.matchLabels)
  return matchLabels && Object.keys(matchLabels).length > 0
    ? matchLabels
    : undefined
}

/**
 * 克隆体的 selector 是否与命名空间里某个现存工作负载完全相同（验收台账 D-153）。
 *
 * `alignWorkloadSelector` 只在**生成草稿那一刻**跑一次，而草稿是一份用户可以自由改的
 * YAML 文本：用户把名字从 `x-copy` 改成 `y` 之后，Pod 标签仍是 `app: x-copy`。于是从同
 * 一个源连克两次会得到 selector 完全相同的两个负载 —— k8s 不拦（它不检查跨对象重叠），
 * 但两边控制器会争抢同一批 Pod，关联 Service 的端点也跨负载混在一起。
 *
 * 让标签跟随名称重算会覆盖用户已经手改过的草稿内容，不能那么做；所以把关放在提交前：
 * 谁的 selector 与现存某个负载逐项相同，就不让提交，并把撞上的对象名报出来。
 * 返回被撞对象的 name，没有冲突返回 null。
 */
export function findSelectorCollision(
  candidate: unknown,
  existing: unknown[]
): string | null {
  const selector = selectorMatchLabels(candidate)
  if (!selector) {
    return null
  }
  const candidateName = asRecord(asRecord(candidate)?.metadata)?.name
  for (const item of existing) {
    const name = asRecord(asRecord(item)?.metadata)?.name
    if (typeof name !== 'string' || !name || name === candidateName) {
      continue
    }
    if (sameLabels(selectorMatchLabels(item), selector)) {
      return name
    }
  }
  return null
}
