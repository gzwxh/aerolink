import { apiClient } from '../api-client'

export interface PaginatedResult<T> {
  items: T
  pagination: {
    hasNextPage: boolean
    nextContinueToken?: string
    remainingItems?: number
  }
}

// 带错误处理的通用 fetch 函数
export async function fetchAPI<T>(endpoint: string): Promise<T> {
  try {
    return await apiClient.get<T>(`${endpoint}`)
  } catch (error: unknown) {
    console.error('API request failed:', error)
    throw error
  }
}

/** 下载结果：文件名、条目数与内容指纹（指纹由后端在响应头里给出）。 */
export interface DownloadResult {
  filename: string
  rowCount?: number
  timeRange?: string
  sha256?: string
  hmac?: string
}

/**
 * 下载后端生成的附件（如审计日志导出的 CSV）并交给浏览器保存。
 *
 * 同时把后端给出的条目数与内容指纹回传给调用方，方便界面提示「导出了多少条」以及
 * 让用户把指纹留档（离线核对时对文件执行 `sha256sum` 应与它一致）。
 */
export async function downloadFile(
  endpoint: string,
  fallbackName: string
): Promise<DownloadResult> {
  const {
    blob,
    filename: serverName,
    rowCount,
    timeRange,
    sha256,
    hmac,
  } = await apiClient.download(endpoint)
  const filename =
    serverName && serverName !== 'download' ? serverName : fallbackName

  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)

  return { filename, rowCount, timeRange, sha256, hmac }
}
