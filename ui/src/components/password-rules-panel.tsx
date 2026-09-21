import { useState } from 'react'
import { IconCheck, IconX } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import type { PasswordRule } from '@/lib/password-rules'

interface PasswordRulesPanelProps {
  rules: PasswordRule[]
  /** 用户是否已输入过内容；输入后未满足时面板持续显示并标红。 */
  touched: boolean
  /** 密码输入框是否聚焦。 */
  focused: boolean
}

/**
 * 密码要求浮层面板：显示在密码输入框旁，面板内为普通文本，可直接选中复制。
 * 显示时机：聚焦、鼠标悬停面板，或已输入但不满足要求（保持标红提示）。
 * 需要放在 position: relative 的容器内。
 */
export function PasswordRulesPanel({
  rules,
  touched,
  focused,
}: PasswordRulesPanelProps) {
  const { t } = useTranslation()
  const [hovered, setHovered] = useState(false)
  const valid = rules.every((rule) => rule.ok)
  if (!(focused || hovered || (touched && !valid))) return null

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="absolute left-0 top-full z-20 mt-2 w-full rounded-md border bg-popover p-3 text-xs shadow-md select-text sm:left-full sm:top-0 sm:ml-3 sm:w-80"
    >
      <p className="mb-1.5 font-medium">
        {t('passwordPolicy.title', '密码要求')}
      </p>
      <ul className="space-y-1.5">
        {rules.map((rule) => (
          <li
            key={rule.label}
            className={`flex items-start gap-1.5 ${
              rule.ok
                ? 'text-success'
                : touched
                  ? 'text-destructive'
                  : 'text-foreground'
            }`}
          >
            {rule.ok ? (
              <IconCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            ) : (
              <IconX className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            )}
            <span>
              {rule.label}
              {rule.children && (
                <ul className="mt-1 space-y-0.5 text-muted-foreground">
                  {rule.children.map((child) => (
                    <li key={child} className="ml-3 list-disc">
                      {child}
                    </li>
                  ))}
                </ul>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
