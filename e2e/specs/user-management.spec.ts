import { expect, test } from '@playwright/test'

import { deleteUserById, findUserId } from '../support/admin-api'
import { createPasswordUser, openUsersPage } from '../support/users'

test('admin can create a password user from settings', async ({
  page,
  request,
}) => {
  const username = `e2e-user-${Date.now()}`
  const displayName = 'E2E User'
  const password = 'E2Epass!2345'

  try {
    await openUsersPage(page)
    await createPasswordUser(page, username, displayName, password)
    await expect(
      page.getByRole('row').filter({ hasText: username })
    ).toBeVisible()
  } finally {
    // 收尾：把这个账号删掉，避免在 e2e 实例里堆积（界面删除路径由其它用例覆盖）。
    await deleteUserById(request, await findUserId(request, username))
  }
})
