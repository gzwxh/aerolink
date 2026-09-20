import { expect, test, type Page } from '@playwright/test'

import { e2eContextName } from '../env'
import { expectStatus } from '../support/admin-api'

/**
 * ConfigMap / Secret 列表的列宽与截断。
 *
 * 这两个页面的「键」列内容完全不受控（集群里见过 150+ 个键的 ConfigMap）：
 * 直接把键铺开时，一个单元格就能把表格撑到容器宽度的两倍、逼出横向滚动条。
 * 这个文件锁住三件事：
 *
 *   1. 表格不宽于容器（不出现横向滚动）；
 *   2. 超长内容只显示一部分；
 *   3. 悬浮时才展示完整内容。
 *
 * 运行（对已有集群、真实 K8s）：
 *   make e2e-run-existing KUBECONFIG=~/.kube/config \
 *     E2E_CLUSTER_NAME=<context 名> E2E_CONTEXT_NAME=<context 名> E2E_NODE_NAME=<node> \
 *     SPEC="specs/list-cell-truncation.spec.ts"
 */

const namespace = 'default'
const clusterPath = `/api/v1/_clusters/${encodeURIComponent(e2eContextName)}`

const uniqueName = (kind: string) =>
  `zz-e2e-trunc-${kind}-${Date.now().toString(36)}`

// 键足够多：即使每个键都不长，全部铺开也会超出单元格的宽度上限。
const keys = Array.from(
  { length: 20 },
  (_, index) => `very-long-config-key-name-${index}`
)

type TruncationKind = 'configmaps' | 'secrets'

const seedYaml: Record<TruncationKind, (name: string) => string> = {
  configmaps: (name) => `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${name}
  namespace: ${namespace}
data:
${keys.map((key) => `  ${key}: value`).join('\n')}
`,
  secrets: (name) => `apiVersion: v1
kind: Secret
metadata:
  name: ${name}
  namespace: ${namespace}
type: Opaque
stringData:
${keys.map((key) => `  ${key}: value`).join('\n')}
`,
}

async function remove(
  request: import('@playwright/test').APIRequestContext,
  kind: TruncationKind,
  name: string
) {
  await request
    .delete(`${clusterPath}/${kind}/${namespace}/${name}`)
    .catch(() => undefined)
}

/** 表格是否被内容撑出容器（撑出时容器会出现横向滚动条）。 */
async function tableOverflowsContainer(page: Page) {
  return page.evaluate(() => {
    const table = document.querySelector('[data-slot="table"]')
    const container = document.querySelector('[data-slot="table-container"]')
    if (!table || !container) {
      return null
    }
    return table.getBoundingClientRect().width > container.clientWidth + 1
  })
}

for (const kind of ['configmaps', 'secrets'] as const) {
  test(`${kind} 的键列不撑宽表格，超长内容截断并悬浮显示全部`, async ({
    page,
    request,
  }) => {
    const name = uniqueName(kind)
    try {
      await expectStatus(
        await request.post(`${clusterPath}/resources/apply`, {
          data: { yaml: seedYaml[kind](name) },
        }),
        200
      )

      await page.goto(`/${kind}`)
      const search = kind === 'configmaps' ? 'ConfigMaps' : 'Secrets'
      await page.getByPlaceholder(`Search ${search} or app=nginx...`).fill(name)

      const row = page.getByRole('row').filter({ hasText: name })
      await expect(row).toBeVisible()

      // 单元格里显示的是完整的键列表，靠 CSS 截断；用最后一个键定位这一列，
      // 不依赖列的顺序。
      const cell = row
        .locator('[data-slot="table-cell"]')
        .filter({ hasText: keys[keys.length - 1] })
      const trigger = cell.locator('span').first()
      await expect(trigger).toBeVisible()

      // 横向不溢出：回归时整张表会被撑宽（密钥列一度达到 1463px）。
      expect(await tableOverflowsContainer(page)).toBe(false)

      // 内容确实超出可显示范围 —— 没有这条，下面的截断断言会变得没有意义。
      const { scrollWidth, clientWidth } = await trigger.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }))
      expect(scrollWidth).toBeGreaterThan(clientWidth)

      // 完整内容只在这里出现。
      await trigger.hover()
      const tooltip = page.getByRole('tooltip')
      await expect(tooltip).toContainText(`${keys.length} key(s)`)
      await expect(tooltip).toContainText(keys[keys.length - 1])
    } finally {
      await remove(request, kind, name)
    }
  })
}
