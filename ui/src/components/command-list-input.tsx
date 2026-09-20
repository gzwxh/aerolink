import { useEffect, useState } from 'react'

import { Input } from '@/components/ui/input'

/**
 * 把「以空格分隔的字符串数组」绑定到单个输入框上。
 *
 * 不能直接 value=(arr||[]).join(' ') + onChange 再 split 回数组：每次敲空格，尾部空串会被
 * filter 掉，受控 value 跟着变回没有空格的样子，空格永远打不进去。这里在本地维护输入
 * 草稿并只在聚焦期间不回写；每次输入都同步解析后的数组，失焦时再补一次提交
 * （保证不点失焦直接点「创建」也不丢内容）。
 */
export function CommandListInput({
  value,
  onChange,
  placeholder,
  className,
}: {
  value?: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  className?: string
}) {
  const [focused, setFocused] = useState(false)
  const [draft, setDraft] = useState((value || []).join(' '))
  useEffect(() => {
    if (!focused) setDraft((value || []).join(' '))
  }, [focused, value])

  return (
    <Input
      value={draft}
      placeholder={placeholder}
      className={className}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false)
        onChange(draft.split(' ').filter(Boolean))
      }}
      onChange={(e) => {
        setDraft(e.target.value)
        onChange(e.target.value.split(' ').filter(Boolean))
      }}
    />
  )
}
