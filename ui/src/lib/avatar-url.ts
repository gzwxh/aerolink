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
