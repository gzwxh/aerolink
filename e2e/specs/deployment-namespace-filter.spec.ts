import { expect, test } from '@playwright/test'

/**
 * 回归：多选命名空间后列表页必须仍然可用。
 *
 * 之前 /deployments 的「URL 里的命名空间在当前集群中是否存在」判定会把多选时写进
 * URL 的逗号拼接值（`/deployments/default%2Ckube-system`）当成一个命名空间名，于是
 * 整页被「Namespace ... does not exist」的错误页替换 —— 工具栏（含命名空间选择器
 * 与搜索框）一起消失，用户只能点「View all」逃出来。
 *
 * 口径：URL 的单段路径只能表达一个命名空间，多选由表格状态（sessionStorage）持有。
 */

/** 工具栏里唯一带选中值文本的 combobox 就是命名空间选择器。 */
function namespacePicker(page: import('@playwright/test').Page) {
  return page.getByRole('combobox').filter({
    hasText: /Select namespaces|Namespaces|^default$|^kube-|^cert-|^local-path/,
  })
}

test('selecting several namespaces keeps the table usable', async ({
  page,
}) => {
  await page.goto('/deployments')
  await page.waitForSelector('table tbody tr', { timeout: 30_000 })

  const openPicker = async () => {
    await namespacePicker(page).click()
    await expect(page.getByPlaceholder('Search...')).toBeVisible()
  }

  // 集群里要有至少两个非 default 的命名空间，才能构造出多选。
  await openPicker()
  const candidates = await page
    .locator('[cmdk-item]')
    .evaluateAll((nodes) =>
      nodes
        .map((node) => (node.textContent || '').trim())
        .filter(
          (name) => name && name !== 'All Namespaces' && name !== 'default'
        )
    )
  expect(
    candidates.length,
    '这个用例需要至少两个非 default 的命名空间'
  ).toBeGreaterThanOrEqual(2)
  const [first, second] = candidates

  // 勾选会改动选择并触发 URL 同步，弹层可能随之关闭：每次勾之前确认它还开着。
  const tick = async (name: string) => {
    const searchBox = page.getByPlaceholder('Search...')
    if (!(await searchBox.isVisible().catch(() => false))) {
      await openPicker()
    }
    await page
      .getByRole('checkbox', { name: `Toggle namespace ${name}` })
      .click()
    await page.waitForTimeout(300)
  }
  await tick(first)
  await tick(second)

  // 触发器应显示多选计数（default + 刚勾的两个）。
  await expect(namespacePicker(page)).toContainText('Namespaces')
  // 关键回归点：页面不能被「命名空间不存在」的错误页接管。
  await expect(
    page.getByText('does not exist in the current cluster')
  ).toHaveCount(0)
  await expect(page.locator('table')).toBeVisible()
  // 多选值不该出现在 URL 上。
  expect(page.url()).not.toContain('%2C')
  expect(new URL(page.url()).pathname).toBe('/deployments')

  // 刷新后选择由 sessionStorage 恢复，页面依旧可用。
  await page.reload()
  await page.waitForSelector('table tbody tr', { timeout: 30_000 })
  await expect(namespacePicker(page)).toContainText('Namespaces')
  await expect(
    page.getByText('does not exist in the current cluster')
  ).toHaveCount(0)
})

test('switching to a single namespace still syncs the URL', async ({
  page,
}) => {
  await page.goto('/deployments')
  await page.waitForSelector('table tbody tr', { timeout: 30_000 })

  await namespacePicker(page).click()
  await page.getByPlaceholder('Search...').fill('kube-system')
  await page.locator('[cmdk-item]', { hasText: 'kube-system' }).first().click()

  // 单选照旧写进 URL，并只展示该命名空间的资源。
  await page.waitForURL((url) => url.pathname === '/deployments/kube-system')
  await expect(page.locator('table')).toBeVisible()
  await expect(
    page.getByText('does not exist in the current cluster')
  ).toHaveCount(0)
})
