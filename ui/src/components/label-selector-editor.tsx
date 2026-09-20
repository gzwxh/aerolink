import { useMemo, useRef, useState } from 'react'
import { Plus, Search, Upload } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { useResources } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

export interface LabelPair {
  key: string
  value: string
}

/** 在其余匹配折叠为 "+N" 徽标之前展示的已匹配 pod 名称。 */
const MAX_VISIBLE_MATCHES = 10

const WARNING_BANNER =
  'rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400'
const MATCH_BANNER =
  'rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400'

/**
 * 从导入的文件中解析标签对：可以是 JSON 对象，或纯文本
 * `key=value` / `key: value` 行（空行与 `#` 注释会被忽略）。
 */
function parsePairsFromText(text: string): LabelPair[] {
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.entries(parsed as Record<string, unknown>)
        .filter(
          ([, value]) => typeof value === 'string' || typeof value === 'number'
        )
        .map(([key, value]) => ({ key: key.trim(), value: String(value) }))
    }
  } catch {
    // 不是 JSON，退回到按行解析的格式。
  }
  const pairs: LabelPair[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const equals = line.indexOf('=')
    const at = equals >= 0 ? equals : line.indexOf(':')
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    if (key) pairs.push({ key, value: line.slice(at + 1).trim() })
  }
  return pairs
}

/**
 * 标签键值编辑器，带控制台为选择器展示的 pod 匹配读数：
 * 它统计该命名空间中标签覆盖了每一个已填写键值对的 pod 数量，
 * 并列出这些匹配项。
 */
