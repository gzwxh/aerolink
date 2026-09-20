import { withSubPath } from './subpath'

/**
 * 规范化头像地址。
 *
 * 常见误用：直接粘贴 GitHub 的页面链接
 * （`https://github.com/<owner>/<repo>/blob/<ref>/<path>`）。那返回的是 HTML 页面
 * 而不是图片资源，浏览器 `<img src>` 加载后无法渲染，表现就是「设置了头像却不显示」。
 * 这里把这类链接转成 raw 直链，其余地址原样返回。
 */
const GITHUB_PAGE_LINK =
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/i

export function normalizeAvatarUrl(raw: string | undefined): string {
  const value = (raw || '').trim()
  if (!value) {
    return ''
  }

  const match = GITHUB_PAGE_LINK.exec(value)
  if (!match) {
    return value
  }

  const [, owner, repo, rawPath] = match
  // 页面链接常带 `?raw=true` / `#...`，对 raw 直链没有意义，一并去掉。
  const path = rawPath.split(/[?#]/)[0]
  return `https://raw.githubusercontent.com/${owner}/${repo}/${path}`
}

/**
 * 把 `avatar_url` 解析成 `<img src>` 能用的地址。
 *
 * 这个字段有两种值，都需要处理：
 *
 * 1. **用户上传的头像**：服务端写入的是 `/api/users/<id>/avatar?v=<version>`
 *    （不带 base path，见 `pkg/users/avatar.go` 的 `AvatarPath`）。子路径部署时
 *    浏览器需要带上前缀，所以这里补 `withSubPath`。
 * 2. **外链地址**：用户自己填的图片直链（或 OIDC 下发的 picture），走
 *    `normalizeAvatarUrl` 的归一化。
 */
export function resolveAvatarSrc(raw: string | undefined): string | undefined {
  const value = (raw || '').trim()
  if (!value) {
    return undefined
  }
  if (value.startsWith('/api/')) {
    return withSubPath(value)
  }
  return normalizeAvatarUrl(value)
}
