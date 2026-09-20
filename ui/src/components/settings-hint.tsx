import { useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import {
  IconCheck,
  IconKey,
  IconServer,
  IconShieldCheck,
  IconX,
} from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import {
  useClusterList,
  useLDAPSetting,
  useOAuthProviderList,
  useRoleList,
} from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

interface SettingsHintProps {
  onDismiss?: () => void
}

export function SettingsHint({ onDismiss }: SettingsHintProps) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const [isDismissed, setIsDismissed] = useState(
    () => localStorage.getItem('settings-hint-dismissed') === 'true'
  )

  const { data: clusters = [] } = useClusterList()
  const { data: oauthProviders = [] } = useOAuthProviderList()
  const { data: ldapSetting } = useLDAPSetting({ staleTime: 30000 })
  const { data: roles = [] } = useRoleList()

  const hasP8S = clusters.some((cluster) => !!cluster.prometheusURL)
  const hasOAuthProviders =
    oauthProviders.length > 0 || ldapSetting?.enabled === true
  const hasRoles = roles.length > 2

  if ((hasP8S && hasOAuthProviders && hasRoles) || isDismissed) {
    return null
  }

  const handleDismiss = () => {
    setIsDismissed(true)
    localStorage.setItem('settings-hint-dismissed', 'true')
    onDismiss?.()
  }

  const settingsItems = [
    {
      key: 'p8s',
      title: t('common.fields.prometheus', 'Prometheus'),
      description: t('settingsHint.p8s.description', 'Configure Prometheus'),
      icon: IconServer,
      completed: hasP8S,
      href: '/settings/clusters',
      section: 'clusters',
    },
    {
      key: 'oauth',
      title: t(
        'securitySettings.tabs.authProviders',
        'Authentication Configuration'
      ),
      description: t(
        'settingsHint.oauth.description',
        'Set up LDAP or OAuth authentication'
      ),
      icon: IconKey,
      completed: hasOAuthProviders,
      href: '/settings/security?tab=authProviders',
      section: 'authentication',
    },
    {
      key: 'rbac',
      title: t('nav.rbac', 'RBAC'),
      description: t(
        'settingsHint.rbac.description',
        'Configure roles and permissions'
      ),
      icon: IconShieldCheck,
      completed: hasRoles,
      href: '/settings/rbac',
      section: 'rbac',
    },
    // 三权分立后每个管理员只能打开自己的章节：只列出他真能进入的条目，
    // 避免清单里出现点进去就 403 的死链。
  ].filter((item) => user?.canViewSettingsSection(item.section) ?? false)

  if (settingsItems.length === 0) {
    return null
  }

  const completedCount = settingsItems.filter((item) => item.completed).length

  return (
    <Card className="border-border bg-muted/50">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CardTitle className="text-base text-foreground">
              {t('settingsHint.title', 'Complete Your Setup')}
            </CardTitle>
            <Badge variant="secondary" className="text-xs">
              {completedCount}/{settingsItems.length}
            </Badge>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDismiss}
            className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
          >
            <IconX className="h-4 w-4" />
          </Button>
        </div>
        <CardDescription className="text-muted-foreground">
          {t(
            'settingsHint.description',
            'Configure essential settings to get the most out of Kite'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="flex flex-wrap gap-2">
          {settingsItems.map((item) =>
            item.completed ? (
              <div
                key={item.key}
                className="group flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 transition-all dark:border-green-800 dark:bg-green-950/50"
              >
                <div className="flex h-6 w-6 items-center justify-center rounded-md bg-green-100 text-green-600 dark:bg-green-900 dark:text-green-400">
                  <IconCheck className="h-3 w-3" />
                </div>
                <span className="text-sm font-medium text-green-900 dark:text-green-100">
                  {item.title}
                </span>
              </div>
            ) : (
              <Link
                key={item.key}
                to={item.href}
                className="group flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 transition-all hover:border-primary/50 hover:bg-muted/50"
              >
                <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10 text-primary group-hover:bg-primary/20">
                  <item.icon className="h-3 w-3" />
                </div>
                <span className="text-sm font-medium text-foreground group-hover:text-primary">
                  {item.title}
                </span>
                <span className="ml-2 text-xs text-muted-foreground group-hover:text-primary">
                  →
                </span>
              </Link>
            )
          )}
        </div>
        <div className="mt-3 flex justify-end">
          <Link to="/settings/general">
            <Button
              variant="outline"
              size="sm"
              className="text-foreground border-border hover:bg-muted"
            >
              {t('settingsHint.viewAll', 'View All Settings')}
            </Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  )
}