export function LabelSelectorEditor({
  title,
  hint,
  emptyNote,
  pairs,
  addLabel,
  namespace,
  onChange,
}: {
  title: string
  hint?: string
  /** 尚未填写任何键值对时追加的额外说明（选择器场景）。 */
  emptyNote?: string
  pairs: LabelPair[]
  addLabel: string
  namespace?: string
  onChange: (next: LabelPair[]) => void
}) {
  const { t } = useTranslation()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const {
    data: pods = [],
    isLoading,
    isError,
  } = useResources('pods', namespace, {
    limit: 1000,
    disable: !namespace,
  })

  const selector = useMemo(
    () =>
      pairs
        .filter((pair) => pair.key.trim() && pair.value.trim())
        .map(
          (pair) => [pair.key.trim(), pair.value.trim()] as [string, string]
        ),
    [pairs]
  )

  // 每个已填写的键值对都必须匹配；没有键值对时什么都匹配不上。
  const matched = useMemo(() => {
    if (isError || selector.length === 0) return []
    return pods.filter((pod) =>
      selector.every(([key, value]) => pod.metadata?.labels?.[key] === value)
    )
  }, [isError, pods, selector])

  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerSearch, setPickerSearch] = useState('')

  // 该命名空间 Pod 上已存在的、互不相同的 key=value 对，
  // 按出现频率由高到低，这样不输入也能填好选择器。
  const existingLabels = useMemo(() => {
    const counts = new Map<
      string,
      { key: string; value: string; count: number }
    >()
    for (const pod of pods) {
      for (const [key, value] of Object.entries(pod.metadata?.labels || {})) {
        const id = `${key}\u0000${value}`
        const entry = counts.get(id)
        if (entry) entry.count += 1
        else counts.set(id, { key, value, count: 1 })
      }
    }
    return [...counts.values()].sort(
      (a, b) => b.count - a.count || a.key.localeCompare(b.key)
    )
  }, [pods])

  const filteredExisting = useMemo(() => {
    const query = pickerSearch.trim().toLowerCase()
    if (!query) return existingLabels
    return existingLabels.filter(
      (label) =>
        label.key.toLowerCase().includes(query) ||
        label.value.toLowerCase().includes(query)
    )
  }, [existingLabels, pickerSearch])

  const isPairSelected = (label: LabelPair) =>
    pairs.some(
      (pair) =>
        pair.key.trim() === label.key.trim() &&
        pair.value.trim() === label.value.trim()
    )

  /** 追加一个键值对，同时去掉空白的起始行。 */
  const addPair = (label: LabelPair) => {
    const pair = { key: label.key.trim(), value: label.value.trim() }
    if (isPairSelected(pair)) return
    const next = pairs.filter((row) => row.key.trim())
    next.push(pair)
    onChange(next)
  }

  const handleImport = async (files: FileList | null) => {
    const file = files?.[0]
    if (!file) return
    try {
      const imported = parsePairsFromText(await file.text())
      if (imported.length === 0) {
        toast.error(
          t(
            'labelMatch.invalidFile',
            'Could not read any key/value pair from the file.'
          )
        )
        return
      }
      // 按键合并：导入的键值对会替换同 key 的行，
      // 并去掉空白的起始行。
      const merged = pairs.filter((pair) => pair.key.trim())
      for (const pair of imported) {
        const existing = merged.findIndex(
          (candidate) => candidate.key === pair.key
        )
        if (existing >= 0) merged[existing] = pair
        else merged.push(pair)
      }
      onChange(merged)
    } catch {
      toast.error(
        t(
          'labelMatch.invalidFile',
          'Could not read any key/value pair from the file.'
        )
      )
    }
  }

  return (
    <div className="space-y-3">
      <h4 className="text-sm font-medium">{title}</h4>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}

      {namespace && !isError && (
        <>
          {isLoading ? (
            <p className="text-xs text-muted-foreground">
              {t('labelMatch.loading', 'Matching existing Pods...')}
            </p>
          ) : (
            <div
              className={cn(matched.length > 0 ? MATCH_BANNER : WARNING_BANNER)}
            >
              <p>
                {selector.length === 0
                  ? t('labelMatch.unmatched', {
                      total: pods.length,
                      defaultValue: '0 of {{total}} Pods match.',
                    })
                  : t('labelMatch.matched', {
                      matched: matched.length,
                      total: pods.length,
                      defaultValue: '{{matched}} of {{total}} Pods match.',
                    })}
                {selector.length === 0 && emptyNote ? ` ${emptyNote}` : ''}
              </p>
              {matched.length > 0 && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {matched.slice(0, MAX_VISIBLE_MATCHES).map((pod) => (
                    <Badge
                      key={pod.metadata?.uid || pod.metadata?.name}
                      variant="outline"
                      className="bg-background/60 font-normal"
                    >
                      {pod.metadata?.name}
                    </Badge>
                  ))}
                  {matched.length > MAX_VISIBLE_MATCHES && (
                    <span className="text-xs">
                      {t('labelMatch.more', {
                        count: matched.length - MAX_VISIBLE_MATCHES,
                        defaultValue: '+{{count}} more',
                      })}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-3 text-xs font-medium text-muted-foreground">
        <span>{t('workloadWizard.labelKey', 'Key')}</span>
        <span>{t('workloadWizard.labelValue', 'Value')}</span>
        <span className="w-10" />
      </div>

      <div className="space-y-2">
        {pairs.map((pair, index) => (
          <div key={index} className="flex items-center gap-3">
            <Input
              value={pair.key}
              onChange={(e) =>
                onChange(
                  pairs.map((p, i) =>
                    i === index ? { ...p, key: e.target.value } : p
                  )
                )
              }
              placeholder={t('workloadWizard.labelKeyPlaceholder', 'e.g. foo')}
              className="h-9 min-w-0 flex-1"
            />
            <Input
              value={pair.value}
              onChange={(e) =>
                onChange(
                  pairs.map((p, i) =>
                    i === index ? { ...p, value: e.target.value } : p
                  )
                )
              }
              placeholder={t(
                'workloadWizard.labelValuePlaceholder',
                'e.g. bar'
              )}
              className="h-9 min-w-0 flex-1"
            />
            <button
              type="button"
              className="shrink-0 text-sm text-primary transition-colors hover:underline"
              onClick={() => onChange(pairs.filter((_, i) => i !== index))}
            >
              {t('workloadWizard.remove', 'Remove')}
            </button>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 border-primary/40 bg-primary/5 text-xs text-primary hover:bg-primary/10 hover:text-primary"
          onClick={() => onChange([...pairs, { key: '', value: '' }])}
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          {addLabel}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 text-xs"
          disabled={!namespace || isLoading || isError}
          onClick={() => {
            setPickerSearch('')
            setPickerOpen(true)
          }}
        >
          <Search className="mr-1 h-3.5 w-3.5" />
          {t('labelMatch.viewExisting', 'View existing labels')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 text-xs"
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="mr-1 h-3.5 w-3.5" />
          {t('common.actions.readFromFile', 'Read from file')}
        </Button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".json,.yaml,.yml,.txt,.properties,.env"
        className="hidden"
        onChange={(e) => {
          void handleImport(e.target.files)
          e.target.value = ''
        }}
      />

      {/* Existing labels of the namespace, one click away. */}
      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {t('labelMatch.existingTitle', 'Pick an existing label')}
            </DialogTitle>
            <DialogDescription>
              {t('labelMatch.existingHint', {
                namespace: namespace || '',
                total: pods.length,
                defaultValue:
                  'Labels collected from the {{total}} Pods of namespace {{namespace}}. The number counts how many Pods carry them; click a row to add it to the selector.',
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={pickerSearch}
              onChange={(e) => setPickerSearch(e.target.value)}
              placeholder={t(
                'labelMatch.existingSearch',
                'Search key or value...'
              )}
              className="h-9 pl-8"
            />
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
            {filteredExisting.map((label) => {
              const added = isPairSelected(label)
              return (
                <button
                  key={`${label.key}=${label.value}`}
                  type="button"
                  disabled={added}
                  onClick={() => addPair(label)}
                  className="flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-accent disabled:opacity-60 disabled:hover:bg-transparent"
                >
                  <span className="min-w-0 truncate font-mono text-xs">
                    {label.key}={label.value}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <Badge variant="secondary" className="font-normal">
                      {label.count}
                    </Badge>
                    <span className="text-xs text-primary">
                      {added
                        ? t('labelMatch.existingAdded', 'Added')
                        : t('common.actions.add', 'Add')}
                    </span>
                  </span>
                </button>
              )
            })}
            {filteredExisting.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                {existingLabels.length === 0
                  ? t(
                      'labelMatch.existingEmpty',
                      'No Pod labels available in this namespace.'
                    )
                  : t('common.messages.noOptionsFound', 'No options found')}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPickerOpen(false)}>
              {t('common.actions.close', 'Close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default LabelSelectorEditor
