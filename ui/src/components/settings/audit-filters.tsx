import { useState } from 'react'
import { IconCopy, IconDownload } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import type { DownloadResult } from '@/lib/api/shared'
import { copyToClipboard } from '@/lib/clipboard'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

// 指纹这类长字符串放在弹窗里展示并提供复制：导出的证据要能离线核对，
// 光在 toast 里闪一下是留不住的。
function DigestRow({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation()

  const copy = async () => {
    if (await copyToClipboard(value)) {
      toast.success(t('common.messages.copied', '已复制到剪贴板'))
    } else {
      toast.error(
        t('common.messages.copyFailed', '复制失败，请手动选择文本后复制')
      )
    }
  }

  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1 font-mono text-xs">
          {value}
        </code>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-muted-foreground"
          aria-label={t('common.actions.copy', '复制')}
          title={t('common.actions.copy', '复制')}
          onClick={() => void copy()}
        >
          <IconCopy className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}

/**
 * 导出按钮：用与列表相同的筛选条件导出 CSV。
 *
 * 导出完成后弹窗展示条目数、时间范围与内容指纹（SHA-256 / 服务端 HMAC）：接收方
 * 可以对拿到的文件执行 `sha256sum` 与 SHA-256 比对，确认文件未被改动；HMAC 由服务端
 * 密钥生成，用于确认这份导出确实出自本服务器。指纹并不防数据库层面的篡改——
 * 那个由审计外发（syslog）与数据库权限控制负责。
 */
export function AuditExportButton({
  onExport,
  disabled,
}: {
  onExport: () => Promise<DownloadResult>
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const [isExporting, setIsExporting] = useState(false)
  const [result, setResult] = useState<DownloadResult | null>(null)

  const handleExport = async () => {
    setIsExporting(true)
    try {
      setResult(await onExport())
    } catch (error) {
      // 导出失败的即时反馈（失败不再写站内信，这里就是唯一的反馈）
      toast.error(
        error instanceof Error
          ? error.message
          : t('audit.export.failed', '导出失败')
      )
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <>
      <Button
        variant="outline"
        onClick={() => void handleExport()}
        disabled={disabled || isExporting}
      >
        <IconDownload className="h-4 w-4" />
        {t('audit.export.button', '导出 CSV')}
      </Button>

      <Dialog
        open={result !== null}
        onOpenChange={(open) => {
          if (!open) setResult(null)
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {t('audit.export.resultTitle', '导出完成')}
            </DialogTitle>
            <DialogDescription>
              {t(
                'audit.export.resultDescription',
                '文件已保存到本机。下面的指纹可用于离线核对。'
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <span className="text-muted-foreground">
                {t('audit.export.fileName', '文件名')}
              </span>
              <span className="break-all font-mono text-xs">
                {result?.filename}
              </span>
              <span className="text-muted-foreground">
                {t('audit.export.rowCount', '记录条数')}
              </span>
              <span>{result?.rowCount ?? 0}</span>
              <span className="text-muted-foreground">
                {t('audit.export.timeRange', '时间范围')}
              </span>
              <span className="break-all font-mono text-xs">
                {result?.timeRange ?? '*'}
              </span>
            </div>

            {result?.sha256 && (
              <DigestRow
                label={t('audit.export.sha256', 'SHA-256（文件内容指纹）')}
                value={result.sha256}
              />
            )}
            {result?.hmac && (
              <DigestRow
                label={t('audit.export.hmac', '服务端签名（HMAC-SHA256）')}
                value={result.hmac}
              />
            )}

            <p className="text-xs text-muted-foreground">
              {t(
                'audit.export.verifyHint',
                '校验方法：对下载的文件执行 sha256sum，结果应与上面的 SHA-256 一致；签名由服务端密钥生成，可确认该文件出自本服务器。'
              )}
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
