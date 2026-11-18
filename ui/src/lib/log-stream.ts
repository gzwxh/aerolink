// 控制台的「全部 Pod」通配符，与后端 `common.AllNamespaces` 一致。
const ALL_PODS = '_all'

/**
 * 日志流的目标 Pod。
 *
 * 没有解析出具体 Pod 时（Pod 列表还没回来、被 watch 限额拒绝，或打开的人只有
 * `pods/log` 而拿不到列表），只要带了 labelSelector 就退回 `_all`，由后端按选择器
 * 聚合该工作负载的全部 Pod（见 `pkg/resources/logs_handler.go`）。否则日志面板的
 * `enabled` 永远是 false：一条流都不会建立，界面停在空白且没有恢复路径。
 *
 * 既没有 Pod 名也没有 labelSelector 时返回空串——没有目标就不建立连接。
 */
export function resolveLogStreamPod(
  podName?: string,
  labelSelector?: string
): string {
  if (podName) {
    return podName
  }
  return labelSelector ? ALL_PODS : ''
}
