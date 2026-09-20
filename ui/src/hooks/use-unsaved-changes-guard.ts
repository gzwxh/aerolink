import { useCallback, useState } from 'react'

/**
 * 弹窗的「关闭会丢草稿」防护：内容有改动时，点遮罩 / 按 Esc / 点右上角 X
 * 都不再直接关闭，而是先弹一次确认。Radix 的这几条关闭路径最终都会走到
 * Dialog 根的 onOpenChange(false)，所以拦在这里一处就够。
 *
 * dirty 由调用方给出（见 useDraftDirty）；onClose 是「确实要关闭」时的收尾动作，
 * 保存成功这类不需要确认的场景直接调 onClose 即可。
 */
export function useUnsavedChangesGuard({
  dirty,
  onClose,
}: {
  dirty: boolean
  onClose: () => void
}) {
  const [isConfirmOpen, setIsConfirmOpen] = useState(false)

  const handleOpenChange = useCallback(
    (open: boolean) => {
      // 打开由外部触发，这里不接管。
      if (open) {
        return
      }
      if (dirty) {
        setIsConfirmOpen(true)
        return
      }
      onClose()
    },
    [dirty, onClose]
  )

  const cancelClose = useCallback(() => setIsConfirmOpen(false), [])
  const discardAndClose = useCallback(() => {
    setIsConfirmOpen(false)
    onClose()
  }, [onClose])

  return {
    handleOpenChange,
    /** 展开到 <UnsavedChangesConfirmDialog /> 上。 */
    confirmDialogProps: {
      open: isConfirmOpen,
      onCancel: cancelClose,
      onConfirm: discardAndClose,
    },
  }
}

/**
 * 「有未保存修改」判定：把基线值与当前值对比（对象按 JSON 比较，字符串按值比较）。
 *
 * - 默认以首次渲染（即弹窗打开那一次）的值作基线：适合随 open 一起挂载的弹窗。
 * - 常驻挂载、打开时才从服务端装载数据的弹窗，把装载出的那份初始值作 baseline
 *   传进来，否则基线会停在第一次打开前的空值上。
 *
 * value 需要是 JSON 安全的状态：表单对象、YAML 草稿字符串等。baseline 按
 * 「传了就用它、没传才用首帧值」处理，所以不要传一个可能为 undefined 的值当基线。
 */
export function useDraftDirty(value: unknown, baseline?: unknown): boolean {
  const [mountBaseline] = useState(() => snapshot(value))
  return (
    snapshot(value) !==
    (baseline === undefined ? mountBaseline : snapshot(baseline))
  )
}

function snapshot(value: unknown): string {
  // 两类值各自加前缀，避免字符串草稿和 JSON 快照撞车；字符串直接比值，
  // 免得每次渲染都把长 YAML 序列化一遍。
  return typeof value === 'string'
    ? `str:${value}`
    : `json:${JSON.stringify(value)}`
}
