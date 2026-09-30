import { Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
  emptyPortRow,
  type PortRow,
  type ServicePortErrorCode,
  type ServiceType,
} from '@/lib/service-yaml'
import { useNodePortRange } from '@/hooks/use-node-port-range'
import { useServicePortErrorText } from '@/hooks/use-service-port-error-text'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface ServicePortsEditorProps {
  ports: PortRow[]
  serviceType: ServiceType
  /** 行号 → 错误码；用 `lib/service-yaml.ts` 的 `servicePortErrorCodes` 算，与提交校验共用一份。 */
  errors?: Map<number, ServicePortErrorCode>
  onChange: (ports: PortRow[]) => void
}

/**
 * Service 的端口行编辑器（名称 / 端口 / 目标端口 / NodePort / 协议 / 删除 + 行内错误）。
 *
 * Service 创建页与工作负载详情页的「暴露」弹窗共用：两处都是「编一组 Service 端口」，
 * 各写一套迟早会漂移 —— 弹窗以前只能编一对「端口 + 目标端口」，创建页支持端口名与 UDP。
 *
 * NodePort 输入框只在 NodePort 类型下出现；范围提示按集群真实值给（见 lib/node-port-range.ts），
 * 拿不到集群范围时不提示具体数字，也不做范围校验。
 */
export function ServicePortsEditor({
  ports,
  serviceType,
  errors,
  onChange,
}: ServicePortsEditorProps) {
  const { t } = useTranslation()
  const nodePortRange = useNodePortRange()
  const errorText = useServicePortErrorText()

  const updatePort = (index: number, patch: Partial<PortRow>) =>
    onChange(ports.map((p, i) => (i === index ? { ...p, ...patch } : p)))

  return (
    <div className="space-y-2 rounded-md border p-3">
      <h4 className="text-sm font-semibold">
        {t('serviceCreate.portsTitle', '端口')}
      </h4>
      {ports.map((port, index) => {
        const code = errors?.get(index)
        return (
          <div key={index} className="space-y-1">
            {/* flex 行让各端口字段等宽，NodePort 出现时也不会把删除按钮挤到第二行。 */}
            <div className="flex items-center gap-2">
              <Input
                value={port.name}
                onChange={(e) => updatePort(index, { name: e.target.value })}
                placeholder={t('serviceCreate.portName', '端口名称')}
                className="h-8 min-w-0 flex-1"
              />
              <Input
                type="number"
                min={1}
                max={65535}
                value={port.port}
                onChange={(e) => updatePort(index, { port: e.target.value })}
                placeholder={t('serviceCreate.port', '端口 *')}
                className={
                  'h-8 min-w-0 flex-1 ' +
                  (code === 'port' ? 'border-destructive' : '')
                }
              />
              <Input
                value={port.targetPort}
                onChange={(e) =>
                  updatePort(index, { targetPort: e.target.value })
                }
                placeholder={t('serviceCreate.targetPort', '目标端口')}
                className={
                  'h-8 min-w-0 flex-1 ' +
                  (code === 'targetPortName' || code === 'targetPortRange'
                    ? 'border-destructive'
                    : '')
                }
              />
              {serviceType === 'NodePort' && (
                <Input
                  type="number"
                  min={nodePortRange?.min ?? 1}
                  max={nodePortRange?.max ?? 65535}
                  value={port.nodePort}
                  onChange={(e) =>
                    updatePort(index, { nodePort: e.target.value })
                  }
                  placeholder={t(
                    'serviceCreate.nodePortPlaceholder',
                    '留空自动分配'
                  )}
                  className={
                    'h-8 min-w-0 flex-1 ' +
                    (code === 'nodePortRange' ? 'border-destructive' : '')
                  }
                />
              )}
              <Select
                value={port.protocol}
                onValueChange={(v) =>
                  updatePort(index, { protocol: v as PortRow['protocol'] })
                }
              >
                <SelectTrigger className="h-8 w-24 shrink-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="TCP">TCP</SelectItem>
                  <SelectItem value="UDP">UDP</SelectItem>
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                aria-label={t('serviceCreate.removePort', '移除该端口')}
                onClick={() => onChange(ports.filter((_, i) => i !== index))}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            {code && (
              <p className="text-xs text-destructive">{errorText(code)}</p>
            )}
          </div>
        )
      })}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 text-xs"
        onClick={() => onChange([...ports, emptyPortRow()])}
      >
        <Plus className="mr-1 h-3.5 w-3.5" />
        {t('serviceCreate.addPort', '添加端口')}
      </Button>
      {serviceType === 'NodePort' && (
        <p className="text-xs text-muted-foreground">
          {nodePortRange
            ? t('serviceCreate.nodePortRangeHint', {
                min: nodePortRange.min,
                max: nodePortRange.max,
                defaultValue: `NodePort 范围 ${nodePortRange.min}-${nodePortRange.max}，留空自动分配`,
              })
            : t(
                'serviceCreate.nodePortRangeHintUnknown',
                '留空自动分配，端口范围以集群实际配置为准'
              )}
        </p>
      )}
    </div>
  )
}
