import { expect, type Browser, type Page } from '@playwright/test'

import { englishStorageState } from '../env'

// 用户管理页（当前 UI）的公共操作：建账号、改密码、停用/启用、删除，
// 以及用密码登录。几个用例都要用同一套选择器，集中在这里维护。

export async function openUsersPage(page: Page) {
  await page.goto('/settings/user?tab=users')
  await expect(
    page.getByRole('heading', { name: 'System Settings' })
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Add Password User' })
  ).toBeVisible()
}

export async function createPasswordUser(
  page: Page,
  username: string,
  name: string,
  password: string
) {
  await page.getByRole('button', { name: 'Add Password User' }).click()

  const dialog = page.getByRole('dialog', { name: 'New user' })
  await expect(dialog).toBeVisible()

  await dialog.getByLabel(/^Username/).fill(username)
  await dialog.getByLabel(/^Name$/).fill(name)
  await dialog.getByLabel(/^Password/).fill(password)
  await dialog.getByRole('button', { name: 'Create' }).click()

  await expect(dialog).toBeHidden()
  await expect(
    page.getByRole('row').filter({ hasText: username })
  ).toBeVisible()
}

function userRow(page: Page, username: string) {
  return page.getByRole('row').filter({ hasText: username }).first()
}

/**
 * 打开账号详情弹窗。用户列表里没有下拉菜单了：头像与用户名就是详情入口，
 * 查看与操作（改密 / 启用停用 / 删除）都在这个弹窗里（见 user-management.tsx）。
 */
async function openUserDetail(page: Page, username: string) {
  await userRow(page, username)
    .getByRole('button', { name: username, exact: true })
    .click()
  const dialog = page.getByRole('dialog', { name: username })
  await expect(dialog).toBeVisible()
  return dialog
}

export async function resetPassword(
  page: Page,
  username: string,
  password: string
) {
  const detail = await openUserDetail(page, username)
  await detail.getByRole('button', { name: 'Reset Password' }).click()

  const dialog = page.getByRole('dialog', { name: 'Reset Password' })
  await expect(dialog).toBeVisible()

  await dialog.locator('input').fill(password)
  await dialog.getByRole('button', { name: 'Save' }).click()

  await expect(dialog).toBeHidden()
}

export async function toggleUserEnabled(
  page: Page,
  username: string,
  actionName: 'Disable' | 'Enable'
) {
  const detail = await openUserDetail(page, username)
  await detail.getByRole('button', { name: actionName }).click()

  // 弹窗是模态的：打开期间后台的行不在可访问性树里（getByRole 找不到），
  // 所以先关掉详情，再拿列表里的状态徽标当完成信号。
  await page.keyboard.press('Escape')
  await expect(detail).toBeHidden()

  await expect(userRow(page, username)).toContainText(
    actionName === 'Disable' ? 'Disabled' : 'Enabled'
  )
}

export async function deleteUser(page: Page, username: string) {
  const detail = await openUserDetail(page, username)
  await detail.getByRole('button', { name: 'Delete' }).click()

  const dialog = page.getByRole('dialog', { name: 'Delete user' })
  await expect(dialog).toBeVisible()
  await dialog.getByPlaceholder(username).fill(username)
  await dialog.getByRole('button', { name: 'Delete' }).click()

  await expect(page.getByRole('row').filter({ hasText: username })).toHaveCount(
    0
  )
}

export async function loginWithPasswordUi(
  page: Page,
  username: string,
  password: string
) {
  await expect(
    page.getByRole('button', { name: 'Sign In with Password' })
  ).toBeVisible()

  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign In with Password' }).click()
}

/**
 * 新开一个干净上下文并用密码登录，返回该上下文与页面。
 *
 * 只断言登录成功（URL 回到 `/`）：被授权范围（权限绑定组的命名空间）里的
 * 账号可以正常登录，但首页概览读的是集群级数据，不保证渲染出标题。
 */
export async function loginFreshContext(
  browser: Browser,
  origin: string,
  username: string,
  password: string
) {
  const context = await browser.newContext({
    storageState: englishStorageState(origin),
  })
  const page = await context.newPage()

  await page.goto(`${origin}/login`)
  await loginWithPasswordUi(page, username, password)
  await page.waitForURL((url) => url.pathname === '/')

  return { context, page }
}

/** 预期登录被拒：未启用、没有任何授权时是 insufficient permissions，旧密码是 invalid credentials。 */
export async function loginExpectingFailure(
  browser: Browser,
  origin: string,
  username: string,
  password: string,
  message = 'insufficient permissions'
) {
  const context = await browser.newContext({
    storageState: englishStorageState(origin),
  })
  const page = await context.newPage()

  await page.goto(`${origin}/login`)
  await loginWithPasswordUi(page, username, password)
  await expect(page).toHaveURL(/\/login/)
  await expect(page.getByRole('alert')).toContainText(message)

  return { context, page }
}
