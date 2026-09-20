import { useState } from 'react'
import { IconCopy, IconEye, IconEyeOff, IconPencil } from '@tabler/icons-react'
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { copyToClipboard } from '@/lib/clipboard'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { KVEditor, type KVPair } from '@/components/kv-editor'

interface Props {
  /** 要展示的键值条目 */
  entries: Record<string, string>
  /** 为 true 时值默认打码，可按 key 逐个显示 */
  sensitive?: boolean
  /** 为 true 时值是 base64 编码的，展示时会解码 */
  base64Encoded?: boolean
  /** 覆盖空数据时展示的"暂无条目"文案 */
  emptyMessage?: string
  /** 传 false 时隐藏编辑入口（例如当前用户没有 update 权限） */
  canEdit?: boolean
  /**
   * 传入后显示「编辑」入口。保存时回传编辑结果，值的形态与展示一致
   * （`base64Encoded` 为 true 时是解码后的明文）；编码/写回由调用方负责。
   */
  onSave?: (entries: Record<string, string>) => Promise<void> | void
}

function decode(value: string) {
  try {
    return atob(value)
  } catch {
    return value
  }
}

export function KeyValueDataViewer({
  entries,
  sensitive = false,
  base64Encoded = false,
  emptyMessage,
  canEdit = true,
  onSave,
}: Props) {
  const { t } = useTranslation()
  const keys = Object.keys(entries)
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState(false)
  const [pairs, setPairs] = useState<KVPair[]>([])
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState('')

  const editable = Boolean(onSave) && canEdit

  const toPairs = (): KVPair[] =>
    Object.entries(entries).map(([key, rawValue]) => ({
      key,
      value: base64Encoded ? decode(rawValue) : rawValue,
    }))

  const startEditing = () => {
    setPairs(toPairs())
    setEditError('')
    setEditing(true)
  }

  const cancelEditing = () => {
    setEditing(false)
    setEditError('')
  }

  const handleSave = async () => {
    // 键必须非空且唯一：写回资源时重复键会静默丢数据。
    const next: Record<string, string> = {}
    for (const pair of pairs) {
      const key = pair.key.trim()
      if (!key) {
        setEditError(t('keyValueDataViewer.invalidKey', '键不能为空'))
        return
      }
      if (Object.prototype.hasOwnProperty.call(next, key)) {
        setEditError(
          t('keyValueDataViewer.duplicateKey', {
            key,
            defaultValue: '键 {{key}} 重复',
          })
        )
        return
      }
      next[key] = pair.value
    }

    setSaving(true)
    setEditError('')
    try {
      await onSave?.(next)
      setEditing(false)
    } catch (err) {
      setEditError(
        err instanceof Error
          ? err.message
          : t('keyValueDataViewer.saveFailed', '保存失败')
      )
    } finally {
      setSaving(false)
    }
  }

  const toggleKey = (key: string) =>
    setRevealedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })

  const toggleAll = () => {
    const allRevealed =
      keys.length > 0 && keys.every((k) => revealedKeys.has(k))
    setRevealedKeys(allRevealed ? new Set() : new Set(keys))
  }

  const copyValue = async (value: string) => {
    if (await copyToClipboard(value)) {
      toast.success(t('common.messages.copied', '已复制到剪贴板'))
    } else {
      toast.error(
        t('common.messages.copyFailed', '复制失败，请手动选择文本后复制')
      )
    }
  }

  if (editing) {
    return (
      <div className="space-y-3">
        <KVEditor
          title={t('keyValueDataViewer.editTitle', '编辑条目')}
          hint={t(
            'keyValueDataViewer.editHint',
            '可修改、新增或删除条目；保存后写回该资源。'
          )}
          pairs={pairs}
          addLabel={t('keyValueDataViewer.addEntry', '新增条目')}
          // Secret / ConfigMap 的值常是多行文本（证书、token、配置文件），
          // 这里用可纵向拖拽缩放的多行文本域，避免长值看不全。
          multiline
          onChange={setPairs}
        />
        {editError && (
          <Alert variant="destructive">
            <AlertDescription>{editError}</AlertDescription>
          </Alert>
        )}
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={cancelEditing}
            disabled={saving}
          >
            {t('common.actions.cancel', '取消')}
          </Button>
          <Button type="button" onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('common.actions.save', '保存')}
          </Button>
        </div>
      </div>
    )
  }

  if (keys.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {emptyMessage ?? t('keyValueDataViewer.noEntries', '暂无条目')}
        </p>
        {editable && (
          <Button variant="outline" size="sm" onClick={startEditing}>
            <IconPencil className="mr-1 h-4 w-4" />
            {t('keyValueDataViewer.edit', '编辑')}
          </Button>
        )}
      </div>
    )
  }

  const allRevealed = keys.every((k) => revealedKeys.has(k))

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-muted-foreground">
          {t('keyValueDataViewer.entryCount', {
            total: keys.length,
            defaultValue: '{{total}} 个条目',
          })}
        </span>
        <div className="flex items-center gap-2">
          {sensitive && (
            <Button variant="outline" size="sm" onClick={toggleAll}>
              {allRevealed ? (
                <>
                  <IconEyeOff className="mr-1 h-4 w-4" />
                  {t('keyValueDataViewer.hideAll', '隐藏全部')}
                </>
              ) : (
                <>
                  <IconEye className="mr-1 h-4 w-4" />
                  {t('keyValueDataViewer.revealAll', '显示全部')}
                </>
              )}
            </Button>
          )}
          {editable && (
            <Button variant="outline" size="sm" onClick={startEditing}>
              <IconPencil className="mr-1 h-4 w-4" />
              {t('keyValueDataViewer.edit', '编辑')}
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-2">
        {Object.entries(entries).map(([key, rawValue]) => {
          const displayValue = base64Encoded ? decode(rawValue) : rawValue
          const revealed = !sensitive || revealedKeys.has(key)

          return (
            <div key={key} className="rounded-lg border p-3">
              <div className="mb-1 flex items-center justify-between">
                <span className="font-mono text-sm font-medium">{key}</span>
                <div className="flex items-center gap-1">
                  {sensitive && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      onClick={() => toggleKey(key)}
                      title={t(
                        revealed
                          ? 'common.actions.hide'
                          : 'common.actions.show',
                        revealed ? '隐藏' : '显示'
                      )}
                    >
                      {revealed ? (
                        <IconEyeOff className="h-4 w-4" />
                      ) : (
                        <IconEye className="h-4 w-4" />
                      )}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => void copyValue(displayValue)}
                    title={t('common.actions.copy', '复制')}
                  >
                    <IconCopy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="bg-muted rounded px-3 py-2 font-mono text-xs break-all">
                {revealed ? (
                  <span className="whitespace-pre-wrap">{displayValue}</span>
                ) : (
                  // 打码时不把明文渲染进 DOM，避免「视觉遮住、源码可读」。
                  <span className="select-none text-muted-foreground">***</span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
