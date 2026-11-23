import { clsx, type ClassValue } from 'clsx'
import { format, formatDistance } from 'date-fns'
import { TFunction } from 'i18next'
import { NodeCondition } from 'kubernetes-types/core/v1'
import { twMerge } from 'tailwind-merge'

import { PodMetrics } from '@/types/api'
import { NodeConditionType } from '@/types/k8s'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// 面向字符串输入处理器的简易防抖函数，支持取消
export function debounce(fn: (value: string) => void, delay: number) {
  let timeout: NodeJS.Timeout | null = null

  const debouncedFn = function (value: string) {
    if (timeout) {
      clearTimeout(timeout)
    }
    timeout = setTimeout(() => {
      fn(value)
    }, delay)
  }

  debouncedFn.cancel = function () {
    if (timeout) {
      clearTimeout(timeout)
      timeout = null
    }
  }

  return debouncedFn
}

export function getAge(timestamp: string): string {
  const target = new Date(timestamp)
  const now = new Date()
  const diffMs = now.getTime() - target.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  const diffHours = Math.floor(
    (diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)
  )
  const diffMinutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60))
  const diffSeconds = Math.floor((diffMs % (1000 * 60)) / 1000)

  if (diffDays > 0) {
    return `${diffDays}d`
  } else if (diffHours > 0) {
    return `${diffHours}h`
  } else if (diffMinutes > 0) {
    return `${diffMinutes}m`
  } else {
    return `${diffSeconds}s`
  }
}

/**
 * 与 getAge 同口径，但单位走 i18n（中文「297天」、英文「297d」）。
 * 列表页的「存活时间」列用它，避免中文界面里混进 `d`/`h` 后缀。
 */
export function formatAge(timestamp: string, t: TFunction): string {
  const diffMs = Date.now() - new Date(timestamp).getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  const diffHours = Math.floor(
    (diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)
  )
  const diffMinutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60))
  const diffSeconds = Math.floor((diffMs % (1000 * 60)) / 1000)

  if (diffDays > 0) {
    return `${diffDays}${t('common.units.days')}`
  } else if (diffHours > 0) {
    return `${diffHours}${t('common.units.hours')}`
  } else if (diffMinutes > 0) {
    return `${diffMinutes}${t('common.units.minutes')}`
  } else {
    return `${diffSeconds}${t('common.units.seconds')}`
  }
}

export function isVersionAtLeast(version: string | undefined, target: string) {
  const parsed = parseVersion(version)
  const targetParsed = parseVersion(target)
  if (!parsed || !targetParsed) {
    return false
  }
  for (let i = 0; i < 3; i += 1) {
    if (parsed[i] > targetParsed[i]) {
      return true
    }
    if (parsed[i] < targetParsed[i]) {
      return false
    }
  }
  return true
}

function parseVersion(version: string | undefined) {
  if (!version) {
    return null
  }
  const cleaned = version.trim().replace(/^v/, '')
  const match = cleaned.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!match) {
    return null
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function formatDate(timestamp: string, addTo = false): string {
  const date = new Date(timestamp)
  const s = format(date, 'yyyy-MM-dd HH:mm:ss')
  return addTo ? `${s} (${formatDistance(new Date(), date)})` : s
}

export function formatChartXTicks(
  timestamp: string,
  isSameDay: boolean
): string {
  const options: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }
  if (!isSameDay) {
    options.year = 'numeric'
    options.month = '2-digit'
    options.day = '2-digit'
  }
  return new Date(timestamp).toLocaleString(undefined, options)
}

// 把字节数格式化为易读形式
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'

  const k = 1024
  const sizes = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

export function parseBytes(capacity: string): number {
  const units: { [key: string]: number } = {
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    Pi: 1024 ** 5,
    Ei: 1024 ** 6,
  }

  const match = capacity.match(/^(\d+)([KMGTP]i)?$/)
  if (match) {
    const value = parseInt(match[1], 10)
    const unit = match[2]
    return unit ? value * units[unit] : value
  }
  return parseInt(capacity, 10)
}

// 格式化 CPU 核数
export function formatCPU(cores: string | number): string {
  if (typeof cores === 'string') {
    if (cores.endsWith('m')) {
      const milliCores = parseInt(cores.slice(0, -1))
      return `${(milliCores / 1000).toFixed(3)} cores`
    }
    return `${cores} cores`
  }
  return `${cores} cores`
}

