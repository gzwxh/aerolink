import type { ReactNode } from 'react'
import { IconLoader2, IconShieldLock } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

/**
 * Route guard for admin-only pages. The real security boundary is the backend
 * (admin APIs reject non-admins with 403); this component only improves the
 * UX by rendering an access-denied page instead of a broken screen.
 */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const { user, isLoading } = useAuth()

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
        {t('common.messages.loading', 'Loading...')}
      </div>
    )
  }

  if (!user?.isAdmin()) {
    return (
      <div className="flex items-center justify-center py-16">
        <Card className="max-w-md text-center">
          <CardHeader>
            <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
              <IconShieldLock className="h-6 w-6 text-destructive" />
            </div>
            <CardTitle>{t('accessDenied.title', 'Access Denied')}</CardTitle>
            <CardDescription>
              {t(
                'accessDenied.message',
                'You do not have permission to view this page. Contact an administrator if you believe this is a mistake.'
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link to="/">{t('accessDenied.backToHome', 'Back to Home')}</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return <>{children}</>
}

export default RequireAdmin
