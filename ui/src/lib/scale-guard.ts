/**
 * 扩缩容输入的把关逻辑（验收台账 D-70）。
 *
 * 之前这个框几乎是裸的：`parseInt(e.target.value) || 0` 会把「非数字」静默变成 0，
 * 负数照样发给 apiserver（回 500 + 英文原文），而把副本数改成 0 更是点一下就生效
 * —— 对线上服务来说这是「全部 Pod 立即停掉」级别的操作，不该没有任何拦阻。
 */

/** 触发二次确认的放大阈值：不是集群上限，只是「一次建这么多 Pod 值得确认一下」。 */
export const SCALE_CONFIRM_AT = 100

export type ScaleDraft = {
  /** 输入框里的原始文本；保留文本才能区分「空」与「0」。 */
  input: string
  /** 当前副本数，用来判断这次是不是「从有到无」。 */
  current: number
}

export type ScaleCheck =
  | { kind: 'invalid'; messageKey: string }
  | { kind: 'needsConfirm'; messageKey: string; replicas: number }
  | { kind: 'ready'; replicas: number }

/**
 * 把草稿值判成三档：非法（拦住）、需要显式确认、可以直接提交。
 *
 * 空串与非数字**不再当成 0**：那正是「打字打一半顺手点了提交」就把服务缩没的路径。
 */
export function checkScaleDraft({ input, current }: ScaleDraft): ScaleCheck {
  const text = input.trim()
  if (text === '') {
    return { kind: 'invalid', messageKey: 'detail.scale.empty' }
  }
  // 只接受十进制非负整数：不接受 1e3、-0、1.5、空格夹数字等写法
  if (!/^\d+$/.test(text)) {
    return { kind: 'invalid', messageKey: 'detail.scale.notInteger' }
  }

  const replicas = Number(text)
  if (!Number.isSafeInteger(replicas)) {
    return { kind: 'invalid', messageKey: 'detail.scale.notInteger' }
  }

  if (replicas === 0 && current > 0) {
    // 缩到 0 会让这个服务一个 Pod 都不剩，必须勾选确认才放行
    return {
      kind: 'needsConfirm',
      messageKey: 'detail.scale.confirmZero',
      replicas,
    }
  }
  if (replicas >= SCALE_CONFIRM_AT) {
    return {
      kind: 'needsConfirm',
      messageKey: 'detail.scale.confirmLarge',
      replicas,
    }
  }

  return { kind: 'ready', replicas }
}

/**
 * 这次草稿能不能提交。按钮的 `disabled` 与 handler 开头的守卫**必须用同一个函数**：
 * 上一版两处各写了一套判据，勾选确认后按钮解禁了、handler 却仍然 return，
 * 缩到 0 就成了「可点但无反应」的死按钮。
 */
export function scaleBlockedForSubmission(
  check: ScaleCheck,
  confirmed: boolean
): boolean {
  return (
    check.kind === 'invalid' || (check.kind === 'needsConfirm' && !confirmed)
  )
}
