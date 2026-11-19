import { useEffect, useState } from 'react'
import { useSettingsSectionAccess } from '@/contexts/settings-section-context'
import { IconHistory } from '@tabler/icons-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import type {
  AccessLogArchiveSetting,
  AuditSetting as AuditSettingData,
  KafkaSASLMechanism,
  LogFormat,
  LogForwardMode,
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
    mode: 'syslog',
    network: 'udp',
    address: '',
    tag: 'aerolink',
    facility: 13,
    format: 'text',
    insecureSkipVerify: false,
    kafka: {
      brokers: [],
      topic: '',
      saslMechanism: 'none',
      username: '',
      password: '',
      // 与后端默认一致：审计记录含操作者与来源 IP，明文发到 broker 不是可接受的默认值。
      useTLS: true,
      tlsInsecureSkipVerify: false,
    },
  },
  stdout: {
    enabled: true,
    format: 'json',
  },
  archive: {
    enabled: false,
    localDir: '',
    retentionDays: 7,
    maxBytes: 10 * 1024 * 1024 * 1024,
    flush: { intervalSeconds: 120, maxBatchRows: 100000, maxBatchBytes: 0 },
    accessLog: {
      enabled: true,
      retentionDays: 3,
      maxBytes: 5 * 1024 * 1024 * 1024,
      flush: { intervalSeconds: 120, maxBatchRows: 200000, maxBatchBytes: 0 },
      format: 'text',
    },
    s3: {
      enabled: false,
      endpoint: '',
      region: '',
      bucket: '',
      accessKey: '',
      secretKey: '',
      pathStyle: true,
      useTLS: false,
      prefix: '',
      // 默认与后端一致（false = 本地留几天 + 全量同步 S3）；仅在首次响应到达前作为占位。
      deleteLocalAfterUpload: false,
      directUpload: false,
    },
    elasticsearch: {
      enabled: false,
      urls: [],
      username: '',
      password: '',
      indexPrefix: 'aerolink-audit',
      tlsInsecureSkipVerify: false,
    },
    victorialogs: {
      enabled: false,
      urls: [],
      stream: 'aerolink-audit',
      accountId: '',
      projectId: '',
      tlsInsecureSkipVerify: false,
    },
    openobserve: {
      enabled: false,
      urls: [],
      org: 'default',
      stream: 'aerolink-audit',
      username: '',
      password: '',
      tlsInsecureSkipVerify: false,
    },
    includeResourceYAML: false,
  },
}

const SYSLOG_NETWORKS: SyslogNetwork[] = ['udp', 'tcp', 'tls']

/** 外发方式二选一（与后端 auditSink 那种「五选一互斥」不同：这是同一份记录的出口方式）。 */
const LOG_FORWARD_MODES: LogForwardMode[] = ['syslog', 'kafka']

const KAFKA_SASL_MECHANISMS: KafkaSASLMechanism[] = [
  'none',
  'plain',
  'scram-sha-256',
  'scram-sha-512',
]

/** 日志输出格式二选一：text 保持现状，json 输出结构化单行（不做任意模板）。 */
const LOG_FORMATS: LogFormat[] = ['text', 'json']

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

/** 把数字输入框的字符串解析成非负整数：空 / 非法 / 负数一律回落 0（0 = 不限制）。 */
function numberOrZero(value: string): number {
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) || parsed < 0 ? 0 : parsed
}

