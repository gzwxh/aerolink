import { useEffect, useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { LogOut, UserCog } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import { resolveAvatarSrc } from '@/lib/avatar-url'
import { MFA_SETUP_REQUEST_EVENT } from '@/lib/mfa-prompt'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

import { SidebarCustomizer } from './sidebar-customizer'

/**
 * 头像菜单：只保留「我是谁」和两个入口（用户信息、退出登录）。
 *
 * 原来这里的主题 / 字体 / 显示缩放，以及「账号设置」弹窗里的资料 / 密码 / 安全，
 * 都已经搬进用户信息页 `/account`（那页才有地方展示账号的只读信息）。
 */
export function UserMenu() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { user, logout } = useAuth()
  const [open, setOpen] = useState(false)

  // 其它地方（例如概览页的超级管理员 MFA 引导）通过事件请求打开绑定流程：
  // 现在改为跳到用户信息页的「安全」页签。
  useEffect(() => {
    const openSecurityTab = () => {
      setOpen(false)
      navigate('/account?tab=security')
    }
    window.addEventListener(MFA_SETUP_REQUEST_EVENT, openSecurityTab)
    return () =>
      window.removeEventListener(MFA_SETUP_REQUEST_EVENT, openSecurityTab)
  }, [navigate])

  if (!user) return null

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((part) => part[0])
      .join('')
      .toUpperCase()
      .slice(0, 2)
  }

  const handleLogout = async () => {
    try {
      await logout()
    } catch (error) {
      console.error('Logout failed:', error)
    }
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="User menu"
          variant="ghost"
          className="relative h-10 w-10 rounded-full"
        >
          <Avatar className="size-sm">
            <AvatarImage
              /* 上传的头像地址是站内路径，子路径部署要靠 resolveAvatarSrc 补前缀。 */
              src={resolveAvatarSrc(user.avatar_url)}
              alt={user.name || user.username}
            />
            <AvatarFallback className="bg-primary text-primary-foreground">
              {getInitials(user.name || user.username)}
            </AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56" align="end" forceMount>
        <div className="flex items-center justify-start gap-2 p-2">
          <div className="flex flex-col space-y-1 leading-none">
            {user.name && <p className="font-medium">{user.name}</p>}
            <p className="text-xs text-muted-foreground">{user.username}</p>
            {user.provider && (
              <p className="text-xs text-muted-foreground capitalize">
                {t('userMenu.via', 'via')} {user.provider}
              </p>
            )}
            {user.roles && user.roles.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {t('userMenu.role', 'Role')}:{' '}
                {user.roles.map((role) => role.name).join(', ')}
              </p>
            )}
          </div>
        </div>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          onSelect={() => navigate('/account')}
          className="cursor-pointer"
        >
          <UserCog className="h-4 w-4" />
          <span>{t('userMenu.accountInfo', '用户信息')}</span>
        </DropdownMenuItem>

        {/* 侧边栏自定义入口对所有登录用户可见：个人布局优先于管理员发布的全局布局，
            因此设了全局布局也不该藏掉这个入口。 */}
        <SidebarCustomizer onOpenChange={(d) => setOpen(d)} />

        {user.provider !== 'Anonymous' && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={handleLogout}
              className="cursor-pointer text-red-600 focus:text-red-600"
            >
              <LogOut className="h-4 w-4" />
              <span>{t('userMenu.logout', '退出登录')}</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
