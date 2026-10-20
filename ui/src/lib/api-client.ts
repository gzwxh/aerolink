// 带认证支持的 API 客户端
import { reportClusterDataStaleness } from './cluster-data-staleness'
import { appendCurrentClusterHeader } from './current-cluster'
import { requestMFAVerification } from './mfa-prompt'
import {
  consumeLoginRedirectBudget,
  markLoginRedirectLoop,
  reportApiFailure,
  reportApiSuccess,
} from './service-status'
import { notifySessionSuperseded } from './session-events'
import { withSubPath } from './subpath'
import {
  requestWriteConfirm,
  writeConfirmFor,
  type WriteOperationKind,
} from './write-confirm'

export interface ApiRequestOptions extends RequestInit {
  retryOnUnauthorized?: boolean
  /**
   * 显式声明这次请求属于哪类写操作（见 lib/write-confirm.ts）。
   * 省略时按 method 与路径推断；只有「重启」这种与普通修改同 URL 同 method 的动作才需要标注。
   */
  operation?: WriteOperationKind
}

/**
 * 会话失效后跳转登录页。必须防重入：登录页 mount 时仍会发起认证请求
 * （checkAuth / bootstrap），若每次 401 都整页跳转 /login，就会形成
 * "跳转 → 登录页请求 401 → 再跳转" 的无限刷新循环（典型场景：后端重启
 * 后旧的会话 Cookie 全部失效）。已在登录页时不再跳转，让登录表单正常
 * 渲染给用户。
 */
let redirectingToLogin = false

export function redirectToLogin(reason?: 'session-ended'): boolean {
  if (redirectingToLogin) return false
  if (window.location.pathname.endsWith('/login')) return false
  // 跳转前先申请额度：整页跳转会重置本模块的所有模块级状态，只有 sessionStorage 记得
  // 「刚刚跳过」。超预算说明前端的「已登录」与后端的判定在打架，继续跳只会无限刷新
  // （历史事故见下方注释），此时停在原地显示阻断页。
  if (!consumeLoginRedirectBudget()) {
    markLoginRedirectLoop()
    return false
  }
  redirectingToLogin = true
  // 必须带 forced=1（登录页据此忽略「已登录就跳首页」，见 pages/login.tsx 的 forcedLogin）。
  // 不带它就会形成整页跳转循环：会话已失效（被顶下线、改密前签发、来源不在允许列表…）时
  // 受保护接口 401，但如果 bootstrap 仍认为已登录，登录页会把用户弹回首页 → 首页再 401
  // → 又跳登录页……每轮一次整页加载，实测能堆出上千个 401。
  // reason 只用于在登录页解释「为什么又让我登录」，不影响跳转判定。
  const query = reason ? `?forced=1&reason=${reason}` : '?forced=1'
  window.location.href = withSubPath(`/login${query}`)
  return true
}

/**
 * 针对非 2xx API 响应抛出的错误。它保留 HTTP 状态码与
 * 可选的机器可读 `code`，这样调用方可以针对具体失败做处理
 * （例如 409 + role_name_conflict），而不必去匹配提示文本。
 */
export class ApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly params?: Record<string, unknown>

  constructor(
    message: string,
    status: number,
    code?: string,
    params?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.params = params
  }
}

class ApiClient {
  private baseUrl: string = ''
  private isRefreshing = false
  private refreshPromise: Promise<void> | null = null

  constructor(baseUrl: string = '') {
    this.baseUrl = baseUrl
  }

  private async refreshToken(): Promise<void> {
    if (this.isRefreshing) {
      return this.refreshPromise!
    }

    this.isRefreshing = true
    this.refreshPromise = fetch(withSubPath('/api/auth/refresh'), {
      method: 'POST',
      credentials: 'include',
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error('Token refresh failed')
        }
      })
      .finally(() => {
        this.isRefreshing = false
        this.refreshPromise = null
      })

