/**
 * 集群 URL 短名（slug）的客户端校验：与后端 pkg/cluster/slug.go 的
 * slugPattern 保持同一口径（1-48 位 [a-z0-9-]，字母或数字开头）。
 * 自动生成的短名必然合法；这里拦的是手填值，非法时提示而不是静默改写。
 */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/

export function isValidClusterSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug)
}

/**
 * 找出第一个填了非法短名的 context；全合法（或都没填）时返回 null。
 * 导入对话框与初始化向导共用同一口径：整批 fail-closed，一处非法就整批不提交。
 */
export function findInvalidSlugContext(
  contexts: readonly string[],
  slugs: Record<string, string>
): string | null {
  for (const context of contexts) {
    const slug = slugs[context]?.trim()
    if (slug && !isValidClusterSlug(slug)) {
      return context
    }
  }
  return null
}

/**
 * 只提交真正手填的短名：丢掉留空的（走后端自动生成），也丢掉当前 kubeconfig
 * 里已不存在的 context（粘贴内容被改过后遗留的旧值——后端会把它算进冲突判定）。
 */
export function filledSlugs(
  contexts: readonly string[],
  slugs: Record<string, string>
): Record<string, string> {
  const filled: Record<string, string> = {}
  for (const context of contexts) {
    const slug = slugs[context]?.trim()
    if (slug) {
      filled[context] = slug
    }
  }
  return filled
}
