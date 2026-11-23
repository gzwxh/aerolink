import { Moon, Sun } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAppearance } from '@/components/appearance-provider'

export function ModeToggle() {
  const { t } = useTranslation()
  const { theme, setTheme } = useAppearance()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon">
          <Sun className="h-[1.2rem] w-[1.2rem] rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
          <Moon className="absolute h-[1.2rem] w-[1.2rem] rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
          <span className="sr-only">
            {t('userMenu.toggleTheme', '切换主题')}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {/* 用 RadioGroup 而不是普通项：顶栏这个菜单以前认不出当前选的是哪个模式
            （无 data-state / aria-checked / 对勾），验收台账 D-105。
            onValueChange 给的是 string，但下面三项就是全部取值，窄化回 Theme 的并集。 */}
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(value) =>
            setTheme(value as 'light' | 'dark' | 'system')
          }
        >
          <DropdownMenuRadioItem value="light">
            {t('userMenu.themeModes.light', '浅色')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            {t('userMenu.themeModes.dark', '深色')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            {t('userMenu.themeModes.system', '跟随系统')}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
