import { expect, test } from '@playwright/test'

const baseURL =
  process.env.KITE_E2E_BASE_URL ||
  `http://127.0.0.1:${process.env.KITE_E2E_PORT || '38080'}`

test('custom role grants namespaces and denies nodes', async ({
  browser,
  page,
}) => {
  const roleName = `e2e-rbac-${Date.now()}`
  const username = `e2e-rbac-user-${Date.now()}`
  const displayName = 'E2E RBAC User'
  const password = 'E2Epass!2345'

  await page.goto('/settings?tab=users')

  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()

  await page.getByRole('button', { name: 'Add Password User' }).click()

  const userDialog = page.getByRole('dialog', { name: 'Add Password User' })
  await expect(userDialog).toBeVisible()

  await userDialog.locator('input').nth(0).fill(username)
  await userDialog.locator('input').nth(1).fill(displayName)
  await userDialog.locator('input').nth(2).fill(password)
  await userDialog.getByRole('button', { name: 'Create' }).click()

  await expect(page.getByRole('row').filter({ hasText: username })).toBeVisible()

  await page.goto('/rbac')
  await expect(
    page.getByRole('heading', { name: 'RBAC Management' })
  ).toBeVisible()

  await page.getByRole('button', { name: 'Add Role' }).click()

  await page.getByLabel(/^Name \*$/).fill(roleName)
  await page.getByLabel('Description').fill('Namespaces read only')

  // Grant all clusters and all namespaces via the wildcard rows.
  await page.getByRole('button', { name: 'All clusters (*)' }).click()
  await page.getByRole('button', { name: 'All namespaces (*)' }).click()

  // Resources: pick "namespaces" from the suggestions popover.
  await page.getByRole('combobox', { name: /Select resources.../ }).click()
  await page.getByPlaceholder('Search...').last().fill('namespaces')
  await page.getByRole('option', { name: 'namespaces', exact: true }).click()
  await page.keyboard.press('Escape')

  // Verbs: pick get + list.
  await page.getByRole('combobox', { name: /Select verbs.../ }).click()
  await page.getByPlaceholder('Search...').last().fill('get')
  await page.getByRole('option', { name: 'get', exact: true }).click()
  await page.getByPlaceholder('Search...').last().fill('list')
  await page.getByRole('option', { name: 'list', exact: true }).click()
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Create', exact: true }).click()

  // After creation the role appears in the left-hand list and is selected.
  await expect(
    page.getByTestId('rbac-role-list').getByRole('button', {
      name: roleName,
    })
  ).toBeVisible()

  // Assign the new role to the user via the members panel.
  await page.getByRole('combobox', { name: /Select users.../ }).click()
  await page.getByPlaceholder('Search...').last().fill(username)
  await page.getByRole('option', { name: username }).click()
  await page.getByRole('button', { name: 'Add', exact: true }).click()

  await expect(page.getByText(username).first()).toBeVisible()

  const userContext = await browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  })
  const userPage = await userContext.newPage()

  await userPage.goto('/login')
  await userPage.getByLabel('Username').fill(username)
  await userPage.getByLabel('Password', { exact: true }).fill(password)
  await userPage.getByRole('button', { name: 'Sign In with Password' }).click()
  await userPage.waitForURL((url) => url.pathname === '/')

  await userPage.goto('/namespaces')
  await expect(
    userPage.getByRole('link', { name: 'kube-system' })
  ).toBeVisible()

  await userPage.goto('/nodes')
  await expect(
    userPage.getByRole('heading', { name: 'Error loading nodes' })
  ).toBeVisible()
  await expect(userPage.getByText(new RegExp(`User ${username}`))).toBeVisible()
  await expect(
    userPage.getByText(/does not have permission/i)
  ).toBeVisible()

  await userContext.close()
})
