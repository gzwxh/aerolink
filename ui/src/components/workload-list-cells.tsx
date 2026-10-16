import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Container } from 'kubernetes-types/core/v1'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ResourceType } from '@/types/api'
import { patchResource } from '@/lib/api'
import { copyToClipboard } from '@/lib/clipboard'
import { shortenImageName } from '@/lib/image-name'
import { cn, translateError } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

export function EmptyValue() {
  return <span className="text-muted-foreground text-sm">-</span>
}

// 镜像列：列表里只显示镜像名与 tag，完整地址悬浮查看，点击即复制；
// 单容器的工作负载不再重复容器名。
export function WorkloadImageCell({ containers }: { containers: Container[] }) {
  const { t } = useTranslation()

  if (containers.length === 0) {
    return <EmptyValue />
  }

  const showContainerName = containers.length > 1

  const copyImage = async (event: React.MouseEvent, image: string) => {
    // 行点击会跳详情页，复制不能连带触发。
    event.stopPropagation()
    if (await copyToClipboard(image)) {
      toast.success(t('common.messages.copied', '已复制到剪贴板'))
    } else {
      toast.error(
        t('common.messages.copyFailed', '复制失败，请手动选择文本后复制')
      )
    }
  }

  return (
    <div className="flex flex-col items-start gap-0.5 text-xs">
      {containers.map((container) => (
        <Tooltip key={container.name}>
          <TooltipTrigger asChild>
            <div
              className="flex w-full min-w-0 max-w-72 cursor-copy items-baseline gap-1"
              onClick={(event) => void copyImage(event, container.image || '')}
            >
              {showContainerName && (
                <span className="shrink-0 text-muted-foreground">
                  {container.name}:{' '}
                </span>
              )}
              <span className="min-w-0 truncate font-mono underline-offset-2 hover:underline">
                {shortenImageName(container.image || '')}
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm break-all font-mono text-xs">
            {container.name}: {container.image}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}

/**
 * 「健康」列：就绪 / 期望的比例条——全就绪绿、部分就绪黄、没有就绪副本或
 * 期望为 0 用中性灰。带 resourceType 时条本身就是扩缩容入口（点开步进器
 * patch spec.replicas）；DaemonSet 的副本数由控制器决定，条形只读。
 */
export function WorkloadHealthBar({
  ready,
  desired,
  name,
  namespace,
  resourceType,
  resourceLabel,
  canUpdate,
}: {
  ready: number
  desired: number
  name: string
  namespace: string
  resourceType?: Extract<ResourceType, 'deployments' | 'statefulsets'>
  /** 用于扩缩容成功提示，例如「Deployment」。 */
  resourceLabel?: string
  canUpdate: boolean
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [replicas, setReplicas] = useState(desired)
  const [isApplying, setIsApplying] = useState(false)

  const percent =
    desired > 0 ? Math.min(100, Math.round((ready / desired) * 100)) : 0
  const tone =
    ready <= 0 || desired <= 0
      ? 'bg-muted-foreground/40'
      : ready >= desired
        ? 'bg-success'
        : 'bg-warning'

  const canScale = Boolean(resourceType) && canUpdate
  const summary = t('common.messages.healthSummary', { ready, desired })
  const title = canScale
    ? `${summary}，${t('detail.dialogs.scaleDeployment.description')}`
    : summary

  const bar = (
    <span
      className={cn(
        'inline-flex h-4 w-24 items-center rounded-sm border border-input bg-muted/40 p-[2px]',
        canScale && 'hover:border-ring'
      )}
    >
      <span
        className={cn('h-full rounded-[2px]', tone)}
        style={{ width: `${percent}%` }}
      />
    </span>
  )

  if (!canScale || !resourceType) {
    return (
      <div className="flex items-center" title={title}>
        {bar}
      </div>
    )
  }

  const handleApply = async () => {
    setIsApplying(true)
    try {
      await patchResource(resourceType, name, namespace, {
        spec: { replicas },
      })
      toast.success(
        t('detail.status.scaledTo', {
          resource: resourceLabel ?? resourceType,
          replicas,
        })
      )
      setOpen(false)
      queryClient.invalidateQueries({ queryKey: [resourceType] })
    } catch (error) {
      toast.error(translateError(error, t))
    } finally {
      setIsApplying(false)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        // 每次打开都按当前值重置，避免上一行/上次留下的草稿。
        if (next) setReplicas(desired)
        setOpen(next)
      }}
    >
      <PopoverTrigger asChild>
        <button type="button" title={title} aria-label={title}>
          {bar}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56" align="start">
        <div className="space-y-3">
          <Label htmlFor={`replicas-${namespace}-${name}`}>
            {t('common.fields.replicas')}
          </Label>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="size-9 p-0"
              onClick={() => setReplicas(Math.max(0, replicas - 1))}
              disabled={isApplying || replicas <= 0}
            >
              -
            </Button>
            <Input
              id={`replicas-${namespace}-${name}`}
              type="number"
              min="0"
              value={replicas}
              onChange={(e) =>
                setReplicas(Math.max(0, parseInt(e.target.value) || 0))
              }
              disabled={isApplying}
              className="text-center"
            />
            <Button
              variant="outline"
              size="sm"
              className="size-9 p-0"
              onClick={() => setReplicas(replicas + 1)}
              disabled={isApplying}
            >
              +
            </Button>
          </div>
          <Button
            onClick={handleApply}
            disabled={isApplying}
            className="w-full"
          >
            {t('common.actions.scale')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