/**
 * 日志审计 → 审计设置。
 *
 * 审计管理员唯一可写的审计配置：记录保留策略与日志外发。审计记录本身只读
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

  // 审计记录的落地方式由**配置文件**在启动时决定，后端在响应顶层返回；界面只读展示。
  const sink = data?.sink ?? 'database'
  // 五条通道互斥（见 docs/dev/plans/2026-09-20-审计日志parquet归档.md §12.13）：
  // 通道开关由存储方式决定（配置文件指定、界面只读），不是管理员可改的意向。
  const databaseSink = sink === 'database'
  const parquetSink = sink === 'parquet'
  const elasticsearchSink = sink === 'elasticsearch'
  const victoriaLogsSink = sink === 'victorialogs'
  const openObserveSink = sink === 'openobserve'
  // victorialogs / openobserve 的过期数据只能由服务端清（客户端没有删除接口），
  // 所以「保留策略」区块必须明说它不生效（见后端 AuditSinkRetentionIsServerSide）。
  const retentionServerSide = data?.retentionServerSide ?? false

  const mutation = useMutation({
    mutationFn: (payload: AuditSettingData) => updateAuditSetting(payload),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ['audit-setting'] })
      toast.success(t('audit.setting.messages.updated', '审计设置已保存'))

      // 保存本身成功了，但目标存储可能连不上（地址写错、密钥不对、网络不通）。
      // 这种情况必须当场告诉管理员——否则要等到归档真的跑起来才发现。
      const warnings = response?.warnings ?? []
      if (warnings.length > 0) {
        toast.warning(
          t(
            'audit.setting.messages.probeFailed',
            '配置已保存，但连通性检查未通过：{{detail}}',
            { detail: warnings.join('; ') }
          ),
          { duration: 10000 }
        )
      }
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const days = formData.retentionDays
  const retentionTooShort = days > 0 && days < minRetentionDays
  // 只校验当前生效的那一种方式（与后端 Normalize 一致）：切到 kafka 时不该被"地址为空"拦住。
  const forward = formData.syslog
  const syslogAddressMissing =
    forward.enabled && forward.mode === 'syslog' && !forward.address.trim()
  const kafkaBrokersMissing =
    forward.enabled &&
    forward.mode === 'kafka' &&
    forward.kafka.brokers.filter((broker) => broker.trim()).length === 0
  const kafkaTopicMissing =
    forward.enabled && forward.mode === 'kafka' && !forward.kafka.topic.trim()
  const kafkaUsernameMissing =
    forward.enabled &&
    forward.mode === 'kafka' &&
    forward.kafka.saslMechanism !== 'none' &&
    !forward.kafka.username.trim()

  const archive = formData.archive
  // 启用 S3 / ES / 外部日志存储时关键连接信息必填，否则后端 Normalize 会拒绝保存。
  const s3Incomplete =
    archive.s3.enabled &&
    (!archive.s3.endpoint.trim() || !archive.s3.bucket.trim())
  const esIncomplete =
    archive.elasticsearch.enabled &&
    archive.elasticsearch.urls.filter((url) => url.trim()).length === 0
  const victoriaLogsIncomplete =
    archive.victorialogs.enabled &&
    archive.victorialogs.urls.filter((url) => url.trim()).length === 0
  const openObserveIncomplete =
    archive.openobserve.enabled &&
    archive.openobserve.urls.filter((url) => url.trim()).length === 0
  const invalid =
    retentionTooShort ||
    syslogAddressMissing ||
    kafkaBrokersMissing ||
    kafkaTopicMissing ||
    kafkaUsernameMissing ||
    s3Incomplete ||
    esIncomplete ||
    victoriaLogsIncomplete ||
    openObserveIncomplete

  // 系统设置里的写入口跟随后端章节级授权，只读时全部禁用。
  // 字段名仍是后端 JSON 里的 syslog（历史键名，不可改名，见 types/api.ts）。
  const patchForward = (patch: Partial<AuditSettingData['syslog']>) =>
    setFormData((prev) => ({ ...prev, syslog: { ...prev.syslog, ...patch } }))
  const patchKafka = (patch: Partial<AuditSettingData['syslog']['kafka']>) =>
    setFormData((prev) => ({
      ...prev,
      syslog: { ...prev.syslog, kafka: { ...prev.syslog.kafka, ...patch } },
    }))
  const patchStdout = (patch: Partial<AuditSettingData['stdout']>) =>
    setFormData((prev) => ({ ...prev, stdout: { ...prev.stdout, ...patch } }))
  const patchArchive = (patch: Partial<AuditSettingData['archive']>) =>
    setFormData((prev) => ({ ...prev, archive: { ...prev.archive, ...patch } }))
  const patchS3 = (patch: Partial<AuditSettingData['archive']['s3']>) =>
    setFormData((prev) => ({
      ...prev,
      archive: { ...prev.archive, s3: { ...prev.archive.s3, ...patch } },
    }))
  const patchES = (
    patch: Partial<AuditSettingData['archive']['elasticsearch']>
  ) =>
    setFormData((prev) => ({
      ...prev,
      archive: {
        ...prev.archive,
        elasticsearch: { ...prev.archive.elasticsearch, ...patch },
      },
    }))
  const patchVictoriaLogs = (
    patch: Partial<AuditSettingData['archive']['victorialogs']>
  ) =>
    setFormData((prev) => ({
      ...prev,
      archive: {
        ...prev.archive,
        victorialogs: { ...prev.archive.victorialogs, ...patch },
      },
    }))
  const patchOpenObserve = (
    patch: Partial<AuditSettingData['archive']['openobserve']>
  ) =>
    setFormData((prev) => ({
      ...prev,
      archive: {
        ...prev.archive,
        openobserve: { ...prev.archive.openobserve, ...patch },
      },
    }))

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
          title={t('audit.setting.sink.title', '存储方式')}
          description={t(
            'audit.setting.sink.description',
            '审计记录的落地方式（五者互斥），由配置文件 auditSink / 环境变量 AEROLINK_AUDIT_SINK 在启动时指定，界面只读。'
          )}
        >
          <SettingRow label={t('audit.setting.sink.label', '落地方式')}>
            <span className="text-sm font-medium">
              {t(`audit.setting.sink.${sink}`, sink)}
            </span>
          </SettingRow>
          {sink === 'parquet' && (
            <SettingRow
              label={t('audit.setting.sink.delay', '查询延迟上限')}
              hint={t(
                'audit.setting.sink.delayHint',
                'parquet 是攒批落盘的：刚发生的操作在这个时间内可能还查不到，审计列表会给出提示。'
              )}
            >
              <span className="text-sm">
                {t('audit.setting.sink.delayValue', '{{seconds}} 秒', {
                  seconds: data?.setting.archive.flush.intervalSeconds || 120,
                })}
              </span>
            </SettingRow>
          )}
          {sink !== 'database' && (
            <SettingRow
              label={t('audit.setting.sink.unavailable', '当前不可用的能力')}
              hint={t(
                'audit.setting.sink.unavailableHint',
                '下列能力都依赖本库里的历史记录，sink≠database 时不可用：'
              )}
            >
              <ul className="list-disc space-y-1 pl-4 text-sm">
                <li>
                  {t(
                    'audit.setting.sink.unavailableHistory',
                    '资源级变更历史（含 YAML 对比与回滚）：资源详情页的「历史」会明确提示不可用'
                  )}
                </li>
                <li>
                  {t(
                    'audit.setting.sink.unavailableNewIP',
                    '异地登录提醒（需要历史登录记录才能判定）'
                  )}
                </li>
              </ul>
            </SettingRow>
          )}
        </SettingGroup>

        <SettingGroup
          title={t('audit.setting.retention.title', '保留策略')}
          description={t(
            'audit.setting.retention.description',
            '按时间自动滚动清理过期的审计记录（含 Elasticsearch 的按天索引）；每次清理都会留下一条审计记录。'
          )}
        >
          {retentionServerSide && (
            // 保留天数在当前 sink 下没有执行力：过期由存储端自己的配置决定，客户端连删除接口都没有。
            // 这里必须明说，否则管理员改完天数为没生效还以为是 bug。
            <div className="mx-3 mt-3 rounded-md border border-warning/25 bg-warning/10 px-3 py-2 text-xs text-muted-foreground">
              {t(
                'audit.setting.retention.serverSideNotice',
                '当前存储方式（{{sink}}）的过期清理由服务端负责，本页的保留天数对它不生效：请到服务端的保留配置里调整（VictoriaLogs 的 -retentionPeriod、OpenObserve 的 stream data_retention）。',
                { sink: t(`audit.setting.sink.${sink}`, sink) }
              )}
            </div>
          )}
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
          title={t('audit.setting.syslog.title', '日志外发')}
          description={t(
            'audit.setting.syslog.description',
            '把审计记录同时外发到外部日志服务。外发是尽力而为，失败不会影响本地审计记录的落库。'
          )}
        >
          <SettingRow label={t('audit.setting.syslog.enabled', '启用外发')}>
            <Switch
              checked={formData.syslog.enabled}
              disabled={readOnly}
              onCheckedChange={(checked) => patchForward({ enabled: checked })}
            />
          </SettingRow>

          <SettingRow
            label={t('audit.setting.syslog.mode', '外发方式')}
            hint={t(
              'audit.setting.syslog.modeHint',
              '二选一，同一时刻只有一种方式生效；另一种的参数会保留，但不外发。'
            )}
          >
            <Select
              value={formData.syslog.mode}
              disabled={readOnly}
              onValueChange={(value) =>
                patchForward({ mode: value as LogForwardMode })
              }
            >
              <SelectTrigger className="max-w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LOG_FORWARD_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {t(
                      `audit.setting.syslog.forwardMode.${mode}`,
                      mode.toUpperCase()
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>

          {formData.syslog.mode === 'kafka' ? (
            <>
              <SettingRow
                label={t('audit.setting.syslog.kafka.brokers', 'Broker 地址')}
                hint={t(
                  'audit.setting.syslog.kafka.brokersHint',
                  '格式 host:port，多个用逗号分隔。'
                )}
              >
                <Input
                  value={formData.syslog.kafka.brokers.join(', ')}
                  placeholder="kafka-1:9092, kafka-2:9092"
                  disabled={readOnly}
                  onChange={(event) =>
                    patchKafka({ brokers: event.target.value.split(',') })
                  }
                  className="max-w-80"
                />
                {kafkaBrokersMissing && (
                  <p className="mt-2 text-xs text-destructive">
                    {t(
                      'audit.setting.syslog.kafka.brokersRequired',
                      '启用 Kafka 外发时必须填写至少一个 broker。'
                    )}
                  </p>
                )}
              </SettingRow>

              <SettingRow
                label={t('audit.setting.syslog.kafka.topic', '主题（topic）')}
                hint={t(
                  'audit.setting.syslog.kafka.topicHint',
                  '审计记录的 JSON 会投到这个主题；消息 key 为记录分类，同类记录落同一分区。'
                )}
              >
                <Input
                  value={formData.syslog.kafka.topic}
                  placeholder="aerolink-audit"
                  disabled={readOnly}
                  onChange={(event) =>
                    patchKafka({ topic: event.target.value })
                  }
                  className="max-w-80"
                />
                {kafkaTopicMissing && (
                  <p className="mt-2 text-xs text-destructive">
                    {t(
                      'audit.setting.syslog.kafka.topicRequired',
                      '启用 Kafka 外发时必须填写主题。'
                    )}
                  </p>
                )}
              </SettingRow>

              <SettingRow
                label={t('audit.setting.syslog.kafka.sasl', 'SASL 认证')}
                hint={t(
                  'audit.setting.syslog.kafka.saslHint',
                  '不做认证 / PLAIN / SCRAM-SHA-256 / SCRAM-SHA-512。'
                )}
              >
                <Select
                  value={formData.syslog.kafka.saslMechanism}
                  disabled={readOnly}
                  onValueChange={(value) =>
                    patchKafka({ saslMechanism: value as KafkaSASLMechanism })
                  }
                >
                  <SelectTrigger className="max-w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {KAFKA_SASL_MECHANISMS.map((mechanism) => (
                      <SelectItem key={mechanism} value={mechanism}>
                        {t(
                          `audit.setting.syslog.kafka.saslMechanism.${mechanism}`,
                          mechanism.toUpperCase()
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingRow>

              {formData.syslog.kafka.saslMechanism !== 'none' && (
                <>
                  <SettingRow
                    label={t('audit.setting.syslog.kafka.username', '用户名')}
                  >
                    <Input
                      value={formData.syslog.kafka.username}
                      disabled={readOnly}
                      onChange={(event) =>
                        patchKafka({ username: event.target.value })
                      }
                      className="max-w-80"
                    />
                    {kafkaUsernameMissing && (
                      <p className="mt-2 text-xs text-destructive">
                        {t(
                          'audit.setting.syslog.kafka.usernameRequired',
                          '启用 SASL 认证时必须填写用户名。'
                        )}
                      </p>
                    )}
                  </SettingRow>

                  <SettingRow
                    label={t('audit.setting.syslog.kafka.password', '密码')}
                    hint={t(
                      'audit.setting.syslog.kafka.passwordHint',
                      '只写不回显；换了地址或用户名需要重填。'
                    )}
                  >
                    <Input
                      type="password"
                      value={formData.syslog.kafka.password}
                      disabled={readOnly}
                      onChange={(event) =>
                        patchKafka({ password: event.target.value })
                      }
                      className="max-w-80"
                    />
                  </SettingRow>
                </>
              )}

              <SettingRow
                label={t('audit.setting.syslog.kafka.useTLS', '使用 TLS')}
                hint={t(
                  'audit.setting.syslog.kafka.useTLSHint',
                  '默认开启：审计记录含操作者与来源 IP，不建议明文发送。'
                )}
              >
                <Switch
                  checked={formData.syslog.kafka.useTLS}
                  disabled={readOnly}
                  onCheckedChange={(checked) => patchKafka({ useTLS: checked })}
                />
              </SettingRow>

              {formData.syslog.kafka.useTLS && (
                <SettingRow
                  label={t(
                    'audit.setting.syslog.kafka.skipVerify',
                    '跳过证书校验'
                  )}
                  hint={t(
                    'audit.setting.syslog.kafka.skipVerifyHint',
                    '仅 TLS 生效。服务端使用自签证书时开启。'
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={formData.syslog.kafka.tlsInsecureSkipVerify}
                      disabled={readOnly}
                      onCheckedChange={(checked) =>
                        patchKafka({ tlsInsecureSkipVerify: checked })
                      }
                    />
                    <Label className="text-sm text-muted-foreground">
                      {t(
                        'audit.setting.syslog.kafka.skipVerifyValue',
                        '不校验服务端证书'
                      )}
                    </Label>
                  </div>
                </SettingRow>
              )}
            </>
          ) : (
            <>
              <SettingRow label={t('audit.setting.syslog.network', '网络协议')}>
                <Select
                  value={formData.syslog.network}
                  disabled={readOnly}
                  onValueChange={(value) =>
                    patchForward({ network: value as SyslogNetwork })
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
                label={t('audit.setting.syslog.format', '输出格式')}
                hint={t(
                  'audit.setting.syslog.formatHint',
                  'text 为 key=value 文本；json 输出结构化字段（与归档字段集一致）。'
                )}
              >
                <Select
                  value={formData.syslog.format}
                  disabled={readOnly}
                  onValueChange={(value) =>
                    patchForward({ format: value as LogFormat })
                  }
                >
                  <SelectTrigger className="max-w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LOG_FORMATS.map((format) => (
                      <SelectItem key={format} value={format}>
                        {t(
                          `audit.setting.logFormat.${format}`,
                          format.toUpperCase()
                        )}
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
                  onChange={(event) =>
                    patchForward({ address: event.target.value })
                  }
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
                  placeholder="aerolink"
                  disabled={readOnly}
                  onChange={(event) =>
                    patchForward({ tag: event.target.value })
                  }
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
                    patchForward({
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
                        patchForward({ insecureSkipVerify: checked })
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
            </>
          )}
        </SettingGroup>

        <SettingGroup
          title={t('audit.setting.stdout.title', '标准输出（日志采集）')}
          description={t(
            'audit.setting.stdout.description',
            '把审计事件（操作 / 登录 / 改密）也输出到标准输出，交给外部日志采集工具收走。关闭后日志平台只能看到 HTTP 访问日志，查不到「谁做了什么」。'
          )}
        >
          <SettingRow
            label={t('audit.setting.stdout.enabled', '输出到标准输出')}
            hint={t(
              'audit.setting.stdout.enabledHint',
              '默认开启。审计事件量很小（远低于访问日志），关闭前请确认日志平台另有审计数据来源。'
            )}
          >
            <Switch
              checked={formData.stdout.enabled}
              disabled={readOnly}
              onCheckedChange={(checked) => patchStdout({ enabled: checked })}
            />
          </SettingRow>

          <SettingRow
            label={t('audit.setting.stdout.format', '输出格式')}
            hint={t(
              'audit.setting.stdout.formatHint',
              'json（推荐）输出结构化单行并带 logger=audit 标记，便于采集侧分流；text 与 syslog 正文同构。'
            )}
          >
            <Select
              value={formData.stdout.format}
              disabled={readOnly}
              onValueChange={(value) =>
                patchStdout({ format: value as LogFormat })
              }
            >
              <SelectTrigger className="max-w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LOG_FORMATS.map((format) => (
                  <SelectItem key={format} value={format}>
                    {t(
                      `audit.setting.logFormat.${format}`,
                      format.toUpperCase()
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>
        </SettingGroup>

        <SettingGroup
          title={t('audit.setting.archive.title', '归档（parquet + 外部存储）')}
          description={t(
            'audit.setting.archive.description',
            '把审计与访问日志归档成 parquet 文件，可选上传到 S3 兼容对象存储，或写入 Elasticsearch / VictoriaLogs / OpenObserve。归档是尽力而为：失败不会影响本地落库，也不会拖慢请求。'
          )}
        >
          {/* 通道互斥说明：下面三组开关哪些生效完全由「存储方式」决定，先把这条说在前面，
              避免管理员在不会生效的开关上反复配置。 */}
          <div className="mx-3 mt-3 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {t(`audit.setting.archive.sinkNotice.${sink}`)}
          </div>
          <SettingRow
            label={t('audit.setting.archive.enabled', '启用归档')}
            hint={t(
              'audit.setting.archive.enabledHint',
              '由存储方式决定：只有 sink=parquet 时才写 parquet 文件，其它存储方式下不可开启。'
            )}
          >
            <Switch
              checked={archive.enabled}
              disabled={readOnly || (!parquetSink && !databaseSink)}
              onCheckedChange={(checked) => patchArchive({ enabled: checked })}
            />
          </SettingRow>

          <SettingRow
            label={t('audit.setting.archive.localDir', '本地目录')}
            hint={t(
              'audit.setting.archive.localDirHint',
              '留空使用环境变量 AEROLINK_AUDIT_ARCHIVE_DIR 指定的默认目录。'
            )}
          >
            <Input
              value={archive.localDir}
              placeholder="/home/aerolink/data/archive"
              disabled={readOnly}
              onChange={(event) =>
                patchArchive({ localDir: event.target.value })
              }
              className="max-w-80"
            />
          </SettingRow>

          <SettingRow
            label={t('audit.setting.archive.retentionDays', '本地保留天数')}
            hint={t(
              'audit.setting.archive.retentionDaysHint',
              '0 表示不按时间清理。'
            )}
          >
            <Input
              type="number"
              min={0}
              value={archive.retentionDays}
              disabled={readOnly}
              onChange={(event) =>
                patchArchive({
                  retentionDays: numberOrZero(event.target.value),
                })
              }
              className="max-w-32"
            />
          </SettingRow>

          <SettingRow
            label={t('audit.setting.archive.maxBytes', '本地容量上限（字节）')}
            hint={t(
              'audit.setting.archive.maxBytesHint',
              '0 表示不按容量清理；超出时先删最旧的文件。'
            )}
          >
            <Input
              type="number"
              min={0}
              value={archive.maxBytes}
              disabled={readOnly}
              onChange={(event) =>
                patchArchive({ maxBytes: numberOrZero(event.target.value) })
              }
              className="max-w-48"
            />
          </SettingRow>

          <SettingRow
            label={t('audit.setting.archive.flushInterval', '攒批间隔（秒）')}
            hint={t(
              'audit.setting.archive.flushIntervalHint',
              '到达间隔、条数或字节任一阈值即落一个 parquet 文件。'
            )}
          >
            <Input
              type="number"
              min={0}
              value={archive.flush.intervalSeconds}
              disabled={readOnly}
              onChange={(event) =>
                patchArchive({
                  flush: {
                    ...archive.flush,
                    intervalSeconds: numberOrZero(event.target.value),
                  },
                })
              }
              className="max-w-32"
            />
          </SettingRow>

          <SettingRow
            label={t('audit.setting.archive.flushRows', '单批最大条数')}
          >
            <Input
              type="number"
              min={0}
              value={archive.flush.maxBatchRows}
              disabled={readOnly}
              onChange={(event) =>
                patchArchive({
                  flush: {
                    ...archive.flush,
                    maxBatchRows: numberOrZero(event.target.value),
                  },
                })
              }
              className="max-w-40"
            />
          </SettingRow>

          <SettingRow
            label={t('audit.setting.archive.flushBytes', '单批最大字节数')}
            hint={t(
              'audit.setting.archive.flushBytesHint',
              '0 表示不按字节触发；攒够即落盘，避免单个文件过大。'
            )}
          >
            <Input
              type="number"
              min={0}
              value={archive.flush.maxBatchBytes}
              disabled={readOnly}
              onChange={(event) =>
                patchArchive({
                  flush: {
                    ...archive.flush,
                    maxBatchBytes: numberOrZero(event.target.value),
                  },
                })
              }
              className="max-w-48"
            />
          </SettingRow>

          <SettingRow
            label={t(
              'audit.setting.archive.includeResourceYAML',
              '归档资源清单（YAML）'
            )}
            hint={t(
              databaseSink
                ? 'audit.setting.archive.includeResourceYAMLHintDatabase'
                : 'audit.setting.archive.includeResourceYAMLHint',
              databaseSink
                ? '数据库冷归档会强制带上变更前后的资源清单（等保溯源需要），不可关闭。'
                : '默认关闭：变更前后的 YAML 可能很大，会把归档文件撑大。仅在需要溯源时开启。'
            )}
          >
            <div className="flex items-center gap-2">
              <Switch
                checked={databaseSink || archive.includeResourceYAML}
                disabled={readOnly || databaseSink}
                onCheckedChange={(checked) =>
                  patchArchive({ includeResourceYAML: checked })
                }
              />
              <span className="text-sm text-muted-foreground">
                {t(
                  'audit.setting.archive.includeResourceYAMLValue',
                  '在操作日志归档中写入 YAML'
                )}
              </span>
            </div>
          </SettingRow>
        </SettingGroup>

        <SettingGroup
          title={t('audit.setting.archive.s3.title', 'S3 归档（对象存储）')}
          description={t(
            'audit.setting.archive.s3.description',
            '兼容 MinIO / RustFS / Ceph RGW / 腾讯 COS / 华为 OBS / 阿里 OSS 等一切 S3 兼容存储。默认本地保留几天、同时把全部文件同步到 S3（S3 为长期归档）。'
          )}
        >
          <SettingRow
            label={t('audit.setting.archive.s3.enabled', '启用上传')}
            hint={t(
              'audit.setting.archive.s3.enabledHint',
              'S3 是 parquet 的远端副本：只有 sink=parquet 时才有可同步的文件。'
            )}
          >
            <Switch
              checked={archive.s3.enabled}
              disabled={readOnly || (!parquetSink && !databaseSink)}
              onCheckedChange={(checked) => patchS3({ enabled: checked })}
            />
          </SettingRow>

          <SettingRow
            label={t('audit.setting.archive.s3.endpoint', 'Endpoint')}
            hint={t(
              'audit.setting.archive.s3.endpointHint',
              '含协议头，如 http://minio:9000。'
            )}
          >
            <Input
              value={archive.s3.endpoint}
              placeholder="http://minio:9000"
              disabled={readOnly}
              onChange={(event) => patchS3({ endpoint: event.target.value })}
              className="max-w-80"
            />
            {s3Incomplete && !archive.s3.endpoint.trim() && (
              <p className="mt-2 text-xs text-destructive">
                {t(
                  'audit.setting.archive.s3.endpointRequired',
                  '启用上传时必须填写 Endpoint。'
                )}
              </p>
            )}
          </SettingRow>

          <SettingRow
            label={t('audit.setting.archive.s3.region', 'Region')}
            hint={t(
              'audit.setting.archive.s3.regionHint',
              '腾讯 COS 必填；MinIO / RustFS 等可留空。'
            )}
          >
            <Input
              value={archive.s3.region}
              placeholder="us-east-1"
              disabled={readOnly}
              onChange={(event) => patchS3({ region: event.target.value })}
              className="max-w-40"
            />
          </SettingRow>

          <SettingRow label={t('audit.setting.archive.s3.bucket', 'Bucket')}>
            <Input
              value={archive.s3.bucket}
              placeholder="aerolink-audit"
              disabled={readOnly}
              onChange={(event) => patchS3({ bucket: event.target.value })}
              className="max-w-60"
            />
            {s3Incomplete && !archive.s3.bucket.trim() && (
              <p className="mt-2 text-xs text-destructive">
                {t(
                  'audit.setting.archive.s3.bucketRequired',
                  '启用上传时必须填写 Bucket。'
                )}
              </p>
            )}
          </SettingRow>

          <SettingRow
            label={t('audit.setting.archive.s3.accessKey', 'Access Key')}
          >
            <Input
              value={archive.s3.accessKey}
              disabled={readOnly}
              autoComplete="off"
              onChange={(event) => patchS3({ accessKey: event.target.value })}
              className="max-w-60"
            />
          </SettingRow>

          <SettingRow
            label={t('audit.setting.archive.s3.secretKey', 'Secret Key')}
            hint={t(
              'audit.setting.archive.s3.secretKeyHint',
              '读取时以掩码返回；不修改则保持原值。'
            )}
          >
            <Input
              type="password"
              value={archive.s3.secretKey}
              disabled={readOnly}
              autoComplete="new-password"
              onChange={(event) => patchS3({ secretKey: event.target.value })}
              className="max-w-60"
            />
          </SettingRow>

          <SettingRow
            label={t('audit.setting.archive.s3.prefix', '对象前缀')}
            hint={t(
              'audit.setting.archive.s3.prefixHint',
              '对象键为 <前缀>/<类型>/<年>/<月>/<日>/<文件名>。'
            )}
          >
            <Input
              value={archive.s3.prefix}
              placeholder="aerolink-audit"
              disabled={readOnly}
              onChange={(event) => patchS3({ prefix: event.target.value })}
              className="max-w-60"
            />
          </SettingRow>

          <SettingRow
            label={t('audit.setting.archive.s3.pathStyle', 'Path-style 寻址')}
            hint={t(
              'audit.setting.archive.s3.pathStyleHint',
              'MinIO / RustFS / Ceph 用 path-style；COS / OBS / OSS 关闭。'
            )}
          >
            <Switch
              checked={archive.s3.pathStyle}
              disabled={readOnly}
              onCheckedChange={(checked) => patchS3({ pathStyle: checked })}
            />
          </SettingRow>

          <SettingRow
            label={t('audit.setting.archive.s3.useTLS', '使用 TLS（https）')}
          >
            <Switch
              checked={archive.s3.useTLS}
              disabled={readOnly}
              onCheckedChange={(checked) => patchS3({ useTLS: checked })}
            />
          </SettingRow>

          <SettingRow
            label={t(
              'audit.setting.archive.s3.deleteLocal',
              '上传成功后删除本地文件'
            )}
            hint={t(
              'audit.setting.archive.s3.deleteLocalHint',
              '默认关闭：本地按「本地保留天数」留几天，同时把全部文件同步到 S3；开启后本地仅作中转（S3 成为唯一长期副本）。'
            )}
          >
            <Switch
              checked={archive.s3.deleteLocalAfterUpload}
              disabled={readOnly}
              onCheckedChange={(checked) =>
                patchS3({ deleteLocalAfterUpload: checked })
              }
            />
          </SettingRow>

          <SettingRow
            label={t(
              'audit.setting.archive.s3.directUpload',
              '内存直传（不落本地）'
            )}
            hint={t(
              'audit.setting.archive.s3.directUploadHint',
              '开启后不再在本地落中转文件，攒批在内存里编码成 parquet 后直接上传对象存储。适合无本地磁盘的部署；上传失败的那一批只计数丢弃（数据库仍是权威、冷归档是尽力而为副本）。'
            )}
          >
            <Switch
              checked={archive.s3.directUpload}
              disabled={readOnly}
              onCheckedChange={(checked) => patchS3({ directUpload: checked })}
            />
          </SettingRow>
        </SettingGroup>

        <SettingGroup
          title={t('audit.setting.archive.es.title', 'Elasticsearch（检索）')}
          description={t(
            'audit.setting.archive.es.description',
            '归档记录写入按天索引供全文检索。ES 只做检索，不替代 S3 归档与本地落库。过期的按天索引会按「保留策略」的保留天数整体删除。'
          )}
        >
          <SettingRow
            label={t('audit.setting.archive.es.enabled', '启用写入')}
            hint={t(
              'audit.setting.archive.es.enabledHint',
              '由存储方式决定：只有 sink=elasticsearch 时才写 ES，其它存储方式下不可开启。'
            )}
          >
            <Switch
              checked={archive.elasticsearch.enabled}
              disabled={readOnly || !elasticsearchSink}
              onCheckedChange={(checked) => patchES({ enabled: checked })}
            />
          </SettingRow>

          <SettingRow
            label={t('audit.setting.archive.es.urls', '节点地址')}
            hint={t(
              'audit.setting.archive.es.urlsHint',
              '多个地址用英文逗号分隔，如 http://es:9200。'
            )}
          >
            <Input
              value={archive.elasticsearch.urls.join(',')}
              placeholder="http://es:9200"
              disabled={readOnly}
              onChange={(event) =>
                patchES({ urls: event.target.value.split(',') })
              }
              className="max-w-96"
            />
            {esIncomplete && (
              <p className="mt-2 text-xs text-destructive">
                {t(
                  'audit.setting.archive.es.urlsRequired',
                  '启用写入时至少填写一个节点地址。'
                )}
              </p>
            )}
          </SettingRow>

          <SettingRow label={t('audit.setting.archive.es.username', '用户名')}>
            <Input
              value={archive.elasticsearch.username}
              disabled={readOnly}
              autoComplete="off"
              onChange={(event) => patchES({ username: event.target.value })}
              className="max-w-60"
            />
          </SettingRow>

          <SettingRow
            label={t('audit.setting.archive.es.password', '密码')}
            hint={t(
              'audit.setting.archive.es.passwordHint',
              '读取时以掩码返回；不修改则保持原值。'
            )}
          >
            <Input
              type="password"
              value={archive.elasticsearch.password}
              disabled={readOnly}
              autoComplete="new-password"
              onChange={(event) => patchES({ password: event.target.value })}
              className="max-w-60"
            />
          </SettingRow>

          <SettingRow
            label={t('audit.setting.archive.es.indexPrefix', '索引前缀')}
            hint={t(
              'audit.setting.archive.es.indexPrefixHint',
              '索引名为 <前缀>-YYYY.MM.DD。'
            )}
          >
            <Input
              value={archive.elasticsearch.indexPrefix}
              placeholder="aerolink-audit"
              disabled={readOnly}
              onChange={(event) => patchES({ indexPrefix: event.target.value })}
              className="max-w-60"
            />
          </SettingRow>

          <SettingRow
            label={t('audit.setting.archive.es.skipVerify', '跳过证书校验')}
            hint={t(
              'audit.setting.archive.es.skipVerifyHint',
              '服务端使用自签证书时开启。'
            )}
          >
            <Switch
              checked={archive.elasticsearch.tlsInsecureSkipVerify}
              disabled={readOnly}
              onCheckedChange={(checked) =>
                patchES({ tlsInsecureSkipVerify: checked })
              }
            />
          </SettingRow>
        </SettingGroup>

        {/* VictoriaLogs：与 ES 同构，但单 stream、服务端保留，没有索引前缀与按天索引。 */}
        <SettingGroup
          title={t('audit.setting.archive.victorialogs.title', 'VictoriaLogs')}
          description={t(
            'audit.setting.archive.victorialogs.description',
            '写入走 ES bulk 兼容接口、检索走 LogsQL；单 stream（服务端按时间分区），过期由服务端 -retentionPeriod 负责。注意：这是 VictoriaLogs（日志库），不是 VictoriaMetrics（时序库）。'
          )}
        >
          <SettingRow
            label={t('audit.setting.archive.victorialogs.enabled', '启用写入')}
            hint={t(
              'audit.setting.archive.victorialogs.enabledHint',
              '由存储方式决定：只有 sink=victorialogs 时才写 VictoriaLogs，其它存储方式下不可开启。'
            )}
          >
            <Switch
              checked={archive.victorialogs.enabled}
              disabled={readOnly || !victoriaLogsSink}
              onCheckedChange={(checked) =>
                patchVictoriaLogs({ enabled: checked })
              }
            />
          </SettingRow>

          <SettingRow
            label={t('audit.setting.archive.victorialogs.urls', '节点地址')}
            hint={t(
              'audit.setting.archive.victorialogs.urlsHint',
              '多个地址用英文逗号分隔（写入时轮询）；默认端口 9428。'
            )}
          >
            <Input
              value={archive.victorialogs.urls.join(',')}
              placeholder="http://victorialogs:9428"
              disabled={readOnly}
              onChange={(event) =>
                patchVictoriaLogs({ urls: event.target.value.split(',') })
              }
              className="max-w-96"
            />
            {victoriaLogsIncomplete && (
              <p className="mt-2 text-xs text-destructive">
                {t(
                  'audit.setting.archive.victorialogs.urlsRequired',
                  '启用写入时至少填写一个节点地址。'
                )}
              </p>
            )}
          </SettingRow>

          <SettingRow
            label={t('audit.setting.archive.victorialogs.stream', '日志流名')}
            hint={t(
              'audit.setting.archive.victorialogs.streamHint',
              '四类记录共用这一个流，靠 kind 字段区分；不按天分名。'
            )}
          >
            <Input
              value={archive.victorialogs.stream}
              placeholder="aerolink-audit"
              disabled={readOnly}
              onChange={(event) =>
                patchVictoriaLogs({ stream: event.target.value })
              }
              className="max-w-60"
            />
          </SettingRow>

          <SettingRow
            label={t(
              'audit.setting.archive.victorialogs.accountId',
              'Account ID'
            )}
            hint={t(
              'audit.setting.archive.victorialogs.tenantHint',
              '多租户部署才填（日志存储端按租户隔离），单租户留空。'
            )}
          >
            <Input
              value={archive.victorialogs.accountId}
              disabled={readOnly}
              autoComplete="off"
              onChange={(event) =>
                patchVictoriaLogs({ accountId: event.target.value })
              }
              className="max-w-40"
            />
          </SettingRow>

          <SettingRow
            label={t(
              'audit.setting.archive.victorialogs.projectId',
              'Project ID'
            )}
            hint={t(
              'audit.setting.archive.victorialogs.tenantHint',
              '多租户部署才填（日志存储端按租户隔离），单租户留空。'
            )}
          >
            <Input
              value={archive.victorialogs.projectId}
              disabled={readOnly}
              autoComplete="off"
              onChange={(event) =>
                patchVictoriaLogs({ projectId: event.target.value })
              }
              className="max-w-40"
            />
          </SettingRow>

          <SettingRow
            label={t(
              'audit.setting.archive.victorialogs.skipVerify',
              '跳过证书校验'
            )}
            hint={t(
              'audit.setting.archive.victorialogs.skipVerifyHint',
              '服务端使用自签证书时开启。'
            )}
          >
            <Switch
              checked={archive.victorialogs.tlsInsecureSkipVerify}
              disabled={readOnly}
              onCheckedChange={(checked) =>
                patchVictoriaLogs({ tlsInsecureSkipVerify: checked })
              }
            />
          </SettingRow>
        </SettingGroup>

        {/*
          OpenObserve：写入走 /api/{org}/{stream}/_json，检索走它自己的搜索接口。
          它自己的接口在不同版本间有过调整，所以后端把「路径 + 请求体 + 响应体」集中在一处、
          并用单测钉住形状（见 pkg/audit/openobserve_sink.go 的注释）。
        */}
        <SettingGroup
          title={t('audit.setting.archive.openobserve.title', 'OpenObserve')}
          description={t(
            'audit.setting.archive.openobserve.description',
            '写入走它自己的 JSON 摄取接口、检索走它自己的搜索接口；单 stream，过期由服务端 stream 的 data_retention 负责。'
          )}
        >
          <SettingRow
            label={t('audit.setting.archive.openobserve.enabled', '启用写入')}
            hint={t(
              'audit.setting.archive.openobserve.enabledHint',
              '由存储方式决定：只有 sink=openobserve 时才写 OpenObserve，其它存储方式下不可开启。'
            )}
          >
            <Switch
              checked={archive.openobserve.enabled}
              disabled={readOnly || !openObserveSink}
              onCheckedChange={(checked) =>
                patchOpenObserve({ enabled: checked })
              }
            />
          </SettingRow>

          <SettingRow
            label={t('audit.setting.archive.openobserve.urls', '节点地址')}
            hint={t(
              'audit.setting.archive.openobserve.urlsHint',
              '多个地址用英文逗号分隔（写入时轮询）；默认端口 5080。'
            )}
          >
            <Input
              value={archive.openobserve.urls.join(',')}
              placeholder="http://openobserve:5080"
              disabled={readOnly}
              onChange={(event) =>
                patchOpenObserve({ urls: event.target.value.split(',') })
              }
              className="max-w-96"
            />
            {openObserveIncomplete && (
              <p className="mt-2 text-xs text-destructive">
                {t(
                  'audit.setting.archive.openobserve.urlsRequired',
                  '启用写入时至少填写一个节点地址。'
                )}
              </p>
            )}
          </SettingRow>

          <SettingRow
            label={t('audit.setting.archive.openobserve.org', '组织（Org）')}
            hint={t(
              'audit.setting.archive.openobserve.orgHint',
              '默认 default；流名与组织名一起决定写入路径 /api/{org}/{stream}/_json。'
            )}
          >
            <Input
              value={archive.openobserve.org}
              placeholder="default"
              disabled={readOnly}
              onChange={(event) =>
                patchOpenObserve({ org: event.target.value })
              }
              className="max-w-40"
            />
          </SettingRow>

          <SettingRow
            label={t('audit.setting.archive.openobserve.stream', '日志流名')}
            hint={t(
              'audit.setting.archive.openobserve.streamHint',
              '四类记录共用这一个流，靠 kind 字段区分；不按天分名。'
            )}
          >
            <Input
              value={archive.openobserve.stream}
              placeholder="aerolink-audit"
              disabled={readOnly}
              onChange={(event) =>
                patchOpenObserve({ stream: event.target.value })
              }
              className="max-w-60"
            />
          </SettingRow>

          <SettingRow
            label={t('audit.setting.archive.openobserve.username', '用户名')}
            hint={t(
              'audit.setting.archive.openobserve.usernameHint',
              'OpenObserve 的 Basic 认证用户名通常是登录邮箱。'
            )}
          >
            <Input
              value={archive.openobserve.username}
              disabled={readOnly}
              autoComplete="off"
              onChange={(event) =>
                patchOpenObserve({ username: event.target.value })
              }
              className="max-w-60"
            />
          </SettingRow>

          <SettingRow
            label={t('audit.setting.archive.openobserve.password', '密码')}
            hint={t(
              'audit.setting.archive.openobserve.passwordHint',
              '读取时以掩码返回；不修改则保持原值。'
            )}
          >
            <Input
              type="password"
              value={archive.openobserve.password}
              disabled={readOnly}
              autoComplete="new-password"
              onChange={(event) =>
                patchOpenObserve({ password: event.target.value })
              }
              className="max-w-60"
            />
          </SettingRow>

          <SettingRow
            label={t(
              'audit.setting.archive.openobserve.skipVerify',
              '跳过证书校验'
            )}
            hint={t(
              'audit.setting.archive.openobserve.skipVerifyHint',
              '服务端使用自签证书时开启。'
            )}
          >
            <Switch
              checked={archive.openobserve.tlsInsecureSkipVerify}
              disabled={readOnly}
              onCheckedChange={(checked) =>
                patchOpenObserve({ tlsInsecureSkipVerify: checked })
              }
            />
          </SettingRow>
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

