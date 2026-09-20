/* eslint-disable react-refresh/only-export-components */
import { Plus, Upload } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/password-input'

/** 创建表单中的一行键/值（或键/文件）。 */
export interface DataRow {
  key: string
  /** 纯文本值，或者二进制标签页的 base64 载荷。 */
  value: string
  /** 源文件名，仅二进制标签页使用。 */
  fileName?: string
}

export const readAsText = (file: File) => file.text()

/**
 * 把文件读成裸 base64（不带 `data:` URL 前缀），因为这是
 * API Server 在 ConfigMap.binaryData / Secret.data 中期望的格式。
 */
export const readAsBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })

/** 保留每个非空 key 的最后一个值，并丢弃空行。 */
export function toRecord(rows: DataRow[]) {
  const record: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (key) record[key] = row.value
  }
  return record
}

/** data、binary、labels 与 annotations 表单共用的键/值行编辑器。 */
export function ValueRows({
  rows,
  mode,
  keyPlaceholder,
  valuePlaceholder,
  chooseFileLabel,
  binaryLoadedLabel,
  removeLabel,
  maskValues = false,
  onKeyChange,
  onValueChange,
  onRemove,
  onPickFile,
}: {
  rows: DataRow[]
  mode: 'text' | 'binary'
  keyPlaceholder: string
  valuePlaceholder: string
  chooseFileLabel: string
  binaryLoadedLabel: string
  removeLabel: string
  /** 值默认隐藏、每行一个「显示/隐藏」切换（用于 Secret 这类敏感值）。 */
  maskValues?: boolean
  onKeyChange: (index: number, key: string) => void
  onValueChange: (index: number, value: string) => void
  onRemove: (index: number) => void
  onPickFile: (index: number) => void
}) {
  return (
    <div className="space-y-2">
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-3">
          <Input
            value={row.key}
            onChange={(e) => onKeyChange(index, e.target.value)}
            placeholder={keyPlaceholder}
            className="h-9 min-w-0 flex-1"
          />
          {mode === 'binary' ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 min-w-0 flex-1 justify-start font-normal"
              onClick={() => onPickFile(index)}
            >
              <Upload className="mr-2 h-3.5 w-3.5 shrink-0" />
              <span className="truncate">
                {row.fileName ||
                  (row.value ? binaryLoadedLabel : chooseFileLabel)}
              </span>
            </Button>
          ) : maskValues ? (
            // 敏感值：默认隐藏，点眼睛临时显示（PasswordInput 自带切换）。
            <div className="min-w-0 flex-1">
              <PasswordInput
                value={row.value}
                onChange={(e) => onValueChange(index, e.target.value)}
                placeholder={valuePlaceholder}
                autoComplete="new-password"
                className="h-9"
              />
            </div>
          ) : (
            <Input
              value={row.value}
              onChange={(e) => onValueChange(index, e.target.value)}
              placeholder={valuePlaceholder}
              className="h-9 min-w-0 flex-1"
            />
          )}
          <button
            type="button"
            className="shrink-0 text-sm text-primary transition-colors hover:underline"
            onClick={() => onRemove(index)}
          >
            {removeLabel}
          </button>
        </div>
      ))}
    </div>
  )
}

/** 每个键/值分区共用的控制台风格"添加"按钮。 */
export function AddButton({
  label,
  onClick,
}: {
  label: string
  onClick: () => void
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-8 border-primary/40 bg-primary/5 text-xs text-primary hover:bg-primary/10 hover:text-primary"
      onClick={onClick}
    >
      <Plus className="mr-1 h-3.5 w-3.5" />
      {label}
    </Button>
  )
}
