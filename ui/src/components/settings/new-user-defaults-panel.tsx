import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { fetchSecuritySetting, updateSecuritySetting } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

interface NewUserDefaults {
  defaultUserEnabled?: boolean
  defaultUserExpireDays?: number
}

/**
 * 「新建用户默认状态」：创建用户时若未显式指定，则按这里的策略决定
 * 激活状态与失效天数（0 表示永不过期）。
 */
export function NewUserDefaultsPanel() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data } = useQuery({
    queryKey: ['security-setting'],
    queryFn: fetchSecuritySetting,
    staleTime: 30000,
  })
  const [enabled, setEnabled] = useState(true)
  const [expireDays, setExpireDays] = useState(0)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const setting = data as NewUserDefaults | undefined
    if (!setting) return
    setEnabled(setting.defaultUserEnabled ?? true)
    setExpireDays(setting.defaultUserExpireDays ?? 0)
  }, [data])

  const handleSave = async () => {
    setSaving(true)
    try {
      await updateSecuritySetting({
        defaultUserEnabled: enabled,
        defaultUserExpireDays: expireDays,
      } as unknown as Parameters<typeof updateSecuritySetting>[0])
      await queryClient.invalidateQueries({ queryKey: ['security-setting'] })
      toast.success(t('common.messages.saved', '已保存'))
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t('common.messages.saveFailed', '保存失败')
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {t(
            'securitySettings.newUserDefaults.title',
            '新建用户默认状态'
          )}
        </CardTitle>
        <CardDescription>
          {t(
            'securitySettings.newUserDefaults.description',
            '创建用户时未显式指定，则按此策略设置激活状态与失效时间。'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-medium">
              {t('securitySettings.newUserDefaults.enabled', '默认激活')}
            </div>
            <div className="text-xs text-muted-foreground">
              {t(
                'securitySettings.newUserDefaults.enabledHint',
                '关闭后新建用户默认禁用，需要管理员手动启用'
              )}
            </div>
          </div>
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="defaultUserExpireDays">
            {t(
              'securitySettings.newUserDefaults.expireDays',
              '默认失效天数'
            )}
          </Label>
          <Input
            id="defaultUserExpireDays"
            type="number"
            className="sm:w-40"
            value={expireDays}
            onChange={(e) => setExpireDays(Number(e.target.value) || 0)}
          />
          <p className="text-xs text-muted-foreground">
            {t(
              'securitySettings.newUserDefaults.expireDaysHint',
              '0 表示永不过期'
            )}
          </p>
        </div>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={saving}>
            {saving
              ? t('notifications.actions.saving', '保存中...')
              : t('notifications.actions.save', '保存')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
