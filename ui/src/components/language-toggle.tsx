import { Languages } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

// 中文放第一位（默认展示语言）
const languages = [
  { code: 'zh', name: '中文' },
  { code: 'en', name: 'English' },
]

export function LanguageToggle() {
  const { i18n, t } = useTranslation()

  const handleLanguageChange = (languageCode: string) => {
    i18n.changeLanguage(languageCode)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon">
          <Languages className="h-[1.2rem] w-[1.2rem]" />
          <span className="sr-only">{t('common.fields.language')}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {/* 以前只靠 bg-accent 高亮，键盘与读屏用者得不出「当前是哪个语言」
            （无 aria-checked / 对勾），与模式切换一起收口，见 D-105。
            i18n.language 可能是 zh-CN 这类带区域后缀的值，取主语言段才能与选项值对上。 */}
        <DropdownMenuRadioGroup
          value={(i18n.language ?? 'zh').split('-')[0]}
          onValueChange={handleLanguageChange}
        >
          {languages.map((language) => (
            <DropdownMenuRadioItem key={language.code} value={language.code}>
              {language.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
