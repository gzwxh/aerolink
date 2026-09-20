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
  toggleUserEnabled,
} from '../support/users'

test('password user can be disabled, re-enabled, and deleted', async ({
  browser,
  page,
  request,
}) => {
  const suffix = Date.now().toString(36)
  const user = {
    username: `e2e-disabled-${suffix}`,
    name: 'E2E Disabled',
    password: 'E2Epass!2345',
  }
  const groupName = `e2e-disabled-scope-${suffix}`

  let groupId: number | undefined
  let userId: number | undefined

  try {
    await openUsersPage(page)
    const origin = new URL(page.url()).origin

    await createPasswordUser(page, user.username, user.name, user.password)
    userId = await findUserId(request, user.username)

    // 授权：账号需要「有授权才能登录」，这里给它一个命名空间范围的 viewer。
    groupId = await grantRoleInNamespace(request, {
      cluster: kindClusterName,
      groupName,
      roleName: 'viewer',
      namespace: 'default',
      subject: user.username,
    })

    const firstSession = await loginFreshContext(
      browser,
      origin,
      user.username,
      user.password
    )
    await firstSession.context.close()

    await openUsersPage(page)
    await toggleUserEnabled(page, user.username, 'Disable')

    // 停用后登录被拒（与「无授权」同一句提示）。
    const disabledSession = await loginExpectingFailure(
      browser,
      origin,
      user.username,
      user.password
    )
    await disabledSession.context.close()

    await openUsersPage(page)
    await toggleUserEnabled(page, user.username, 'Enable')

    const secondSession = await loginFreshContext(
      browser,
      origin,
      user.username,
      user.password
    )
    await secondSession.context.close()

    await openUsersPage(page)
    await deleteUser(page, user.username)
  } finally {
    await deleteBindingGroup(request, groupId)
    await deleteUserById(request, userId)
  }
})
