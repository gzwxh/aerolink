import type { Container, Probe } from 'kubernetes-types/core/v1'
import { useTranslation } from 'react-i18next'

import { useNodePortRange } from '@/hooks/use-node-port-range'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { CommandListInput } from '@/components/command-list-input'
import {
  isValidClusterIP,
  isValidContainerPort,
  type PortForm,
  type PortServiceType,
} from '@/components/editors/deployment-form'

type OnUpdate = (updates: Partial<Container>) => void

const intOrUndefined = (value: string) => {
  if (!value.trim()) return undefined
  const num = Number(value)
  return Number.isNaN(num) ? undefined : num
}

/**
 * 网络：容器的监听端口，以及端口上声明的 Service。
 *
 * 端口行选了 Service 类型时，保存会连同工作负载一起生成 Service 文档（见
 * `buildServiceDocuments`）：同一类型的端口合成一个 Service，选择器取本工作负载的标签。
 */
export function PortsEditor({
  ports,
  onUpdate,
  workloadName = '',
}: {
  ports: PortForm[]
  onUpdate: (ports: PortForm[]) => void
  /** 工作负载名，用于预览自动生成的 Service 名称。 */
  workloadName?: string
}) {
  const { t } = useTranslation()
  // 只有拿到集群真实配置时才按它提示与校验；拿不到时为 null（见 lib/node-port-range.ts）。
  const range = useNodePortRange()

  const updatePort = (index: number, patch: Partial<PortForm>) => {
    onUpdate(ports.map((p, i) => (i === index ? { ...p, ...patch } : p)))
  }

  // 与 buildServiceDocuments 的口径一致：名称为空时 ClusterIP 取工作负载名，
  // 其余类型取 "<工作负载>-<类型小写>"。
  const autoServiceName = (type: PortServiceType) => {
    const base = workloadName.trim()
    if (!base || type === 'none') return ''
    return type === 'ClusterIP' ? base : `${base}-${type.toLowerCase()}`
  }

  const messages = {
    containerPort: t(
      'containerAdv.portRangeError',
      '容器端口必须为 1-65535 的数字'
    ),
    nodePort: range
      ? t('containerAdv.nodePortRangeError', {
          min: range.min,
          max: range.max,
          defaultValue: `监听端口必须在 ${range.min}-${range.max} 范围内`,
        })
      : '',
    servicePort: t(
      'containerAdv.servicePortRangeError',
      '监听端口必须为 1-65535'
    ),
    clusterIP: t(
      'containerAdv.clusterIPFormatError',
      '主机 IP 格式不正确，例如 1.1.1.1'
    ),
  }

  const portError = (p: PortForm) => {
    if (!isValidContainerPort(p.containerPort)) return messages.containerPort
    // 监听端口留空是合法的：集群会自动分配一个。范围未知时不判，免得拿默认值把
    // 合法端口标红；真越界由 API 拒绝。
    if (
      range &&
      p.serviceType === 'NodePort' &&
      p.nodePort &&
      (p.nodePort < range.min || p.nodePort > range.max)
    )
      return messages.nodePort
    if (p.servicePort && !isValidContainerPort(p.servicePort))
      return messages.servicePort
    if (
      p.serviceType === 'ClusterIP' &&
      p.clusterIP?.trim() &&
      !isValidClusterIP(p.clusterIP)
    )
      return messages.clusterIP
    return null
  }

  const SERVICE_TYPES: Array<{ value: PortServiceType; label: string }> = [
    { value: 'none', label: t('containerAdv.svcNone', '不创建服务') },
    { value: 'ClusterIP', label: 'ClusterIP' },
    { value: 'NodePort', label: 'NodePort' },
    { value: 'LoadBalancer', label: 'LoadBalancer' },
  ]

  return (
    <div className="space-y-2">
      <h4 className="text-base font-medium">
        {t('containerAdv.networkTitle', '网络')}
      </h4>
      <p className="text-xs text-muted-foreground">
        {t(
          'containerAdv.networkHintFull',
          '定义一个 Service 公开容器；选择 ClusterIP、LoadBalancer 或 NodePort 会自动创建 Service 并关联本工作负载的 Pod。'
        )}
      </p>
      {ports.map((port, index) => {
        const error = portError(port)
        return (
          <div key={index} className="space-y-1">
            <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_100px_minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-normal text-muted-foreground">
                  {t('containerAdv.serviceTypeLabel', 'Service 类型')}
                </Label>
                <Select
                  value={port.serviceType}
                  onValueChange={(v) =>
                    updatePort(index, { serviceType: v as PortServiceType })
                  }
                >
                  <SelectTrigger className="h-9 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SERVICE_TYPES.map((st) => (
                      <SelectItem key={st.value} value={st.value}>
                        {st.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-normal text-muted-foreground">
                  {t('containerAdv.serviceNameLabel', '名称')}
                </Label>
                <Input
                  value={port.name || ''}
                  onChange={(e) =>
                    updatePort(index, { name: e.target.value || undefined })
                  }
                  placeholder={
                    autoServiceName(port.serviceType)
                      ? t('containerAdv.portNameAuto', {
                          name: autoServiceName(port.serviceType),
                          defaultValue: `默认: ${autoServiceName(port.serviceType)}`,
                        })
                      : t('containerAdv.portName', '名称')
                  }
                  className="h-9"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-normal text-muted-foreground">
                  {t('containerAdv.privatePortLabel', '私有容器端口')}
                </Label>
                <Input
                  type="number"
                  min={1}
                  max={65535}
                  value={port.containerPort ?? ''}
                  onChange={(e) =>
                    updatePort(index, {
                      containerPort: intOrUndefined(e.target.value) ?? 0,
                    })
                  }
                  placeholder={t(
                    'containerAdv.containerPortPlaceholder',
                    'e.g. 8080'
                  )}
                  className={
                    'h-9 ' +
                    (error === messages.containerPort
                      ? 'border-destructive'
                      : '')
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-normal text-muted-foreground">
                  {t('containerAdv.protocol', '协议')}
                </Label>
                <Select
                  value={port.protocol}
                  onValueChange={(v) =>
                    updatePort(index, { protocol: v as 'TCP' | 'UDP' })
                  }
                >
                  <SelectTrigger className="h-9 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="TCP">TCP</SelectItem>
                    <SelectItem value="UDP">UDP</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-normal text-muted-foreground">
                  {port.serviceType === 'NodePort'
                    ? t('containerAdv.nodePort', '监听端口')
                    : port.serviceType === 'none'
                      ? '\u00A0'
                      : t('containerAdv.servicePortLabel', '监听端口')}
                </Label>
                {port.serviceType === 'none' ? (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-9 px-0 text-xs"
                    onClick={() =>
                      onUpdate([
                        ...ports,
                        {
                          containerPort: 0,
                          protocol: 'TCP' as const,
                          serviceType: 'ClusterIP' as const,
                        },
                      ])
                    }
                  >
                    {t('containerAdv.addHost', '添加主机')}
                  </Button>
                ) : (
                  <Input
                    type="number"
                    min={
                      port.serviceType === 'NodePort' && range ? range.min : 1
                    }
                    max={
                      port.serviceType === 'NodePort' && range
                        ? range.max
                        : 65535
                    }
                    value={
                      port.serviceType === 'NodePort'
                        ? (port.nodePort ?? '')
                        : (port.servicePort ?? '')
                    }
                    onChange={(e) => {
                      const v = intOrUndefined(e.target.value)
                      updatePort(
                        index,
                        port.serviceType === 'NodePort'
                          ? { nodePort: v, servicePort: v }
                          : { servicePort: v }
                      )
                    }}
                    placeholder={
                      port.serviceType === 'NodePort'
                        ? t(
                            'containerAdv.nodePortAutoPlaceholder',
                            '留空自动分配'
                          )
                        : port.serviceType === 'LoadBalancer'
                          ? t('containerAdv.listenPortPlaceholder', 'e.g. 8080')
                          : t('containerAdv.publicPortPlaceholder', 'e.g. 80')
                    }
                    className={
                      'h-9 ' +
                      (error === messages.nodePort ||
                      error === messages.servicePort
                        ? 'border-destructive'
                        : '')
                    }
                  />
                )}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-normal text-muted-foreground">
                  {port.serviceType === 'ClusterIP'
                    ? t('containerAdv.hostIPLabel', '主机 IP')
                    : '\u00A0'}
                </Label>
                {port.serviceType === 'ClusterIP' ? (
                  <Input
                    value={port.clusterIP ?? ''}
                    onChange={(e) =>
                      updatePort(index, { clusterIP: e.target.value })
                    }
                    placeholder={t('containerAdv.hostIP', 'e.g. 1.1.1.1')}
                    className={
                      'h-9 ' +
                      (error === messages.clusterIP ? 'border-destructive' : '')
                    }
                  />
                ) : (
                  <div className="h-9" />
                )}
              </div>
              <button
                type="button"
                className="flex h-9 shrink-0 items-center text-sm text-primary transition-colors hover:underline"
                onClick={() => onUpdate(ports.filter((_, i) => i !== index))}
              >
                {t('containerAdv.remove', '移除')}
              </button>
            </div>
            {error && <p className="pl-1 text-xs text-destructive">{error}</p>}
          </div>
        )
      })}

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 border-primary/40 bg-primary/5 text-xs text-primary hover:bg-primary/10 hover:text-primary"
        onClick={() =>
          onUpdate([
            ...ports,
            {
              containerPort: 80,
              protocol: 'TCP' as const,
              serviceType: 'ClusterIP' as const,
            },
          ])
        }
      >
        {t('containerAdv.addPortOrService', '添加端口或Service')}
      </Button>
      {ports.some((p) => p.serviceType === 'NodePort') && (
        <p className="text-xs text-muted-foreground">
          {range
            ? t('containerAdv.nodePortRangeHint', {
                min: range.min,
                max: range.max,
                defaultValue: '监听端口范围 {{min}}-{{max}}，留空自动分配',
              })
            : t(
                'containerAdv.nodePortRangeHintUnknown',
                '留空自动分配，端口范围以集群实际配置为准'
              )}
        </p>
      )}
    </div>
  )
}

/** 命令: command / args / workingDir / stdin. */
export function CommandEditor({
  container,
  onUpdate,
}: {
  container: Container
  onUpdate: OnUpdate
}) {
  const { t } = useTranslation()
  return (
    <div className="space-y-3">
      <h4 className="text-base font-medium">
        {t('containerAdv.commandTitle', '命令')}
      </h4>
      <div className="grid grid-cols-1 items-start gap-x-6 gap-y-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs">{t('containerAdv.command', '命令')}</Label>
          <CommandListInput
            value={container.command || []}
            onChange={(command) => onUpdate({ command })}
            placeholder={t('containerAdv.commandPlaceholder', '例如: /bin/sh')}
            className="h-9"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t('containerAdv.args', '参数')}</Label>
          <CommandListInput
            value={container.args || []}
            onChange={(args) => onUpdate({ args })}
            placeholder={t(
              'containerAdv.argsPlaceholder',
              '例如: /usr/sbin/httpd -f httpd.conf'
            )}
            className="h-9"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">
            {t('containerAdv.workingDir', '工作目录')}
          </Label>
          <Input
            value={container.workingDir || ''}
            onChange={(e) =>
              onUpdate({ workingDir: e.target.value || undefined })
            }
            placeholder="/myapp"
            className="h-9"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">
            {t('containerAdv.stdin', '标准输入')}
          </Label>
          <Select
            value={container.stdin ? 'yes' : 'no'}
            onValueChange={(v) => onUpdate({ stdin: v === 'yes' })}
          >
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="no">{t('common.values.no', '否')}</SelectItem>
              <SelectItem value="yes">
                {t('common.values.yes', '是')}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  )
}

type ProbeKind = 'readiness' | 'liveness' | 'startup'
type ProbeType = 'none' | 'http' | 'https' | 'tcp' | 'exec'

function probeTypeOf(probe?: Probe): ProbeType {
  if (!probe) return 'none'
  if (probe.httpGet) return probe.httpGet.scheme === 'HTTPS' ? 'https' : 'http'
  if (probe.tcpSocket) return 'tcp'
  if (probe.exec) return 'exec'
  return 'none'
}

const PROBE_LABELS: Record<ProbeKind, string> = {
  readiness: '就绪检查',
  liveness: '存活检查',
  startup: '启动检查',
}

function ProbeField({
  kind,
  probe,
  setProbe,
}: {
  kind: ProbeKind
  probe?: Probe
  setProbe: (next: Probe | undefined) => void
}) {
  const { t } = useTranslation()
  const type = probeTypeOf(probe)
  const patch = (updates: Partial<Probe>) =>
    setProbe({ ...(probe || {}), ...updates } as Probe)

  return (
    <div className="space-y-2">
      <h5 className="text-sm font-medium">
        {t(`containerAdv.probe.${kind}`, PROBE_LABELS[kind])}
      </h5>
      <div className="max-w-md space-y-1.5">
        <Label className="text-xs">{t('containerAdv.probeType', '类型')}</Label>
        <Select
          value={type}
          onValueChange={(v) => {
            const next = v as ProbeType
            if (next === 'none') return setProbe(undefined)
            if (next === 'http')
              return setProbe({
                httpGet: { path: '/', port: 80, scheme: 'HTTP' },
              } as never)
            if (next === 'https')
              return setProbe({
                httpGet: { path: '/', port: 443, scheme: 'HTTPS' },
              } as never)
            if (next === 'tcp')
              return setProbe({ tcpSocket: { port: 80 } as never })
            return setProbe({ exec: { command: [] } })
          }}
        >
          <SelectTrigger className="h-9 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">
              {t('containerAdv.probeNone', '无')}
            </SelectItem>
            <SelectItem value="http">
              {t(
                'containerAdv.probeHttp',
                'HTTP 请求返回成功的状态（200-399）'
              )}
            </SelectItem>
            <SelectItem value="https">
              {t('containerAdv.probeHttps', 'HTTPS 请求返回成功的状态')}
            </SelectItem>
            <SelectItem value="tcp">
              {t('containerAdv.probeTcp', '成功启动 TCP 连接')}
            </SelectItem>
            <SelectItem value="exec">
              {t('containerAdv.probeExec', '容器内运行的命令以 0 状态退出')}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {probe && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {probe.httpGet && (
            <>
              <div className="space-y-1.5">
                <Label className="text-xs">
                  {t('containerAdv.probePath', '路径')}
                </Label>
                <Input
                  value={probe.httpGet.path || ''}
                  onChange={(e) =>
                    setProbe({
                      ...probe,
                      httpGet: { ...probe.httpGet!, path: e.target.value },
                    } as Probe)
                  }
                  placeholder="/healthz"
                  className="h-9"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">
                  {t('containerAdv.probePort', '端口')}
                </Label>
                <Input
                  type="number"
                  value={
                    typeof probe.httpGet.port === 'number'
                      ? probe.httpGet.port
                      : ''
                  }
                  onChange={(e) =>
                    setProbe({
                      ...probe,
                      httpGet: {
                        ...probe.httpGet!,
                        port: intOrUndefined(e.target.value) ?? 0,
                      },
                    } as Probe)
                  }
                  className="h-9"
                />
              </div>
            </>
          )}
          {probe.tcpSocket && (
            <div className="space-y-1.5">
              <Label className="text-xs">
                {t('containerAdv.probePort', '端口')}
              </Label>
              <Input
                type="number"
                value={
                  typeof probe.tcpSocket.port === 'number'
                    ? probe.tcpSocket.port
                    : ''
                }
                onChange={(e) =>
                  setProbe({
                    ...probe,
                    tcpSocket: {
                      ...probe.tcpSocket!,
                      port: intOrUndefined(e.target.value) ?? 0,
                    },
                  } as Probe)
                }
                className="h-9"
              />
            </div>
          )}
          {probe.exec && (
            <div className="space-y-1.5 sm:col-span-3">
              <Label className="text-xs">
                {t('containerAdv.probeCommand', '命令（空格分隔）')}
              </Label>
              <CommandListInput
                value={probe.exec.command || []}
                onChange={(command) =>
                  setProbe({ ...probe, exec: { command } } as Probe)
                }
                placeholder="cat /tmp/ready"
                className="h-9"
              />
            </div>
          )}
          <div className="space-y-1.5">
            <Label className="text-xs">
              {t('containerAdv.probeDelay', '初始延迟(秒)')}
            </Label>
            <Input
              type="number"
              min={0}
              value={probe.initialDelaySeconds ?? ''}
              onChange={(e) =>
                patch({ initialDelaySeconds: intOrUndefined(e.target.value) })
              }
              className="h-9"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">
              {t('containerAdv.probePeriod', '检查间隔(秒)')}
            </Label>
            <Input
              type="number"
              min={1}
              value={probe.periodSeconds ?? ''}
              onChange={(e) =>
                patch({ periodSeconds: intOrUndefined(e.target.value) })
              }
              className="h-9"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">
              {t('containerAdv.probeThreshold', '失败阈值')}
            </Label>
            <Input
              type="number"
              min={1}
              value={probe.failureThreshold ?? ''}
              onChange={(e) =>
                patch({ failureThreshold: intOrUndefined(e.target.value) })
              }
              className="h-9"
            />
          </div>
        </div>
      )}
    </div>
  )
}

/** 健康检查: readiness / liveness / startup probes. */
export function ProbesEditor({
  container,
  onUpdate,
}: {
  container: Container
  onUpdate: OnUpdate
}) {
  const { t } = useTranslation()
  const renderProbe = (kind: ProbeKind) => {
    const key = `${kind}Probe` as
      'readinessProbe' | 'livenessProbe' | 'startupProbe'
    const probe = (container[key] as Probe | undefined) || undefined
    return (
      <ProbeField
        key={kind}
        kind={kind}
        probe={probe}
        setProbe={(next) => onUpdate({ [key]: next } as Partial<Container>)}
      />
    )
  }

  return (
    <div className="space-y-6">
      <h4 className="text-base font-medium">
        {t('containerAdv.healthTitle', '健康检查')}
      </h4>
      {renderProbe('readiness')}
      {renderProbe('liveness')}
      {renderProbe('startup')}
    </div>
  )
}
