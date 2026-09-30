import * as yaml from 'js-yaml'
import { Service } from 'kubernetes-types/core/v1'

/**
 * Service 表单 ⇄ manifest 的数据层：类型、初值、生成、以及编辑时的合并。
 * 放在 lib 里而不是页面里，一是与 pv-yaml / storageclass-yaml 的既有约定一致，
 * 二是这些转换（尤其是编辑时的合并）只有脱离页面才好单测。
 */

export type ServiceType =
  'ClusterIP' | 'NodePort' | 'LoadBalancer' | 'ExternalName'

export interface PortRow {
  name: string
  port: string
  targetPort: string
  nodePort: string
  protocol: 'TCP' | 'UDP'
}

export interface ServiceFormData {
  name: string
  namespace: string
  serviceType: ServiceType
  externalName: string
  sessionAffinity: 'None' | 'ClientIP'
  selector: Array<{ key: string; value: string }>
  ports: PortRow[]
}

/** 一行新的端口：创建页的初值与「添加端口」都用它。 */
export const emptyPortRow = (): PortRow => ({
  name: '',
  port: '80',
  targetPort: '',
  nodePort: '',
  protocol: 'TCP',
})

export const initialData: ServiceFormData = {
  name: '',
  namespace: 'default',
  serviceType: 'ClusterIP',
  externalName: '',
  sessionAffinity: 'None',
  selector: [{ key: 'app', value: '' }],
  ports: [emptyPortRow()],
}

export const intOrNull = (v: string) => {
  if (!v.trim()) return undefined
  const n = Number(v)
  return Number.isNaN(n) ? undefined : n
}

/**
 * targetPort 允许写成数字，也允许写容器端口名（k8s 的 IntOrString）。名字必须
 * 是 IANA_SVC_NAME：小写字母/数字，中间可以有 '-'，首尾必须是字母或数字。
 */
export const PORT_NAME_PATTERN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/

/** 把 targetPort 输入框的值转成要提交的形式；空则由 port 兜底（见 generateServiceYaml）。 */
export function resolveTargetPort(raw: string): number | string | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  // 是数字就发数字，否则当容器端口名（k8s 的 IntOrString）。
  return intOrNull(trimmed) ?? trimmed
}

/** 端口行的错误码；文案由调用方（hooks/use-service-port-errors）按语言映射。 */
export type ServicePortErrorCode =
  'port' | 'targetPortName' | 'targetPortRange' | 'nodePortRange'

/**
 * 端口行的行内校验。
 *
 * NodePort 的范围只有拿到集群真实值时才判（见 `lib/node-port-range.ts`）：传 `null` 表示
 * 「不知道集群范围」，此时不做范围校验、把合法性交给 API —— 否则集群自定义过范围时会把
 * 合法端口标红。
 */
export function servicePortErrorCodes(
  ports: PortRow[],
  serviceType: ServiceType,
  nodePortRange: { min: number; max: number } | null
): Map<number, ServicePortErrorCode> {
  const errors = new Map<number, ServicePortErrorCode>()
  if (serviceType === 'ExternalName') return errors

  ports.forEach((p, i) => {
    const port = intOrNull(p.port)
    if (port === undefined || port < 1 || port > 65535) {
      errors.set(i, 'port')
      return
    }
    // targetPort 可以是数字，也可以是容器端口名。
    const rawTarget = p.targetPort.trim()
    if (rawTarget) {
      const target = intOrNull(rawTarget)
      if (target === undefined) {
        if (rawTarget.length > 15 || !PORT_NAME_PATTERN.test(rawTarget)) {
          errors.set(i, 'targetPortName')
          return
        }
      } else if (target < 1 || target > 65535) {
        errors.set(i, 'targetPortRange')
        return
      }
    }
    if (serviceType === 'NodePort' && nodePortRange && p.nodePort.trim()) {
      const np = intOrNull(p.nodePort)
      if (
        np === undefined ||
        np < nodePortRange.min ||
        np > nodePortRange.max
      ) {
        errors.set(i, 'nodePortRange')
      }
    }
  })
  return errors
}

