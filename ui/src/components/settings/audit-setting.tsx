import { useEffect, useState } from 'react'
import { useSettingsSectionAccess } from '@/contexts/settings-section-context'
import { IconHistory } from '@tabler/icons-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import type {
  AuditSetting as AuditSettingData,
  SyslogNetwork,
} from '@/types/api'
import { updateAuditSetting, useAuditSetting } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'

const DEFAULT_FORM: AuditSettingData = {
  retentionDays: 0,
  syslog: {
    enabled: false,
    network: 'udp',
    address: '',
    tag: 'kite',
    facility: 13,
    insecureSkipVerify: false,
  },
}

const SYSLOG_NETWORKS: SyslogNetwork[] = ['udp', 'tcp', 'tls']

function SettingGroup({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-lg border">
      <div className="bg-muted/40 px-3 py-2">
        <div className="text-sm font-medium">{title}</div>
        {description && (
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="divide-y">{children}</div>
    </div>
  )
}

function SettingRow({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-start sm:gap-6">
      <div className="space-y-1 sm:w-64 sm:shrink-0">
        <div className="text-sm">{label}</div>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

/**
 * 日志审计 → 审计设置。
 *
 * 审计管理员唯一可写的审计配置：记录保留策略与 syslog 外发。审计记录本身只读
 * ——没有任何手工删除入口，删除只可能由保留策略按时间自动滚动发生（并留痕）。
 */
export function AuditSetting() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { readOnly } = useSettingsSectionAccess()
  const { data, isLoading } = useAuditSetting()
  const [formData, setFormData] = useState<AuditSettingData>(DEFAULT_FORM)

  const minRetentionDays = data?.minRetentionDays ?? 30
  const recommendedRetention = data?.recommendedRetention ?? 180

  useEffect(() => {
    if (data?.setting) {
      setFormData(data.setting)
    }
  }, [data])

  const mutation = useMutation({
    mutationFn: (payload: AuditSettingData) => updateAuditSetting(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['audit-setting'] })
      toast.success(t('audit.setting.messages.updated', '审计设置已保存'))
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const days = formData.retentionDays
  const retentionTooShort = days > 0 && days < minRetentionDays
  const syslogAddressMissing =
    formData.syslog.enabled && !formData.syslog.address.trim()
  const invalid = retentionTooShort || syslogAddressMissing

  // 系统设置里的写入口跟随后端章节级授权，只读时全部禁用。
  const patchSyslog = (patch: Partial<AuditSettingData['syslog']>) =>
    setFormData((prev) => ({ ...prev, syslog: { ...prev.syslog, ...patch } }))

  if (isLoading && !data) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-muted-foreground">
          {t('common.messages.loading', 'Loading...')}
        </div>
      </div>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <IconHistory className="h-5 w-5" />
          {t('audit.setting.title', '审计设置')}
        </CardTitle>
        <p className="text-muted-foreground text-sm">
          {t(
            'audit.setting.description',
            '配置审计记录的保留策略与外部外发。审计记录只能查看，不能手工删除。'
          )}
        </p>
      </CardHeader>

      <CardContent className="space-y-4">
        <SettingGroup
          title={t('audit.setting.retention.title', '保留策略')}
          description={t(
            'audit.setting.retention.description',
            '按时间自动滚动清理过期的审计记录；每次清理都会留下一条审计记录。'
          )}
        >
          <SettingRow
            label={t('audit.setting.retention.keepForever', '永久保留')}
            hint={t(
              'audit.setting.retention.keepForeverHint',
              '默认开启：不做任何自动删除。'
            )}
          >
            <div className="flex items-center gap-2">
              <Switch
                checked={formData.retentionDays === 0}
                disabled={readOnly}
                onCheckedChange={(checked) =>
                  setFormData((prev) => ({
                    ...prev,
                    retentionDays: checked ? 0 : recommendedRetention,
                  }))
                }
              />
              <span className="text-sm text-muted-foreground">
                {t(
                  'audit.setting.retention.keepForeverValue',
                  '不自动清理审计记录'
                )}
              </span>
            </div>
          </SettingRow>

          <SettingRow
            label={t('audit.setting.retention.days', '保留天数')}
            hint={t(
              'audit.setting.retention.daysHint',
              '不低于 {{min}} 天；等保与《网络安全法》通常按 {{recommended}} 天核查。',
              { min: minRetentionDays, recommended: recommendedRetention }
            )}
          >
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={minRetentionDays}
                value={formData.retentionDays === 0 ? '' : days}
                placeholder={String(recommendedRetention)}
                disabled={readOnly || formData.retentionDays === 0}
                onChange={(event) => {
                  const parsed = Number.parseInt(event.target.value, 10)
                  setFormData((prev) => ({
                    ...prev,
                    retentionDays: Number.isNaN(parsed) ? 0 : parsed,
                  }))
                }}
                className="max-w-32"
              />
              <span className="text-sm text-muted-foreground">
                {t('audit.setting.retention.daysUnit', '天')}
              </span>
            </div>
            {retentionTooShort && (
              <p className="mt-2 text-xs text-destructive">
                {t(
                  'audit.setting.retention.tooShort',
                  '保留天数必须为 0（永久保留）或不低于 {{min}} 天。',
                  { min: minRetentionDays }
                )}
              </p>
            )}
            {!retentionTooShort && days > 0 && days < recommendedRetention && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t(
                  'audit.setting.retention.belowRecommended',
                  '当前保留天数低于建议的 {{recommended}} 天，可能无法通过等保核查。',
                  { recommended: recommendedRetention }
                )}
              </p>
            )}
          </SettingRow>
        </SettingGroup>

        <SettingGroup
          title={t('audit.setting.syslog.title', '日志外发（syslog）')}
          description={t(
            'audit.setting.syslog.description',
            '把审计记录同时外发到外部 syslog 服务器。外发是尽力而为，失败不会影响本地审计记录的落库。'
          )}
        >
          <SettingRow label={t('audit.setting.syslog.enabled', '启用外发')}>
            <Switch
              checked={formData.syslog.enabled}
              disabled={readOnly}
              onCheckedChange={(checked) => patchSyslog({ enabled: checked })}
            />
          </SettingRow>

          <SettingRow label={t('audit.setting.syslog.network', '网络协议')}>
            <Select
              value={formData.syslog.network}
              disabled={readOnly}
              onValueChange={(value) =>
                patchSyslog({ network: value as SyslogNetwork })
              }
            >
              <SelectTrigger className="max-w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SYSLOG_NETWORKS.map((network) => (
                  <SelectItem key={network} value={network}>
                    {network.toUpperCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>

          <SettingRow
            label={t('audit.setting.syslog.address', '服务器地址')}
            hint={t('audit.setting.syslog.addressHint', '格式 host:port')}
          >
            <Input
              value={formData.syslog.address}
              placeholder="syslog.example.com:514"
              disabled={readOnly}
              onChange={(event) => patchSyslog({ address: event.target.value })}
              className="max-w-80"
            />
            {syslogAddressMissing && (
              <p className="mt-2 text-xs text-destructive">
                {t(
                  'audit.setting.syslog.addressRequired',
                  '启用外发时必须填写服务器地址。'
                )}
              </p>
            )}
          </SettingRow>

          <SettingRow
            label={t('audit.setting.syslog.tag', '标签（APP-NAME）')}
            hint={t(
              'audit.setting.syslog.tagHint',
              '外发消息里的应用名，便于在日志服务器上区分来源。'
            )}
          >
            <Input
              value={formData.syslog.tag}
              placeholder="kite"
              disabled={readOnly}
              onChange={(event) => patchSyslog({ tag: event.target.value })}
              className="max-w-40"
            />
          </SettingRow>

          <SettingRow
            label={t('audit.setting.syslog.facility', '设施（facility）')}
            hint={t(
              'audit.setting.syslog.facilityHint',
              '默认 13（log audit），取值范围 0-23。'
            )}
          >
            <Input
              type="number"
              min={0}
              max={23}
              value={formData.syslog.facility}
              disabled={readOnly}
              onChange={(event) => {
                const parsed = Number.parseInt(event.target.value, 10)
                patchSyslog({
                  facility: Number.isNaN(parsed) ? 13 : parsed,
                })
              }}
              className="max-w-32"
            />
          </SettingRow>

          {formData.syslog.network === 'tls' && (
            <SettingRow
              label={t('audit.setting.syslog.skipVerify', '跳过证书校验')}
              hint={t(
                'audit.setting.syslog.skipVerifyHint',
                '仅 tls 生效。服务端使用自签证书时开启。'
              )}
            >
              <div className="flex items-center gap-2">
                <Switch
                  checked={formData.syslog.insecureSkipVerify}
                  disabled={readOnly}
                  onCheckedChange={(checked) =>
                    patchSyslog({ insecureSkipVerify: checked })
                  }
                />
                <Label className="text-sm text-muted-foreground">
                  {t(
                    'audit.setting.syslog.skipVerifyValue',
                    '不校验服务端证书'
                  )}
                </Label>
              </div>
            </SettingRow>
          )}
        </SettingGroup>

        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            disabled={readOnly}
            onClick={() => setFormData(data?.setting ?? DEFAULT_FORM)}
          >
            {t('common.actions.reset', 'Reset')}
          </Button>
          <Button
            disabled={readOnly || invalid || mutation.isPending}
            onClick={() => mutation.mutate(formData)}
          >
            {t('common.actions.submit', 'Submit')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
