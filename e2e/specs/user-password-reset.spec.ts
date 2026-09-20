import { test } from '@playwright/test'

import { kindClusterName } from '../env'
import {
  deleteBindingGroup,
  deleteUserById,
  findUserId,
  grantRoleInNamespace,
} from '../support/admin-api'
import {
  createPasswordUser,
  deleteUser,
  loginExpectingFailure,
  loginFreshContext,
  openUsersPage,
  resetPassword,
} from '../support/users'

test('password reset updates login credentials', async ({
  browser,
  page,
  request,
}) => {
  const suffix = Date.now().toString(36)
  const user = {
    username: `e2e-reset-${suffix}`,
    name: 'E2E Reset User',
    originalPassword: 'E2Epass!2345',
    newPassword: 'E2Epass!6789',
  }
  const groupName = `e2e-reset-scope-${suffix}`

  let groupId: number | undefined
  let userId: number | undefined

  try {
    await openUsersPage(page)
    const origin = new URL(page.url()).origin

    await createPasswordUser(
      page,
      user.username,
      user.name,
      user.originalPassword
    )
    userId = await findUserId(request, user.username)

    // 授权：账号需要「有授权才能登录」，这里给它一个命名空间范围的 viewer。
    groupId = await grantRoleInNamespace(request, {
      cluster: kindClusterName,
      groupName,
      roleName: 'viewer',
      namespace: 'default',
      subject: user.username,
    })

    const originalSession = await loginFreshContext(
      browser,
      origin,
      user.username,
      user.originalPassword
    )
    await originalSession.context.close()

    await openUsersPage(page)
    await resetPassword(page, user.username, user.newPassword)

    const oldPasswordSession = await loginExpectingFailure(
      browser,
      origin,
      user.username,
      user.originalPassword,
      // 该场景下界面渲染自己的一份文案，而不是 API 返回的消息。
      'Invalid username or password'
    )
    await oldPasswordSession.context.close()

    const newPasswordSession = await loginFreshContext(
      browser,
      origin,
      user.username,
      user.newPassword
    )
    await newPasswordSession.context.close()

    await openUsersPage(page)
    await deleteUser(page, user.username)
  } finally {
    await deleteBindingGroup(request, groupId)
    await deleteUserById(request, userId)
  }
})
