import { useState } from 'react'
import { IconEye, IconEyeOff, IconLock } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import { Input } from '@/components/ui/input'

type PasswordInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'type'
>

/**
 * 带「显示 / 隐藏」切换的密码输入框，供所有密码与密钥类输入统一使用。
 * 外部 className 会与内置的右侧留白（pr-10）合并。
 */
export function PasswordInput({
  className,
  showLock = false,
  ...props
}: PasswordInputProps & { showLock?: boolean }) {
  const { t } = useTranslation()
  const [visible, setVisible] = useState(false)
  return (
    <div className="relative">
      {showLock && (
        <IconLock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      )}
      <Input
        type={visible ? 'text' : 'password'}
        className={`${showLock ? 'pl-9 ' : ''}pr-10 ${className ?? ''}`}
        {...props}
      />
      <button
        type="button"
        aria-label={
          visible
            ? t('login.hidePassword', 'Hide password')
            : t('login.showPassword', 'Show password')
        }
        onClick={() => setVisible((show) => !show)}
        className="absolute right-1 top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        {visible ? (
          <IconEyeOff className="h-4 w-4" />
        ) : (
          <IconEye className="h-4 w-4" />
        )}
      </button>
    </div>
  )
}
