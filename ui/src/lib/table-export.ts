/**
 * 表格数据导出：CSV / JSON / YAML 的序列化与浏览器下载。
 *
 * 导出哪些列/行由调用方（ResourceTable）决定，这里只管格式与落盘。
 */
import * as yaml from 'js-yaml'

/** 支持的导出格式。 */
export type TableExportFormat = 'csv' | 'json' | 'yaml'

/** 默认提供的格式（顺序即菜单顺序）。 */
export const DEFAULT_TABLE_EXPORT_FORMATS: TableExportFormat[] = [
  'csv',
  'json',
  'yaml',
]

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

/** 表格内容（按列取值）。 */
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

/** 原始对象数组，格式化 2 空格缩进。 */
export function downloadJson(fileName: string, objects: unknown[]) {
  downloadText(
    withExtension(fileName, 'json'),
    JSON.stringify(objects, null, 2),
    'application/json'
  )
}

/** 多文档 YAML：每个对象一个清单，可直接 `kubectl apply -f`。 */
export function downloadYaml(fileName: string, objects: unknown[]) {
  downloadText(
    withExtension(fileName, 'yaml'),
    objects
      .map((object) => yaml.dump(object, { indent: 2, noRefs: true }))
      .join('---\n'),
    'application/x-yaml'
  )
}
