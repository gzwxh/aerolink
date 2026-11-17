/**
 * 表格数据导出：CSV / JSON 的序列化与浏览器下载。
 *
 * 两种格式用的是同一份「表格数据」（列标题 + 每行取值），导出哪些列/行由
 * 调用方（ResourceTable）决定，这里只管格式与落盘。
 */

/** 支持的导出格式。 */
export type TableExportFormat = 'csv' | 'json'

/** 默认提供的格式（顺序即菜单顺序）。 */
export const DEFAULT_TABLE_EXPORT_FORMATS: TableExportFormat[] = ['csv', 'json']

/**
 * 列定义 meta 里的 CSV 字段，`T` 为表格的数据类型。
 *
 * - accessor 列默认导出 accessor 值，不需要它；
 * - 访问器存原始数字、界面上展示格式化文本的列（如 CPU / 内存）用它覆盖；
 * - display 列没有 accessor，只有提供它之后才会进入导出。
 */
export interface CsvColumnMeta<T = unknown> {
  csvValue?: (row: T) => unknown
}

/**
 * CSV 额外列：不渲染在表格里，只在导出时追加到末尾。用于携带行数据中
 * 没有、但需要与行联动的信息（例如命名空间对应的权限绑定组）。
 */
export interface CsvExportColumn<T = unknown> {
  header: string
  value: (row: T) => unknown
}

function toCellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(toCellText).join('; ')
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

/** 按 RFC 4180 转义：含逗号、引号或换行的值用双引号包裹，内部引号翻倍。 */
export function escapeCsvCell(value: unknown): string {
  const text = toCellText(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 生成 CSV 文本（CRLF 行尾，Excel 兼容）。 */
export function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows]
    .map((row) => row.map(escapeCsvCell).join(','))
    .join('\r\n')
}

/** 把表格数据转成对象数组，key 为列标题。 */
export function rowsToObjects(
  headers: string[],
  rows: unknown[][]
): Record<string, unknown>[] {
  return rows.map((row) =>
    Object.fromEntries(headers.map((header, index) => [header, row[index]]))
  )
}

function withExtension(fileName: string, ext: string): string {
  return fileName.endsWith(`.${ext}`) ? fileName : `${fileName}.${ext}`
}

/**
 * 触发浏览器下载纯文本文件。`withBom` 只给 CSV 用：Excel 双击打开时按
 * UTF-8 解析，否则中文会显示成乱码；JSON 带 BOM 反而会让解析器报错。
 */
function downloadText(
  fileName: string,
  content: string,
  mime: string,
  withBom = false
) {
  const blob = new Blob([withBom ? `\ufeff${content}` : content], {
    type: `${mime};charset=utf-8`,
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}

export function downloadCsv(
  fileName: string,
  headers: string[],
  rows: unknown[][]
) {
  downloadText(
    withExtension(fileName, 'csv'),
    toCsv(headers, rows),
    'text/csv',
    true
  )
}

/** 与 CSV 同源的表格数据，按列标题转成对象数组。 */
export function downloadJson(
  fileName: string,
  headers: string[],
  rows: unknown[][]
) {
  downloadText(
    withExtension(fileName, 'json'),
    JSON.stringify(rowsToObjects(headers, rows), null, 2),
    'application/json'
  )
}
