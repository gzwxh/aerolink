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