    return this.refreshPromise
  }

  async request(
    url: string,
    options: ApiRequestOptions = {}
  ): Promise<Response> {
    const fullUrl = withSubPath(this.baseUrl + url)

    const headers: Record<string, string> = {
      ...(options.headers as Record<string, string>),
    }

    // 仅在尚未设置且 body 不是 FormData 时，才把默认 Content-Type 设为 application/json
    if (!headers['Content-Type'] && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json'
    }

    // 请求发出去时用的集群名：响应到达时「当前集群」可能已经切走了，
    // 而陈旧提示要说清是哪个集群的数据过期。
    const requestCluster = appendCurrentClusterHeader(headers)

    const defaultOptions: RequestInit = {
      credentials: 'include',
      headers,
      ...options,
    }

    // k8s 写操作的二次确认（按集群逐类开关，见 lib/write-confirm.ts）。
    // 必须在真正 fetch 之前：用户取消时请求根本不该发出去。
    const writeConfirm = writeConfirmFor(
      options.method ?? 'GET',
      url,
      options.operation
    )
    if (writeConfirm && !(await requestWriteConfirm(writeConfirm))) {
      // 用 499（客户端主动放弃）+ 机器可读 code：调用方按既有错误路径收尾，
      // 界面据此给出「已取消，未提交」而不是含糊的失败。
      throw new ApiError(
        'Operation cancelled before it was sent',
        499,
        'operation_cancelled'
      )
    }

    try {
      let response = await this.fetchReportingStatus(
        fullUrl,
        defaultOptions,
        requestCluster
      )

      if (response.status === 403) {
        const payload = await response
          .clone()
          .json()
          .catch(() => null)
        if (payload?.error === 'mfa_verification_required') {
          // 敏感操作：请求验证码，然后重放该请求。
          // 后端会为这个浏览器记住这次验证。
          const verified = await requestMFAVerification()
          if (verified) {
            response = await this.fetchReportingStatus(
              fullUrl,
              defaultOptions,
              requestCluster
            )
          }
        }
      }

      if (
        response.status === 401 &&
        !window.location.pathname.endsWith('/login')
      ) {
        const payload = await response
          .clone()
          .json()
          .catch(() => null)
        if (payload?.code === 'session_superseded') {
          // 单点登录把该会话顶下线：不刷新、也不静默跳登录页，否则用户看不到任何
          // 解释；交给全局提示弹窗接管（见 lib/session-events.ts）。直接返回响应，
          // 让调用方照常拿到带 code 的 ApiError。
          notifySessionSuperseded()
          return response
        }
      }

      if (response.status === 401 && options.retryOnUnauthorized !== false) {
        try {
          await this.refreshToken()
          response = await this.fetchReportingStatus(
            fullUrl,
            defaultOptions,
            requestCluster
          )
        } catch (refreshError) {
          console.error('Token refresh failed:', refreshError)
          redirectToLogin()
          throw new Error('Authentication failed', { cause: refreshError })
        }
      }

      return response
    } catch (error) {
      console.error('API request failed:', error)
      throw error
    }
  }

  /**
   * 发请求并把结果上报给全局服务状态（见 lib/service-status.ts）。
   *
   * 网络层失败与 5xx 会计数，连续多次后界面暂停所有轮询并提示「服务不可用」；
   * 其余状态码（含 401/403）说明服务本身是活的，只清零计数——会话失效不该被
   * 报成服务故障，否则用户会看到「服务挂了」而实际只需重新登录。
   *
   * 顺带把响应头上的集群数据陈旧信号交给 lib/cluster-data-staleness.ts：
   * 集群掉线时后端仍会照常返回缓存里的对象（响应体看不出异常），
   * 只有这两个头能说明「这份数据可能已经过期」。
   */
  private async fetchReportingStatus(
    url: string,
    options: RequestInit,
    cluster: string | null = null
  ): Promise<Response> {
    let response: Response
    try {
      response = await fetch(url, options)
    } catch (error) {
      reportApiFailure('network')
      throw error
    }

    if (response.status >= 500) {
      reportApiFailure('server')
    } else {
      reportApiSuccess()
    }
    reportClusterDataStaleness(response.headers, cluster)
    return response
  }

  private async makeRequest<T>(
    url: string,
    options: ApiRequestOptions = {}
  ): Promise<T> {
    const response = await this.request(url, options)

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      const message =
        errorData.error || `HTTP error! status: ${response.status}`
      throw new ApiError(
        message,
        response.status,
        errorData.code,
        errorData.params
      )
    }

    const contentType = response.headers.get('content-type')
    if (contentType && contentType.includes('application/json')) {
      return await response.json()
    }

    return (await response.text()) as T
  }

  /**
   * 下载附件（如审计日志导出的 CSV）。列表接口返回 JSON，导出接口返回文件流，
   * 所以不能走 makeRequest：这里返回 Blob 与响应头，错误处理与 makeRequest 一致
   * （抛出错误，由调用方弹提示）。
   */
  async download(
    url: string,
    options: ApiRequestOptions = {}
  ): Promise<{
    blob: Blob
    filename: string
    rowCount?: number
    timeRange?: string
    sha256?: string
    hmac?: string
  }> {
    const response = await this.request(url, { ...options, method: 'GET' })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      const message =
        errorData.error || `HTTP error! status: ${response.status}`
      throw new ApiError(
        message,
        response.status,
        errorData.code,
        errorData.params
      )
    }

    const blob = await response.blob()
    const rowCount = response.headers.get('x-audit-row-count')
    return {
      blob,
      filename: filenameFromDisposition(
        response.headers.get('content-disposition')
      ),
      rowCount: rowCount === null ? undefined : Number.parseInt(rowCount, 10),
      // 导出的完整性指纹与覆盖范围（见 pkg/audit/export.go）：界面展示给用户留档。
      timeRange: response.headers.get('x-audit-time-range') ?? undefined,
      sha256: response.headers.get('x-audit-content-sha256') ?? undefined,
      hmac: response.headers.get('x-audit-content-hmac') ?? undefined,
    }
  }

  async get<T>(url: string, options?: ApiRequestOptions): Promise<T> {
    return this.makeRequest<T>(url, { ...options, method: 'GET' })
  }

  async post<T>(
    url: string,
    data?: unknown,
    options?: ApiRequestOptions
  ): Promise<T> {
    const isFormData = data instanceof FormData
    return this.makeRequest<T>(url, {
      ...options,
      method: 'POST',
      body: isFormData
        ? (data as BodyInit)
        : data
          ? JSON.stringify(data)
          : undefined,
    })
  }

  async put<T>(
    url: string,
    data?: unknown,
    options?: ApiRequestOptions
  ): Promise<T> {
    const isFormData = data instanceof FormData
    return this.makeRequest<T>(url, {
      ...options,
      method: 'PUT',
      body: isFormData
        ? (data as BodyInit)
        : data
          ? JSON.stringify(data)
          : undefined,
    })
  }

  async delete<T>(url: string, options?: ApiRequestOptions): Promise<T> {
    return this.makeRequest<T>(url, { ...options, method: 'DELETE' })
  }

  async patch<T>(
    url: string,
    data?: unknown,
    options?: ApiRequestOptions
  ): Promise<T> {
    const isFormData = data instanceof FormData
    return this.makeRequest<T>(url, {
      ...options,
      method: 'PATCH',
      body: isFormData
        ? (data as BodyInit)
        : data
          ? JSON.stringify(data)
          : undefined,
    })
  }
}

export const API_BASE_URL = '/api/v1'

// 从 `attachment; filename="aerolink-audit-logs-20260101-120000.csv"` 里取出文件名。
function filenameFromDisposition(header: string | null): string {
  if (!header) return 'download'
  const match = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(header)
  const name = match?.[1]?.trim()
  return name ? decodeURIComponent(name) : 'download'
}

// 创建单例实例
export const apiClient = new ApiClient(API_BASE_URL)
export const authApiClient = new ApiClient('/api')