// 格式化内存
export function formatMemory(memory: string | number): string {
  if (typeof memory === 'number') {
    return formatBytes(memory)
  }

  const units = {
    Ki: 1024,
    Mi: 1024 * 1024,
    Gi: 1024 * 1024 * 1024,
    Ti: 1024 * 1024 * 1024 * 1024,
    K: 1000,
    M: 1000 * 1000,
    G: 1000 * 1000 * 1000,
    T: 1000 * 1000 * 1000 * 1000,
  }

  for (const [suffix, multiplier] of Object.entries(units)) {
    if (memory.endsWith(suffix)) {
      const value = parseFloat(memory.slice(0, -suffix.length))
      return formatBytes(value * multiplier)
    }
  }

  // 没有单位时按字节处理
  const numValue = parseFloat(memory)
  if (!isNaN(numValue)) {
    return formatBytes(numValue)
  }

  return memory
}

/** 毫核 → 「0.2 核」这种习惯写法（整数不留小数）。 */
export function formatCores(milli: number): string {
  const cores = milli / 1000
  return `${Number.isInteger(cores) ? cores : cores.toFixed(1)} 核`
}

export function formatPodMetrics(metric: PodMetrics): {
  cpu: number
  memory: number
} {
  let cpu = 0
  let memory = 0
  metric.containers.forEach((container) => {
    const cpuUsage = parseInt(container.usage.cpu, 10) || 0
    if (container.usage.cpu.endsWith('n')) {
      cpu += cpuUsage / 1e9 // nanocores to millicores
    } else if (container.usage.cpu.endsWith('m')) {
      cpu += cpuUsage
    }
    const memoryUsage = parseInt(container.usage.memory, 10) || 0
    if (container.usage.memory.endsWith('Ki')) {
      memory += memoryUsage * 1024
    } else if (container.usage.memory.endsWith('Mi')) {
      memory += memoryUsage * 1024 * 1024
    } else if (container.usage.memory.endsWith('Gi')) {
      memory += memoryUsage * 1024 * 1024 * 1024
    }
  })

  return { cpu, memory }
}
export interface RBACErrorInfo {
  user: string
  verb: string
  resource: string
  namespace?: string
  cluster: string
}

export function parseRBACError(errorMessage: string): RBACErrorInfo | null {
  const namespacePattern =
    /user (.+) does not have permission to (.+) (.+) in namespace (.+) on cluster (.+)/
  const namespaceMatch = errorMessage.match(namespacePattern)

  if (namespaceMatch) {
    return {
      user: namespaceMatch[1],
      verb: namespaceMatch[2],
      resource: namespaceMatch[3],
      namespace: namespaceMatch[4],
      cluster: namespaceMatch[5],
    }
  }

  return null
}

export function isRBACError(errorMessage: string): boolean {
  return !!parseRBACError(errorMessage)
}

