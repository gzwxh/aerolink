import { expect, type Page } from "@playwright/test";

/**
 * 集群信息进入浏览器地址栏之后，业务页面都挂在 /_clusters/<slug>/ 前缀下
 * （slug 是自动生成的，测试不能写死）。断言路径时统一用这里的辅助：
 * 匹配「前缀（可有可无）+ 业务路径」。
 */
export function clusterPathPattern(businessPath: string): RegExp {
  // 根路径（"/"）只匹配裸 "/" 或 "/_clusters/<slug>"；非根业务路径在前缀与
  // 业务路径之间必须有 "/" 分隔，否则正则永远匹配不到实际 URL。
  const normalized = businessPath.startsWith("/")
    ? businessPath.slice(1)
    : businessPath;
  const body = normalized ? `/${escapeRegExp(normalized)}` : "";
  return new RegExp(`^(/_clusters/[^/]+)?${body}$`);
}

export async function waitForClusterPath(page: Page, businessPath: string) {
  const pattern = clusterPathPattern(businessPath);
  await page.waitForURL((url) => pattern.test(url.pathname));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
