import {
  navigationShortcuts,
  useNavigationHistory,
} from '@/contexts/navigation-context'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

/**
 * 顶栏的应用内前进/后退。走 navigation-context 维护的导航栈，
 * 不是浏览器历史（原因见该 context 的注释）。
 */
export function NavigationControls() {
  const { t } = useTranslation()
  const { canGoBack, canGoForward, goBack, goForward } = useNavigationHistory()
  const shortcuts = navigationShortcuts()

  const items = [
    {
      key: 'back',
      label: t('common.actions.goBack', 'Go back'),
      shortcut: shortcuts.back,
      disabled: !canGoBack,
      onClick: goBack,
      Icon: ArrowLeft,
    },
    {
      key: 'forward',
      label: t('common.actions.goForward', 'Go forward'),
      shortcut: shortcuts.forward,
      disabled: !canGoForward,
      onClick: goForward,
      Icon: ArrowRight,
    },
  ]

  return (
    <div className="flex items-center gap-1">
      {items.map(({ key, label, shortcut, disabled, onClick, Icon }) => (
        <Tooltip key={key}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onClick}
              disabled={disabled}
              aria-label={label}
              className="flex items-center justify-center rounded-sm p-1 text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            >
              <Icon className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {label} · {shortcut}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}
