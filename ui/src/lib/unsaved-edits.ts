import { useEffect, useRef } from 'react'

/**
 * 「未保存编辑」登记处：创建表单与详情页 YAML 编辑在草稿生效期间向这里登记，
 * 切换集群等会丢弃草稿的动作先查一下并弹确认。
 *
 * 用模块级登记表而不是 React 状态：消费方（集群上下文）只需要同步读取
 * “有没有草稿”，各来源随组件卸载 / dirty 变假自动注销。确认丢弃时，登记了
 * onDiscard 的来源（弹窗、编辑态）会被回调收回自己的状态；只登记状态、随路由
 * 跳转卸载的来源（创建页 / 详情页）不必提供回调。
 */
const discarders = new Set<() => void>()

export function hasUnsavedEdits(): boolean {
  return discarders.size > 0
}

/** 用户已确认丢弃草稿：通知各来源自行关闭（关弹窗 / 退出编辑态）。 */
export function discardUnsavedEdits(): void {
  // 复制一份再遍历：回调会改变登记表（关闭组件触发注销）。
  Array.from(discarders).forEach((discard) => discard())
}

/**
 * dirty 为真期间登记一条未保存来源；变假或卸载时自动注销。
 * onDiscard 可选：给了就在「确认丢弃」时被调用。
 */
export function useUnsavedEdits(dirty: boolean, onDiscard?: () => void): void {
  // 回调放 ref：调用方通常传内联箭头函数，身份每次渲染都变，
  // 直接进依赖会让登记反复上下线。
  const discardRef = useRef(onDiscard)
  useEffect(() => {
    discardRef.current = onDiscard
  }, [onDiscard])

  useEffect(() => {
    if (!dirty) {
      return
    }
    const discard = () => discardRef.current?.()
    discarders.add(discard)
    return () => {
      discarders.delete(discard)
    }
  }, [dirty])
}
