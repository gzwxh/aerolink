// 配额 used/hard 的解析、格式化与使用率着色。
//
// ResourceQuota 的 spec.hard / status.used 都是 K8s 资源量字符串（"128Gi"、
// "2000m"、裸数字…），三种数据库/清单来源写法并不统一，比较之前先归一到
// 统一单位：CPU 用核（cores），内存用 Mi。展示时再压回紧凑写法，避免详情页
// 出现 "17179869184 bytes" 这种没法扫读的数字。

/** K8s CPU 量 → 核数：'2000m' → 2，'2' → 2。 */
export function parseCpuCores(value: unknown): number {
  if (typeof value !== 'string' || !value) return 0
  if (value.endsWith('m')) return parseFloat(value) / 1000
  const n = parseFloat(value)
  return Number.isNaN(n) ? 0 : n
}

/** K8s 内存量 → Mi：'128Gi' → 131072，'512Mi' → 512，裸字节 → Mi。 */
export function parseMemoryMi(value: unknown): number {
  if (typeof value !== 'string' || !value) return 0
  const num = parseFloat(value)
  if (Number.isNaN(num)) return 0
  if (value.endsWith('Ki')) return num / 1024
  if (value.endsWith('Mi')) return num
  if (value.endsWith('Gi')) return num * 1024
  if (value.endsWith('Ti')) return num * 1024 * 1024
  return num / (1024 * 1024)
}

/** 核数 → 紧凑写法：0.5 → '500m'，2 → '2'。 */
export function formatCpuShort(cores: number): string {
  if (cores <= 0) return '0'
  if (cores < 1) return `${Math.round(cores * 1000)}m`
  return cores.toFixed(cores % 1 === 0 ? 0 : 1)
}

/** Mi → 紧凑写法：16384 → '16Gi'，512 → '512Mi'。 */
export function formatMemoryShort(mi: number): string {
  if (mi <= 0) return '0'
  if (mi >= 1024) return `${(mi / 1024).toFixed(1).replace(/\.0$/, '')}Gi`
  return `${Math.round(mi)}Mi`
}

/** used/hard 的使用率（百分数，四舍五入）；hard 为 0 时按 0 处理。 */
export function quotaUsagePercent(used: number, hard: number): number {
  if (hard <= 0) return 0
  return Math.round((used / hard) * 100)
}

/** 进度条颜色：≥90% 红（destructive），≥70% 黄（warning），其余绿（success）。 */
export function quotaBarColor(pct: number): string {
  if (pct >= 90) return 'bg-destructive'
  if (pct >= 70) return 'bg-warning'
  return 'bg-success'
}

/** 百分比文字颜色，阈值与 quotaBarColor 一致。 */
export function quotaTextColor(pct: number): string {
  if (pct >= 90) return 'text-destructive'
  if (pct >= 70) return 'text-warning'
  return 'text-success'
}

export interface PodQuotaConsumption {
  name: string
  cpuRequest: number
  memoryRequest: number
}

interface PodLike {
  metadata?: { name?: string }
  spec?: {
    containers?: Array<{
      resources?: {
        requests?: { cpu?: string; memory?: string }
      }
    }>
  }
}

/**
 * 逐个 Pod 汇总 container[].resources.requests 的 CPU/内存。
 *
 * 只统计 requests：配额记账与调度都以 requests 为准（ResourceQuota 的
 * requests.cpu / requests.memory 也是按它算的）。未声明 requests 的容器按 0 计。
 */
export function getPodConsumptions(pods: PodLike[]): PodQuotaConsumption[] {
  return pods.map((pod) => {
    let cpu = 0
    let mem = 0
    for (const container of pod.spec?.containers || []) {
      cpu += parseCpuCores(container.resources?.requests?.cpu)
      mem += parseMemoryMi(container.resources?.requests?.memory)
    }
    return {
      name: pod.metadata?.name || '',
      cpuRequest: cpu,
      memoryRequest: mem,
    }
  })
}
