// 带认证支持的 API 客户端
import { appendCurrentClusterHeader } from './current-cluster'
import { requestMFAVerification } from './mfa-prompt'
import { notifySessionSuperseded } from './session-events'
import { withSubPath } from './subpath'

export interface ApiRequestOptions extends RequestInit {
  retryOnUnauthorized?: boolean
}

/**
 * 会话失效后跳转登录页。必须防重入：登录页 mount 时仍会发起认证请求
 * （checkAuth / bootstrap），若每次 401 都整页跳转 /login，就会形成
 * "跳转 → 登录页请求 401 → 再跳转" 的无限刷新循环（典型场景：后端重启
 * 后旧的会话 Cookie 全部失效）。已在登录页时不再跳转，让登录表单正常
 * 渲染给用户。
 */
let redirectingToLogin = false

export function redirectToLogin() {
  if (redirectingToLogin) return
  if (window.location.pathname.endsWith('/login')) return
  redirectingToLogin = true
  window.location.href = withSubPath('/login')
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

    appendCurrentClusterHeader(headers)

    const defaultOptions: RequestInit = {
      credentials: 'include',
      headers,
      ...options,
    }

    try {
      let response = await fetch(fullUrl, defaultOptions)

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
            response = await fetch(fullUrl, defaultOptions)
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
          response = await fetch(fullUrl, defaultOptions)
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

// 从 `attachment; filename="kite-audit-logs-20260101-120000.csv"` 里取出文件名。
function filenameFromDisposition(header: string | null): string {
  if (!header) return 'download'
  const match = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(header)
  const name = match?.[1]?.trim()
  return name ? decodeURIComponent(name) : 'download'
}

// 创建单例实例
export const apiClient = new ApiClient(API_BASE_URL)
export const authApiClient = new ApiClient('/api')
