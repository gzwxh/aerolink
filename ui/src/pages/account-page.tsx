import { useAuth } from '@/contexts/auth-context'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'

import { usePageTitle } from '@/hooks/use-page-title'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { AppearanceSection } from '@/components/account/appearance-section'
import { MFASection } from '@/components/account/mfa-section'
import { PasswordSection } from '@/components/account/password-section'
import { ProfileSection } from '@/components/account/profile-section'

type AccountTab = 'profile' | 'security' | 'appearance'

const TAB_PARAM = 'tab'

/**
 * 用户信息页：/account?tab=profile | security | appearance
 *
 * 个人自己的账号信息与设置，任何登录用户都能打开（不需要任何 settings 权限）。
 * 这些内容原来挤在头像菜单的「账号设置」弹窗里；改成整页后才有位置展示账号的
 * 只读信息（用户名、身份来源、角色、创建 / 登录时间）。
 *
 * 「安全」页签只对本地密码用户显示：改密码与绑定动态码都要求校验当前密码，
 * 而目录用户（LDAP / OIDC）没有本地密码，后端也会直接 403。
 */
export function AccountPage() {
  const { t } = useTranslation()
  const { user } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()

  const tabParam = searchParams.get(TAB_PARAM)
  const requested: AccountTab =
    tabParam === 'security' || tabParam === 'appearance' ? tabParam : 'profile'

  const isPasswordUser = !user?.provider || user.provider === 'password'
  // 目录用户没有「安全」页签，带着 ?tab=security 进来时落回基础信息。
  const tab: AccountTab =
    requested === 'security' && !isPasswordUser ? 'profile' : requested

  const handleTabChange = (next: string) => {
    const nextParams = new URLSearchParams(searchParams)
    if (next === 'profile') {
      nextParams.delete(TAB_PARAM)
    } else {
      nextParams.set(TAB_PARAM, next)
    }
    setSearchParams(nextParams, { replace: true })
  }

  const title = t('accountSettings.pageTitle', '用户信息')
  usePageTitle(title)

  return (
    <div className="space-y-2">
      <div className="mb-4">
        <h1 className="mb-2 text-3xl">{title}</h1>
        <p className="text-muted-foreground">
          {t(
            'accountSettings.pageDescription',
            '查看并修改你的账号信息、密码与登录安全设置。'
          )}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {user?.name || user?.username}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs value={tab} onValueChange={handleTabChange} className="gap-5">
            <TabsList>
              <TabsTrigger value="profile">
                {t('accountSettings.tabs.profile', '个人资料')}
              </TabsTrigger>
              {isPasswordUser && (
                <TabsTrigger value="security">
                  {t('accountSettings.tabs.security', '安全')}
                </TabsTrigger>
              )}
              <TabsTrigger value="appearance">
                {t('accountSettings.tabs.appearance', '外观')}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="profile">
              <ProfileSection />
            </TabsContent>
            <TabsContent value="security">
              <div className="space-y-8">
                <PasswordSection />
                <MFASection />
              </div>
            </TabsContent>
            <TabsContent value="appearance">
              <AppearanceSection />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  )
}
