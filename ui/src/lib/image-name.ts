/**
 * 压缩镜像地址，供列表展示使用。
 *
 * 内网镜像常常带很长的仓库前缀与流水线时间戳，例如
 * `10.10.11.100:1180/l_ops/dsyy/cc-ops/activity-card-center:v2.0.27-amd64-2025082705112345`。
 * 在表格里逐字显示会折行、把整行拉高，因此这里只保留镜像名与 tag（或 digest 的前 12 位），
 * 省略掉的仓库前缀用 `…/` 表示；完整地址由调用方通过 title / tooltip 提供给用户。
 */
export function shortenImageName(image: string): string {
  const value = (image || '').trim()
  if (!value) return value

  // 1) 先摘出 digest：`repo@sha256:<64 位>` 的哈希太长，只留前 12 位。
  const [repoPart, digestPart] = value.split('@')
  let reference = ''
  if (digestPart) {
    const [algorithm, hash = ''] = digestPart.split(':')
    const shortHash = hash.length > 12 ? `${hash.slice(0, 12)}…` : hash
    reference = shortHash ? `@${algorithm}:${shortHash}` : `@${algorithm}`
  }

  // 2) 再摘出 tag：只有位于最后一个 `/` 之后的 `:` 才是 tag，
  //    否则它是 registry 的端口（如 registry.local:5000/app）。
  const lastSlash = repoPart.lastIndexOf('/')
  const tagColon = repoPart.indexOf(':', lastSlash)
  let repository = repoPart
  if (tagColon !== -1) {
    reference = repoPart.slice(tagColon) + reference
    repository = repoPart.slice(0, tagColon)
  }

  // 3) 省略仓库前缀，只保留最后一段（镜像名本身）。
  const segments = repository.split('/').filter(Boolean)
  const name =
    segments.length > 1 ? `…/${segments[segments.length - 1]}` : repository

  return `${name}${reference}`
}
