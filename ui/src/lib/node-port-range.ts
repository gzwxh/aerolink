/**
 * 集群真实的 NodePort 范围，读不到时为 null。
 *
 * 范围来自 kube-apiserver 的 `--service-node-port-range`
 * （`GET /admin/clusters/:name/nodeport-range`，见 `pkg/cluster/nodeport_range.go`）。
 * 接口读不到那个 flag 时会回退成 K8s 默认的 30000-32767 并标 `source: "default"`；
 * 接口本身还在 admin 组，普通用户直接 403。这两种情况都不能把 30000-32767 当成集群事实 ——
 * 拿它校验会把合法端口（集群自定义过范围时）标红，因此这里只认
 * `source: "kube-apiserver"` 的结果，其余一律交给 API 判。
 */
export function knownNodePortRange(range?: {
  min: number
  max: number
  source?: string
}): { min: number; max: number } | null {
  if (!range || range.source !== 'kube-apiserver') return null
  if (!range.min || !range.max || range.max <= range.min) return null
  return { min: range.min, max: range.max }
}
