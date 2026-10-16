import { expect, test } from '@playwright/test'

import { clusterPathPattern } from '../support/cluster-url'
import { adminUser, englishStorageState } from '../env'
import { loginWithPasswordUi } from '../support/users'

test.describe('auth session', () => {
  test('logout returns to login', async ({ page }) => {
    await page.goto('/')

    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()

    await page.locator('header').getByRole('button').last().click()
    await page.getByRole('menuitem', { name: 'Log out' }).click()

    await page.waitForURL('**/login')
    // 环境启用 LDAP 时登录页默认停在 LDAP 页签，这里只断言「回到了登录页」。
    await expect(
      page.getByRole('button', { name: /^Sign In with / })
    ).toBeVisible()
  })
})

test.describe('password login', () => {
  test.use({ storageState: englishStorageState() })

  test('returns to the app', async ({ page }) => {
    await page.goto('/login')

    await loginWithPasswordUi(page, adminUser.username, adminUser.password)

    await page.waitForURL((url) => clusterPathPattern('/').test(url.pathname))
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
  })
})