const CRD_NOT_INSTALLED_RE =
  /no matches for kind "([^"]+)" in version "([^"]+)"/

export function isCRDNotInstalledError(errorMessage: string): boolean {
  return CRD_NOT_INSTALLED_RE.test(errorMessage)
}

export function translateError(error: Error | unknown, t: TFunction): string {
  if (!(error instanceof Error)) {
    return t('common.messages.error', {
      error: String(error),
    })
  }

  // 后端的密码策略失败会带一个机器可读的错误码（以及
  // 最小长度之类的参数），以便做本地化。
  const policyError = error as {
    code?: string
    params?: Record<string, unknown>
  }
  if (policyError.code?.startsWith('password_')) {
    return t(`passwordPolicy.errors.${policyError.code}`, {
      ...policyError.params,
      defaultValue: error.message,
    })
  }
  // 资源级变更历史：sink≠database 时后端明确回 501 + code（审计记录没落库，YAML 对比做不了），
  // 按码本地化成「为什么不可用」，而不是把裸英文报错丢给用户。
  if (policyError.code === 'resource_history_requires_database_sink') {
    return t(`resourceHistory.errors.${policyError.code}`, {
      defaultValue: error.message,
    })
  }
  // 登录类错误（凭据错误 / 尝试次数超限 / IP 拒绝等）同样按码本地化。
  if (policyError.code?.startsWith('login_')) {
    return t(`login.errors.${policyError.code}`, {
      defaultValue: error.message,
    })
  }
  // 容器文件浏览/下载/上传的错误同样按码本地化（缺 ls 命令、路径非法等）。
  if (policyError.code?.startsWith('pod_files_')) {
    return t(`podFiles.errors.${policyError.code}`, {
      ...policyError.params,
      defaultValue: error.message,
    })
  }
  // 头像上传：服务端的 avatar_*（类型/大小/尺寸/损坏）与浏览器侧的
  // avatar_client_*（解不出图、编码失败）走同一套文案，见 lib/avatar-upload.ts。
  if (policyError.code?.startsWith('avatar_')) {
    const params = { ...(policyError.params ?? {}) }
    // limit 是字节数，直接显示 1048576 没人看得懂。
    if (typeof params.limit === 'number') {
      params.limit = formatBytes(params.limit)
    }
    return t(`avatarUpload.errors.${policyError.code}`, {
      ...params,
      defaultValue: error.message,
    })
  }
  // 集群徽章图标：服务端的 cluster_icon_*（类型/大小/尺寸/损坏）与浏览器侧的
  // cluster_icon_client_*（解不出图、编码失败）共用同一套文案，
  // 见 lib/cluster-icon-upload.ts 与 locales 里的 clusterBadge.errors.*。
  if (policyError.code?.startsWith('cluster_icon_')) {
    const params = { ...(policyError.params ?? {}) }
    if (typeof params.limit === 'number') {
      params.limit = formatBytes(params.limit)
    }
    return t(`clusterBadge.errors.${policyError.code}`, {
      ...params,
      defaultValue: error.message,
    })
  }

  // K8s 乐观并发冲突（两个人先后提交同一个对象）：服务端只给那句又长又英文的
  // `the object has been modified…`，用户看不出自己该做什么，按码换成可执行的提示。
  if (policyError.code === 'resource_version_conflict') {
    return t('errors.resourceVersionConflict', {
      defaultValue: '对象已被他人修改，请刷新后重试',
    })
  }

  // 模板 YAML 解析失败（服务端 pkg/templates 写入时拦住）：yaml.v3 的原文又长又是英文，
  // 按码换成能说清「哪一段读不懂」的提示，细节留给用户定位行列。
  if (policyError.code === 'invalid_template_yaml') {
    return t('errors.invalidTemplateYAML', {
      detail: error.message,
    })
  }

  // 权限拒绝（全局搜索等接口）：服务端原先只回一句英文 `Access denied`，
  // 中文界面直接贴上去让人不知道下一步找谁（第 18 轮 D-146）。
  if (policyError.code === 'access_denied') {
    return t('errors.accessDenied')
  }

  // 动态码错误：这三个接口以前返回开发者英文串，账户页直接贴到中文界面上
  // （第 20 轮 D-163）。登录接口早就用了 `invalid_mfa_code`，这里与它口径一致。
  if (policyError.code === 'invalid_mfa_code') {
    return t('errors.invalidMfaCode')
  }

  if (policyError.code === 'mfa_code_required') {
    return t('errors.mfaCodeRequired')
  }

  // 请求体超过 apiserver 接收上限（实测约 3 MiB）：以前是 500，界面上就成了
  // 「服务器错误」，用户会反复重试大文件（第 21 轮 D-164）。
  if (policyError.code === 'request_entity_too_large') {
    return t('errors.requestEntityTooLarge')
  }

  const crdMatch = CRD_NOT_INSTALLED_RE.exec(error.message)
  if (crdMatch) {
    return t('errors.crdNotInstalled', {
      kind: crdMatch[1],
      version: crdMatch[2],
    })
  }

  const rbacInfo = parseRBACError(error.message)

  if (!rbacInfo) {
    return error.message
  }

  if (rbacInfo.namespace) {
    return t('rbac.noPermissionNamespace', {
      user: rbacInfo.user,
      verb: t(`rbac.verb.${rbacInfo.verb}`, {
        defaultValue: rbacInfo.verb,
      }),
      resource: t(`nav.${rbacInfo.resource}`, {
        defaultValue: rbacInfo.resource,
      }),
      namespace: rbacInfo.namespace === 'All' ? 'All' : rbacInfo.namespace,
      cluster: rbacInfo.cluster,
    })
  }

  return error.message
}

/**
 * 为节点状态补充计算出的健康状态
 *
 * 增加一个语义统一的 `health` 字段：
 * - `True` = 健康状态
 * - `False` = 不健康状态
 */
export function enrichNodeConditionsWithHealth(data: NodeCondition[]) {
  return data.map((item) => {
    const shouldReverseStatus = (
      [
        'DiskPressure',
        'MemoryPressure',
        'PIDPressure',
        'NetworkUnavailable',
      ] as NodeConditionType[]
    ).includes(item.type as NodeConditionType)

    return {
      ...item,
      health: shouldReverseStatus
        ? item.status === 'True'
          ? 'False'
          : item.status === 'False'
            ? 'True'
            : item.status
        : item.status,
    }
  })
}
