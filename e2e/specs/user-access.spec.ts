import { expect, test, type Page } from '@playwright/test'

import { e2eContextName } from '../env'
import {
  deleteBindingGroup,
  deleteUserById,
  expectStatus,
  findUserId,
  grantRoleInNamespace,
} from '../support/admin-api'
import {
  createPasswordUser,
  deleteUser,
  loginExpectingFailure,
  loginFreshContext,
  openUsersPage,
} from '../support/users'

/**
 * 管理员页签：把账号加进当前集群受保护的「超级权限绑定」。
 * 这是界面上授予系统管理员权限的唯一入口。
 */
async function addAdministrator(page: Page, username: string) {
  await page.goto('/settings/rbac?rbacTab=administrators')

  await page.getByRole('button', { name: 'Add administrator' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add administrator' })
  await expect(dialog).toBeVisible()

  // 弹窗现在有「用户 / 用户组 / 角色」三个选择器（角色已默认选中系统管理员），
  // 按占位文案定位到用户那个。
  await dialog
    .getByRole('combobox')
    .filter({ hasText: 'Select users' })
    .click()
  await page.getByPlaceholder('Search...').fill(username)
  await page.getByRole('option', { name: username }).click()
  // 该选择器是多选：选中后仍保持打开以便
  // 继续选择多个账号，而它的弹层会盖住提交按钮。
  // 像用户那样关掉它（Escape 关闭弹层，而不是对话框）。
  await page.keyboard.press('Escape')

  await dialog.getByRole('button', { name: 'Add administrator' }).click()
  await expect(dialog).toBeHidden()
  await expect(
    page.getByRole('row').filter({ hasText: username })
  ).toBeVisible()
}

test('password user lifecycle and access scopes', async ({
  browser,
  page,
  request,
}) => {
  const suffix = Date.now().toString(36)
  const noRoleUser = {
    username: `e2e-norole-${suffix}`,
    name: 'E2E No Role',
    password: 'E2Epass!2345',
  }
  const scopedUser = {
    username: `e2e-viewer-${suffix}`,
    name: 'E2E Viewer',
    password: 'E2Epass!2345',
  }
  const managedAdminUser = {
    username: `e2e-admin-${suffix}`,
    name: 'E2E Admin',
    password: 'E2Epass!2345',
  }
  const groupName = `e2e-access-scope-${suffix}`

  const userIds: Array<number | undefined> = []
  let groupId: number | undefined

  try {
    await openUsersPage(page)
    const origin = new URL(page.url()).origin

    // 1) 没有任何授权的账号连登录都不允许。
    await createPasswordUser(
      page,
      noRoleUser.username,
      noRoleUser.name,
      noRoleUser.password
    )
    userIds.push(await findUserId(request, noRoleUser.username))

    const noRoleSession = await loginExpectingFailure(
      browser,
      origin,
      noRoleUser.username,
      noRoleUser.password
    )
    await noRoleSession.context.close()

    // 2) 权限绑定组的成员：只在组内命名空间可用，看不到管理面。
    await openUsersPage(page)
    await createPasswordUser(
      page,
      scopedUser.username,
      scopedUser.name,
      scopedUser.password
    )
    userIds.push(await findUserId(request, scopedUser.username))
    groupId = await grantRoleInNamespace(request, {
      cluster: e2eContextName,
      groupName,
      roleName: 'viewer',
      namespace: 'kube-system',
      subject: scopedUser.username,
    })

    const scopedSession = await loginFreshContext(
      browser,
      origin,
      scopedUser.username,
      scopedUser.password
    )
    await scopedSession.page.goto(`${origin}/namespaces`)
    await expect(
      scopedSession.page.getByRole('link', { name: 'kube-system' })
    ).toBeVisible()
    await expect(
      scopedSession.page.getByRole('link', { name: 'System Settings' })
    ).toHaveCount(0)
    await expect(
      scopedSession.page.getByRole('button', {
        name: 'Toggle Kubectl Terminal',
      })
    ).toHaveCount(0)
    await scopedSession.context.close()

    // 3) 管理员页签：加入超级权限绑定，拿到系统管理员的全部权限。
    await openUsersPage(page)
    await createPasswordUser(
      page,
      managedAdminUser.username,
      managedAdminUser.name,
      managedAdminUser.password
    )
    userIds.push(await findUserId(request, managedAdminUser.username))
    await addAdministrator(page, managedAdminUser.username)

    const adminSession = await loginFreshContext(
      browser,
      origin,
      managedAdminUser.username,
      managedAdminUser.password
    )
    // 控制台导航以 /api/auth/user 上报的角色为准，
    // 而那里只带直接角色分配——全局权限绑定组的成员身份
    // 有意不在那里上报。但授权本身是真实的：后端用
    // effectiveRoles（直接角色 + 全局绑定组）做鉴权，因此应在 API 层
    // 断言该能力。
    await expectStatus(
      await adminSession.page.request.get('/api/v1/admin/users/'),
      200
    )
    await adminSession.context.close()

    // 收尾：删掉三个账号（用户删除会一并清掉它们的成员关系）。
    await openUsersPage(page)
    for (const user of [noRoleUser, scopedUser, managedAdminUser]) {
      await deleteUser(page, user.username)
    }
  } finally {
    await deleteBindingGroup(request, groupId)
    for (const id of userIds) {
      await deleteUserById(request, id)
    }
  }
})
