import { useTranslation } from 'react-i18next'

import { isValidClusterSlug } from '@/lib/cluster-slug'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/** 没有同名集群时的空表：用常量而不是内联 `{}`，免得每次渲染都换一个新对象。 */
const NO_EXISTING_SLUGS: Record<string, string> = {}

interface ClusterSlugFieldsProps {
  /** kubeconfig 里的 context 名，逐行一个短名输入框。 */
  contexts: string[]
  /** context 名 → 手填短名；留空的由后端自动生成。 */
  slugs: Record<string, string>
  onSlugChange: (context: string, slug: string) => void
  /** 第一个非法短名所属的 context（见 lib/cluster-slug 的 findInvalidSlugContext）。 */
  invalidContext: string | null
  /**
   * context 名（= 集群名）→ 该集群**当前已固化**的短名。
   *
   * 后端的导入是按 context 名匹配的：同名集群走「只更新 config」的分支，短名不参与
   * 更新。这些行只读展示现有短名，不接收手填值。
   */
  existingSlugs?: Record<string, string>
}

/**
 * 逐行短名编辑器：为 kubeconfig 里的每个 context 手填 `/_clusters/<slug>` 用的短名。
 *
 * 导入对话框与初始化向导共用这一份实现（方案 §3.2「初始化向导同步接入」）——
 * 两处的校验口径、占位文案与错误提示必须一致，否则同一份 kubeconfig 在
 * 两个入口会得到不同的结果。
 */
export function ClusterSlugFields({
  contexts,
  slugs,
  onSlugChange,
  invalidContext,
  existingSlugs = NO_EXISTING_SLUGS,
}: ClusterSlugFieldsProps) {
  const { t } = useTranslation()

  if (contexts.length === 0) {
    return null
  }

  const hasExisting = contexts.some((context) => existingSlugs[context])

  return (
    <div className="space-y-2">
      <Label>{t('clusterManagement.dialog.slugPerContext')}</Label>
      <p className="text-xs text-muted-foreground">
        {t('clusterManagement.dialog.slugPerContextHint')}
      </p>
      <div className="space-y-2">
        {contexts.map((context) => {
          const existingSlug = existingSlugs[context]
          const slug = existingSlug ?? slugs[context] ?? ''
          const invalid =
            !existingSlug && !!slug.trim() && !isValidClusterSlug(slug)
          return (
            <div key={context} className="grid grid-cols-2 gap-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <Label className="truncate text-xs" title={context}>
                  {context}
                </Label>
                {existingSlug && (
                  <Badge variant="secondary" className="shrink-0 text-xs">
                    {t('clusterManagement.dialog.slugExistingBadge')}
                  </Badge>
                )}
              </div>
              <div className="space-y-1">
                <Input
                  value={slug}
                  onChange={(event) =>
                    onSlugChange(context, event.target.value)
                  }
                  readOnly={!!existingSlug}
                  placeholder={t(
                    'clusterManagement.dialog.slugAutoPlaceholder'
                  )}
                  aria-invalid={invalid}
                  aria-label={context}
                  className={
                    existingSlug
                      ? 'bg-muted text-muted-foreground'
                      : invalid
                        ? 'border-destructive'
                        : undefined
                  }
                />
              </div>
            </div>
          )
        })}
      </div>
      {hasExisting && (
        <p className="text-xs text-muted-foreground">
          {t('clusterManagement.dialog.slugExistingHint')}
        </p>
      )}
      {invalidContext && (
        <p role="alert" className="text-sm text-destructive">
          {t('clusterManagement.dialog.slugInvalidForContext', {
            context: invalidContext,
          })}
        </p>
      )}
    </div>
  )
}
