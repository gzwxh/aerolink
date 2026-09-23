/**
 * 克隆工作负载时，把**选中它的 Service** 一并带走。
 *
 * 为什么需要：克隆出来的 Deployment 有自己的 Pod（标签已按新名字改写，见 clone-workload.ts），
 * 但原命名空间里的 Service 仍然只选旧 Pod。用户想让新应用也能被访问时，只能手写一个 Service；
 * 而如果直接复制原 Service 的 YAML，又会**与原名冲突**（创建失败）。
 * 所以克隆时把关联 Service 一起放进草稿，并同步改名与 selector。
 *
 * 判定"关联"的口径：Service 的 `spec.selector` 是 Pod 标签的子集（k8s 就是这么匹配的）。
 * 没有 selector 的 Service（ExternalName、手动 Endpoints 那类）不参与。
 */

type MutableResource = Record<string, unknown> & {
  metadata?: Record<string, unknown>
  spec?: Record<string, unknown>
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  return value as Record<string, unknown>
}

/** 该 Service 是否选中这组 Pod 标签（selector 的每个键值都命中）。 */
export function serviceSelectsPodLabels(
  service: unknown,
  podLabels: Record<string, unknown> | undefined
): boolean {
  const spec = asRecord(asRecord(service)?.spec)
  const selector = asRecord(spec?.selector)
  if (!selector || !podLabels) {
    return false
  }
  const entries = Object.entries(selector)
  if (entries.length === 0) {
    return false
  }
  return entries.every(([key, value]) => podLabels[key] === value)
}

/**
 * Service 克隆后的名字。
 *
 * 常见部署里 Service 与工作负载同名（`nginx` 的 Service 也叫 `nginx`），那种情况直接用
 * 克隆体的名字（`nginx-copy`），与原 Service 也不会撞名；名字无关时退化成加后缀。
 */
export function serviceCloneName(
  serviceName: string,
  sourceName: string,
  targetName: string
): string {
  return serviceName === sourceName ? targetName : `${serviceName}-copy`
}

/**
 * 把 Service 的 selector 指向新的 Pod 标签。
 *
 * 规则与 clone-workload.ts 的 alignWorkloadSelector 完全一致（取值等于源名字的改成新名字），
 * 这样 selector 才能命中克隆体的 Pod；selector 未命中的键保持不动，
 * 以免把用户自定义的额外筛选条件抹掉。
 */
export function rewriteServiceSelector(
  cloned: MutableResource,
  sourceName: string,
  targetName: string
): void {
  const selector = asRecord(asRecord(cloned.spec)?.selector)
  if (!selector) {
    return
  }
  for (const [key, value] of Object.entries(selector)) {
    if (value === sourceName) {
      selector[key] = targetName
    }
  }
}