/**
 * 系统设置 → 系统日志：访问日志（HTTP 访问记录）的归档与输出配置。
 *
 * 与审计设置拆成**两个导航项**而不是同一页的两个页签：两类参数的调优节奏完全不同
 * （访问日志量级大得多、默认保留期更短），放在一页很容易把一类的值改成另一类的。
 *
 * 权限沿用 `settings.audit`——访问日志归档本来就在那份配置里（`audit_settings` 的
 * `archive.accessLog`），拆出去只是换个入口，不新增授权章节。
 */
export function SystemLogSetting() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { readOnly } = useSettingsSectionAccess()
  const { data } = useAuditSetting()
  const [formData, setFormData] = useState<AuditSettingData>(DEFAULT_FORM)
  // 访问日志只能随归档通道落地（parquet 或 ES）：sink=database 时没有归档通道，
  // 访问日志只走标准输出，这个开关也就没有意义（见方案 §12.13）。
  const databaseSink = (data?.sink ?? 'database') === 'database'

  useEffect(() => {
    if (data?.setting) {
      setFormData(data.setting)
    }
  }, [data])

  const mutation = useMutation({
    mutationFn: (payload: AuditSettingData) => updateAuditSetting(payload),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ['audit-setting'] })
      toast.success(t('audit.setting.messages.updated', '审计设置已保存'))

      // 与审计设置一致：保存后后端会探一次目标存储，探测失败要当场告诉管理员，
      // 否则「配置存进去了、归档其实跑不起来」只能等下次查日志才发现。
      const warnings = response?.warnings ?? []
      if (warnings.length > 0) {
        toast.warning(
          t(
            'audit.setting.messages.probeFailed',
            '配置已保存，但连通性检查未通过：{{detail}}',
            { detail: warnings.join('; ') }
          ),
          { duration: 10000 }
        )
      }
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const archive = formData.archive
  const patchAccessLog = (patch: Partial<AccessLogArchiveSetting>) =>
    setFormData((prev) => ({
      ...prev,
      archive: {
        ...prev.archive,
        accessLog: { ...prev.archive.accessLog, ...patch },
      },
    }))

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('audit.systemLog.title', '系统日志')}</CardTitle>
        <p className="text-muted-foreground text-sm">
          {t(
            'audit.systemLog.description',
            '访问日志（HTTP 访问记录）的归档与输出格式。与审计日志分开配置：访问日志量级大得多，默认保留期更短。'
          )}
        </p>
      </CardHeader>

      <CardContent className="space-y-4">
        <SettingGroup
          title={t('audit.setting.archive.accessLog.title', '访问日志归档')}
          description={t(
            'audit.setting.archive.accessLog.description',
            '访问日志量级大，默认保留期更短，与审计日志分开配置。'
          )}
        >
          <SettingRow
            label={t('audit.setting.archive.accessLog.enabled', '纳入归档')}
            hint={t(
              'audit.setting.archive.accessLog.enabledHint',
              'parquet 下由这里决定是否写访问日志；sink=database 时没有归档通道，访问日志只走标准输出。'
            )}
          >
            <Switch
              checked={archive.accessLog.enabled}
              disabled={readOnly || databaseSink}
              onCheckedChange={(checked) =>
                patchAccessLog({ enabled: checked })
              }
            />
          </SettingRow>

          <SettingRow
            label={t(
              'audit.setting.archive.accessLog.retentionDays',
              '本地保留天数'
            )}
          >
            <Input
              type="number"
              min={0}
              value={archive.accessLog.retentionDays}
              disabled={readOnly}
              onChange={(event) =>
                patchAccessLog({
                  retentionDays: numberOrZero(event.target.value),
                })
              }
              className="max-w-32"
            />
          </SettingRow>

          <SettingRow
            label={t(
              'audit.setting.archive.accessLog.maxBytes',
              '本地容量上限（字节）'
            )}
          >
            <Input
              type="number"
              min={0}
              value={archive.accessLog.maxBytes}
              disabled={readOnly}
              onChange={(event) =>
                patchAccessLog({ maxBytes: numberOrZero(event.target.value) })
              }
              className="max-w-48"
            />
          </SettingRow>

          <SettingRow
            label={t('audit.setting.archive.accessLog.format', '输出格式')}
            hint={t(
              'audit.setting.archive.accessLog.formatHint',
              '控制台标准输出的访问日志格式：text 保持现状，json 为结构化单行。'
            )}
          >
            <Select
              value={archive.accessLog.format}
              disabled={readOnly}
              onValueChange={(value) =>
                patchAccessLog({ format: value as LogFormat })
              }
            >
              <SelectTrigger className="max-w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LOG_FORMATS.map((format) => (
                  <SelectItem key={format} value={format}>
                    {t(
                      `audit.setting.logFormat.${format}`,
                      format.toUpperCase()
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>

          <SettingRow
            label={t(
              'audit.setting.archive.accessLog.flushInterval',
              '攒批间隔（秒）'
            )}
            hint={t(
              'audit.setting.archive.accessLog.flushIntervalHint',
              '访问日志量大，默认攒批更大：到间隔、条数或字节任一阈值即落一个 parquet 文件。'
            )}
          >
            <Input
              type="number"
              min={0}
              value={archive.accessLog.flush.intervalSeconds}
              disabled={readOnly}
              onChange={(event) =>
                patchAccessLog({
                  flush: {
                    ...archive.accessLog.flush,
                    intervalSeconds: numberOrZero(event.target.value),
                  },
                })
              }
              className="max-w-32"
            />
          </SettingRow>

          <SettingRow
            label={t(
              'audit.setting.archive.accessLog.flushRows',
              '单批最大条数'
            )}
          >
            <Input
              type="number"
              min={0}
              value={archive.accessLog.flush.maxBatchRows}
              disabled={readOnly}
              onChange={(event) =>
                patchAccessLog({
                  flush: {
                    ...archive.accessLog.flush,
                    maxBatchRows: numberOrZero(event.target.value),
                  },
                })
              }
              className="max-w-40"
            />
          </SettingRow>

          <SettingRow
            label={t(
              'audit.setting.archive.accessLog.flushBytes',
              '单批最大字节数'
            )}
            hint={t(
              'audit.setting.archive.accessLog.flushBytesHint',
              '0 表示不按字节触发。'
            )}
          >
            <Input
              type="number"
              min={0}
              value={archive.accessLog.flush.maxBatchBytes}
              disabled={readOnly}
              onChange={(event) =>
                patchAccessLog({
                  flush: {
                    ...archive.accessLog.flush,
                    maxBatchBytes: numberOrZero(event.target.value),
                  },
                })
              }
              className="max-w-48"
            />
          </SettingRow>
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
            disabled={readOnly || mutation.isPending}
            onClick={() => mutation.mutate(formData)}
          >
            {t('common.actions.submit', 'Submit')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
