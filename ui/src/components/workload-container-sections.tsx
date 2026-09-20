import type { Container, Probe } from 'kubernetes-types/core/v1'
import { useTranslation } from 'react-i18next'

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
import type { PortForm } from '@/components/editors/deployment-form'

type OnUpdate = (updates: Partial<Container>) => void

const intOrUndefined = (value: string) => {
  if (!value.trim()) return undefined
  const num = Number(value)
  return Number.isNaN(num) ? undefined : num
}

/**
 * 网络：容器的监听端口。
 *
 * Service 是独立对象、由它自己的选择器决定关联哪些 Pod，因此不再在这里定义与生成：
 * 需要 Service 就去「服务」页面创建（选择本工作负载的 Pod 标签），本页只展示已关联的
 * Service 名称并给出跳转入口（见 AssociatedServices）。
 */
export function PortsEditor({
  ports,
  onUpdate,
}: {
  ports: PortForm[]
  onUpdate: (ports: PortForm[]) => void
}) {
  const { t } = useTranslation()

  const updatePort = (index: number, patch: Partial<PortForm>) => {
    onUpdate(ports.map((p, i) => (i === index ? { ...p, ...patch } : p)))
  }

  const portError = (p: PortForm) => {
    if (!p.containerPort || p.containerPort < 1 || p.containerPort > 65535)
      return t('containerAdv.portRangeError', '容器端口必须为 1-65535 的数字')
    return null
  }

  return (
    <div className="space-y-2">
      <h4 className="text-base font-medium">
        {t('containerAdv.networkTitle', '网络')}
      </h4>
      <p className="text-xs text-muted-foreground">
        {t(
          'containerAdv.networkHint',
          '容器监听的端口。要在集群内外访问它们，请在「服务」页面创建 Service 并选中本工作负载的 Pod 标签。'
        )}
      </p>
      {ports.map((port, index) => {
        const error = portError(port)
        return (
          <div key={index} className="space-y-1">
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-normal text-muted-foreground">
                  {t('containerAdv.portName', '端口名称')}
                </Label>
                <Input
                  value={port.name || ''}
                  onChange={(e) =>
                    updatePort(index, { name: e.target.value || undefined })
                  }
                  placeholder={t('containerAdv.portNameHint', '可留空')}
                  className="h-9"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-normal text-muted-foreground">
                  {t('containerAdv.privatePortLabel', '容器端口')}
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
                    (!port.containerPort ||
                    port.containerPort < 1 ||
                    port.containerPort > 65535
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
          onUpdate([...ports, { containerPort: 80, protocol: 'TCP' as const }])
        }
      >
        {t('containerAdv.addPort', '添加端口')}
      </Button>
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