/** 线上 Service → 表单（编辑模式预填）。 */
export function formFromService(service: Service): ServiceFormData {
  const spec = service.spec || {}
  const ports = (spec.ports || []).map((port) => ({
    name: port.name || '',
    port: port.port !== undefined ? String(port.port) : '',
    // targetPort 可能是名字（"http"），原样带回表单，不要当成数字。
    targetPort: port.targetPort !== undefined ? String(port.targetPort) : '',
    nodePort: port.nodePort !== undefined ? String(port.nodePort) : '',
    protocol: port.protocol === 'UDP' ? ('UDP' as const) : ('TCP' as const),
  }))
  return {
    name: service.metadata?.name || '',
    namespace: service.metadata?.namespace || 'default',
    serviceType: (spec.type as ServiceType) || 'ClusterIP',
    externalName: spec.externalName || '',
    sessionAffinity: spec.sessionAffinity === 'ClientIP' ? 'ClientIP' : 'None',
    selector: Object.entries(spec.selector || {}).map(([key, value]) => ({
      key,
      value,
    })),
    ports,
  }
}

/**
 * 编辑模式下允许选的服务类型：ExternalName 与其他类型之间不能互相转换，
 * API 会以 `may not change type` 拒绝，所以编辑时只放行兼容的那几个。
 */
export function allowedServiceTypes(current: ServiceType): ServiceType[] {
  return current === 'ExternalName'
    ? ['ExternalName']
    : ['ClusterIP', 'NodePort', 'LoadBalancer']
}

export function generateServiceYaml(d: ServiceFormData): string {
  const selector = d.selector.reduce<Record<string, string>>((acc, s) => {
    if (s.key.trim() && s.value.trim()) acc[s.key.trim()] = s.value.trim()
    return acc
  }, {})

  const metadata: Record<string, unknown> = {
    name: d.name,
    namespace: d.namespace,
  }
  const spec: Record<string, unknown> = { type: d.serviceType }

  if (d.serviceType === 'ExternalName') {
    spec.externalName = d.externalName
  } else {
    if (Object.keys(selector).length > 0) spec.selector = selector
    if (d.sessionAffinity !== 'None') spec.sessionAffinity = d.sessionAffinity
    const ports = d.ports
      .map((p) => {
        const port = intOrNull(p.port)
        if (!port) return null
        const targetPort = resolveTargetPort(p.targetPort) ?? port
        // NodePort 与 LoadBalancer 的 nodePort 由 API 分配，表单不一定展示它，
        // 但编辑时预填了就得原样带回去：丢掉等于请求重新分配一批新的端口。
        // ClusterIP 不允许带 nodePort，所以只在需要它的类型上保留。
        const nodePort =
          d.serviceType === 'NodePort' || d.serviceType === 'LoadBalancer'
            ? intOrNull(p.nodePort)
            : undefined
        return {
          ...(p.name.trim() && { name: p.name.trim() }),
          port,
          targetPort,
          protocol: p.protocol,
          ...(nodePort !== undefined && { nodePort }),
        }
      })
      .filter(Boolean)
    if (ports.length > 0) spec.ports = ports
  }

  return yaml.dump(
    { apiVersion: 'v1', kind: 'Service', metadata, spec },
    { indent: 2, noRefs: true }
  )
}

/**
 * 把表单（或手改的 YAML）算出来的 spec 叠到线上对象上，供编辑模式 PUT。
 *
 * 表单只拥有 type / selector / sessionAffinity / ports / externalName 这几个字段，
 * 其余（clusterIP(s)、ipFamilies、ipFamilyPolicy、externalTrafficPolicy、
 * healthCheckNodePort…）一律从线上对象带过去：其中 clusterIP 这些是**不可变字段**，
 * 丢掉会被 API 以 `field is immutable` 拒绝；另一些只是表单没有建模。
 * metadata 同理 —— 只覆盖表单给的那部分，标签/注解不会被清掉。
 *
 * 反过来，表单拥有的字段以表单为准，包括「清空」：选择器被删空就得真的删掉，
 * 不能像工作负载那样只做覆盖合并，否则选择器永远删不掉。
 */
export function mergeServiceUpdate(
  generated: Record<string, unknown>,
  existing: Service
): Service {
  const generatedSpec = (generated.spec || {}) as Record<string, unknown>
  const spec: Record<string, unknown> = {
    ...existing.spec,
    ...generatedSpec,
  }

  // 这几个字段的「没填」就是「不要」，不能留着线上对象里的旧值。
  for (const key of ['selector', 'sessionAffinity', 'externalName']) {
    if (generatedSpec[key] === undefined) {
      delete spec[key]
    }
  }

  return {
    ...existing,
    metadata: {
      ...existing.metadata,
      ...((generated.metadata || {}) as Record<string, unknown>),
    },
    spec,
  } as Service
}
