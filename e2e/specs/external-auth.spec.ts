import { expect, test, type Browser, type Page } from '@playwright/test'

import { clusterPathPattern } from '../support/cluster-url'
import { authFile, e2eBaseUrl, e2eContextName, englishStorageState } from '../env'

const baseURL = e2eBaseUrl
const ldapURL = process.env.AEROLINK_E2E_LDAP_URL
const oauthIssuer = process.env.AEROLINK_E2E_OAUTH_ISSUER

const ldapUser = {
  username: 'ldap-e2e',
  password: 'AeroLinkLDAP!2345',
  provider: 'ldap',
}

const oauthUser = {
  username: 'oauth-e2e',
  password: 'AeroLinkOAuth!2345',
  provider: 'dex',
}

const oauthUserWithoutGroup = {
  username: 'oauth-no-group',
  password: 'AeroLinkOAuthNoGroup!2345',
}

const restrictedOAuthProvider = {
  name: 'dex-allowed',
  allowedGroups: 'e2e-viewers',
}

const usernameClaimOAuthProvider = {
  name: 'dex-name-username',
  usernameClaim: 'name',
}

const customGroupClaimOAuthProvider = {
  name: 'dex-name-group',
  groupsClaim: 'name',
  allowedGroups: 'OAuth E2E',
}

// 外部身份（LDAP / OIDC 用户组）通过**权限绑定**拿到 viewer：
// 绑定组 = 集群 + 命名空间（local-path-storage，避开其它用例占用的 default）+ 成员（用户组 × 角色）。
// 绑定对象是用户组，所以成员的增删完全由目录维护，鸢联 AeroLink 侧不需要跟着改。
const externalBinding = {
  name: 'e2e-external-scope',
  namespace: 'local-path-storage',
  groups: ['e2e-viewers', 'OAuth E2E'],
}

async function openAnonymousPage(browser: Browser) {
  const context = await browser.newContext({
    baseURL,
    storageState: englishStorageState(baseURL),
  })
  const page = await context.newPage()
  return { context, page }
}

async function openUserMenu(page: Page) {
  await page.locator('header').getByRole('button').last().click()
}

async function fetchCurrentUser(page: Page) {
  return page.evaluate(async () => {
    const response = await fetch('/api/auth/user', {
      credentials: 'include',
    })
    if (!response.ok) {
      throw new Error(`Failed to fetch current user: ${response.status}`)
    }
    const data = await response.json()
    return data.user as {
      username: string
      provider: string
      oidc_groups?: string[]
    }
  })
}

async function expectSignedInUser(
  page: Page,
  username: string,
  provider: string
) {
  await page.waitForURL((url) => clusterPathPattern('/').test(url.pathname))

  // 授权效果：外部账号只被绑定到一个命名空间，命名空间列表就该只有它。
  // （权限绑定组的成员不持有全局角色，所以用户菜单不会出现 Role 行；
  //  概览页读的是集群级数据，对被授权范围收窄的账号不再作为断言。）
  await page.goto('/namespaces')
  await expect(
    page.getByRole('link', { name: externalBinding.namespace })
  ).toBeVisible()

  await openUserMenu(page)
  await expect(
    page
      .locator('p.text-xs.text-muted-foreground')
      .filter({ hasText: username })
      .first()
  ).toBeVisible()
  await expect(
    page
      .locator('p.text-xs.text-muted-foreground')
      .filter({ hasText: `via ${provider}` })
      .first()
  ).toBeVisible()
}

async function configureLDAPViaUI(page: Page) {
  await page.goto('/settings?tab=oauth')
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()

  // 设置页把「安全」整段包在一张外层卡片里，所以 `[data-slot="card"]` 会同时匹配外层卡片与
  // 里面的 LDAP 卡片；取最后一张（DOM 里最靠内的那张）才是 LDAP 卡片。用 .first() 会拿到外层
  // 卡片，Save 同时命中「密码登录」那张卡片里的按钮，触发 strict mode 报错。
  const ldapCard = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText(/^LDAP$/) })
    .last()
  const ldapSection = ldapCard
    .locator('div.rounded-lg.border')
    .filter({ has: page.getByText(/^LDAP$/) })
    .first()
  const ldapSwitch = ldapSection.getByRole('switch').first()
  if ((await ldapSwitch.getAttribute('data-state')) !== 'checked') {
    await ldapSwitch.click()
  }

  await page.getByLabel('Server URL').fill(ldapURL!)
  await page.getByLabel('Bind DN').fill('cn=admin,dc=aerolink,dc=test')
  await page.getByLabel('Bind Password').fill('admin')
  await page.getByLabel('User Base DN').fill('ou=users,dc=aerolink,dc=test')
  await page.getByLabel('User Filter').fill('(uid=%s)')
  await page.getByLabel('Username Attribute').fill('uid')
  await page.getByLabel('Display Name Attribute').fill('cn')
  await page.getByLabel('Group Base DN').fill('ou=groups,dc=aerolink,dc=test')
  await page.getByLabel('Group Filter').fill('(member=%s)')
  await page.getByLabel('Group Name Attribute').fill('cn')
  await ldapCard.getByRole('button', { name: 'Save' }).click()

  await expect(page.getByText('Authentication settings updated')).toBeVisible()
}

// LDAP 登录只认已在本地开通的账号：目录里存在不等于能登录
// （周期同步只对齐已导入的用户，从不开通新账号，见 pkg/auth/ldap_sync.go）。
// 因此先走一次导入接口把用例账号开通出来。这一步是夹具准备、不是被测行为
// （导入选择器自身的交互由设置页承载），所以和下面的权限绑定一样直接用接口。
async function provisionLDAPUser(page: Page) {
  const candidatesResponse = await page.request.get(
    '/api/v1/admin/ldap-setting/users'
  )
  const candidatesBody = await candidatesResponse.text()
  expect(candidatesResponse.status(), candidatesBody).toBe(200)

  const usernames = (
    JSON.parse(candidatesBody) as { users: Array<{ username: string }> }
  ).users.map((candidate) => candidate.username)
  expect(usernames, 'the LDAP fixture should expose directory users').toContain(
    ldapUser.username
  )

  const importResponse = await page.request.post(
    '/api/v1/admin/ldap-setting/users/import',
    { data: { usernames: [ldapUser.username], enableImported: true } }
  )
  expect(importResponse.status(), await importResponse.text()).toBe(200)
}

async function configureOAuthViaUI(page: Page) {
  const providerRow = page.getByRole('row').filter({ hasText: 'dex' })
  if (await providerRow.count()) {
    return
  }

  await page.getByRole('button', { name: 'Add Provider' }).click()

  const dialog = page.getByRole('dialog', { name: 'Add OAuth Provider' })
  await expect(dialog).toBeVisible()

  await dialog.getByLabel('Name *').fill('dex')
  await dialog.getByLabel('Client ID *').fill('aerolink-e2e')
  await dialog.getByLabel('Client Secret *').fill('aerolink-e2e-secret')
  await dialog.getByLabel('Issuer').fill(oauthIssuer!)
  await dialog.getByLabel('Scopes').fill('openid,profile,email,groups')
  await dialog.getByRole('button', { name: 'Create' }).click()

  await expect(providerRow).toBeVisible()
}

async function configureUsernameClaimOAuthViaUI(page: Page) {
  await page.goto('/settings?tab=oauth')
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()

  const providerRow = page
    .getByRole('row')
    .filter({ hasText: usernameClaimOAuthProvider.name })

  if (await providerRow.count()) {
    await providerRow.getByRole('button', { name: 'Actions' }).click()
    await page.getByRole('menuitem', { name: 'Edit' }).click()

    const dialog = page.getByRole('dialog', { name: 'Edit OAuth Provider' })
    await expect(dialog).toBeVisible()

    await dialog.getByLabel('Issuer').fill(oauthIssuer!)
    await dialog.getByLabel('Scopes').fill('openid,profile,email,groups')
    await dialog
      .getByLabel('Username Claim')
      .fill(usernameClaimOAuthProvider.usernameClaim)
    await dialog.getByLabel('Groups Claim').fill('')
    await dialog.getByLabel('Allowed Groups').fill('')
    await dialog.getByRole('button', { name: 'Update' }).click()

    await expect(
      page.getByText('OAuth provider updated successfully')
    ).toBeVisible()
    return
  }

  await page.getByRole('button', { name: 'Add Provider' }).click()

  const dialog = page.getByRole('dialog', { name: 'Add OAuth Provider' })
  await expect(dialog).toBeVisible()

  await dialog.getByLabel('Name *').fill(usernameClaimOAuthProvider.name)
  await dialog.getByLabel('Client ID *').fill('aerolink-e2e')
  await dialog.getByLabel('Client Secret *').fill('aerolink-e2e-secret')
  await dialog.getByLabel('Issuer').fill(oauthIssuer!)
  await dialog.getByLabel('Scopes').fill('openid,profile,email,groups')
  await dialog
    .getByLabel('Username Claim')
    .fill(usernameClaimOAuthProvider.usernameClaim)
  await dialog.getByRole('button', { name: 'Create' }).click()

  await expect(
    page.getByText('OAuth provider created successfully')
  ).toBeVisible()
  await expect(providerRow).toBeVisible()
}

async function configureRestrictedOAuthViaUI(page: Page) {
  await page.goto('/settings?tab=oauth')
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()

  const providerRow = page
    .getByRole('row')
    .filter({ hasText: restrictedOAuthProvider.name })

  if (await providerRow.count()) {
    await providerRow.getByRole('button', { name: 'Actions' }).click()
    await page.getByRole('menuitem', { name: 'Edit' }).click()

    const dialog = page.getByRole('dialog', { name: 'Edit OAuth Provider' })
    await expect(dialog).toBeVisible()

    await dialog.getByLabel('Issuer').fill(oauthIssuer!)
    await dialog.getByLabel('Scopes').fill('openid,profile,email,groups')
    await dialog
      .getByLabel('Allowed Groups')
      .fill(restrictedOAuthProvider.allowedGroups)
    await dialog.getByRole('button', { name: 'Update' }).click()

    await expect(
      page.getByText('OAuth provider updated successfully')
    ).toBeVisible()
    return
  }

  await page.getByRole('button', { name: 'Add Provider' }).click()

  const dialog = page.getByRole('dialog', { name: 'Add OAuth Provider' })
  await expect(dialog).toBeVisible()

  await dialog.getByLabel('Name *').fill(restrictedOAuthProvider.name)
  await dialog.getByLabel('Client ID *').fill('aerolink-e2e')
  await dialog.getByLabel('Client Secret *').fill('aerolink-e2e-secret')
  await dialog.getByLabel('Issuer').fill(oauthIssuer!)
  await dialog.getByLabel('Scopes').fill('openid,profile,email,groups')
  await dialog
    .getByLabel('Allowed Groups')
    .fill(restrictedOAuthProvider.allowedGroups)
  await dialog.getByRole('button', { name: 'Create' }).click()

  await expect(providerRow).toBeVisible()
}

async function configureCustomGroupClaimOAuthViaUI(page: Page) {
  await page.goto('/settings?tab=oauth')
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()

  const providerRow = page
    .getByRole('row')
    .filter({ hasText: customGroupClaimOAuthProvider.name })

  if (await providerRow.count()) {
    await providerRow.getByRole('button', { name: 'Actions' }).click()
    await page.getByRole('menuitem', { name: 'Edit' }).click()

    const dialog = page.getByRole('dialog', { name: 'Edit OAuth Provider' })
    await expect(dialog).toBeVisible()

    await dialog.getByLabel('Issuer').fill(oauthIssuer!)
    await dialog.getByLabel('Scopes').fill('openid,profile,email,groups')
    await dialog.getByLabel('Username Claim').fill('')
    await dialog
      .getByLabel('Groups Claim')
      .fill(customGroupClaimOAuthProvider.groupsClaim)
    await dialog
      .getByLabel('Allowed Groups')
      .fill(customGroupClaimOAuthProvider.allowedGroups)
    await dialog.getByRole('button', { name: 'Update' }).click()

    await expect(
      page.getByText('OAuth provider updated successfully')
    ).toBeVisible()
    return
  }

  await page.getByRole('button', { name: 'Add Provider' }).click()

  const dialog = page.getByRole('dialog', { name: 'Add OAuth Provider' })
  await expect(dialog).toBeVisible()

  await dialog.getByLabel('Name *').fill(customGroupClaimOAuthProvider.name)
  await dialog.getByLabel('Client ID *').fill('aerolink-e2e')
  await dialog.getByLabel('Client Secret *').fill('aerolink-e2e-secret')
  await dialog.getByLabel('Issuer').fill(oauthIssuer!)
  await dialog.getByLabel('Scopes').fill('openid,profile,email,groups')
  await dialog
    .getByLabel('Groups Claim')
    .fill(customGroupClaimOAuthProvider.groupsClaim)
  await dialog
    .getByLabel('Allowed Groups')
    .fill(customGroupClaimOAuthProvider.allowedGroups)
  await dialog.getByRole('button', { name: 'Create' }).click()

  await expect(
    page.getByText('OAuth provider created successfully')
  ).toBeVisible()
  await expect(providerRow).toBeVisible()
}

// 角色成员界面已收敛到权限绑定页：这里按当前模型给外部用户组建权限绑定。
// 幂等：重跑时复用已存在的绑定组，只刷新命名空间与成员。
async function grantViewerToExternalGroups(page: Page) {
  const rolesResponse = await page.request.get('/api/v1/admin/roles/')
  const rolesBody = await rolesResponse.text()
  expect(rolesResponse.status(), rolesBody).toBe(200)

  const viewer = (
    JSON.parse(rolesBody) as { roles: Array<{ id: number; name: string }> }
  ).roles.find((role) => role.name === 'viewer')
  expect(viewer, 'built-in viewer role should exist').toBeTruthy()

  const listResponse = await page.request.get(
    `/api/v1/admin/binding-groups/?cluster=${encodeURIComponent(e2eContextName)}`
  )
  const listBody = await listResponse.text()
  expect(listResponse.status(), listBody).toBe(200)

  const existing = (
    JSON.parse(listBody) as {
      bindingGroups: Array<{ id: number; name: string }>
    }
  ).bindingGroups.find((group) => group.name === externalBinding.name)

  let groupId = existing?.id
  if (groupId === undefined) {
    const createResponse = await page.request.post(
      '/api/v1/admin/binding-groups/',
      {
        data: {
          cluster: e2eContextName,
          name: externalBinding.name,
          description: 'e2e: viewer for external groups',
        },
      }
    )
    const createBody = await createResponse.text()
    expect(createResponse.status(), createBody).toBe(201)
    groupId = (JSON.parse(createBody) as { bindingGroup: { id: number } })
      .bindingGroup.id
  }

  const namespacesResponse = await page.request.put(
    `/api/v1/admin/binding-groups/${groupId}/namespaces`,
    { data: { namespaces: [externalBinding.namespace] } }
  )
  expect(namespacesResponse.status(), await namespacesResponse.text()).toBe(200)

  const membersResponse = await page.request.put(
    `/api/v1/admin/binding-groups/${groupId}/members`,
    {
      data: {
        members: externalBinding.groups.map((group) => ({
          subjectType: 'group',
          subject: group,
          // 空字符串 = 组内全部命名空间。
          namespace: '',
          roleIds: [viewer!.id],
        })),
      },
    }
  )
  expect(membersResponse.status(), await membersResponse.text()).toBe(200)
}

test.describe('external auth', () => {
  test.skip(
    !ldapURL || !oauthIssuer,
    'External auth services are not configured'
  )

  test.beforeAll(async ({ browser }) => {
    const adminContext = await browser.newContext({
      baseURL,
      storageState: authFile,
    })
    const adminPage = await adminContext.newPage()

    try {
      await configureLDAPViaUI(adminPage)
      await provisionLDAPUser(adminPage)
      await configureOAuthViaUI(adminPage)
      await configureUsernameClaimOAuthViaUI(adminPage)
      await configureRestrictedOAuthViaUI(adminPage)
      await configureCustomGroupClaimOAuthViaUI(adminPage)
      // 外部用户组的授权：一个权限绑定（命名空间 local-path-storage + viewer）。
      await grantViewerToExternalGroups(adminPage)
    } finally {
      await adminContext.close()
    }
  })

  test('signs in with LDAP credentials', async ({ browser }) => {
    const { context, page } = await openAnonymousPage(browser)

    try {
      await page.goto('/login')

      await page.getByLabel('Username').fill(ldapUser.username)
      await page.getByLabel('Password', { exact: true }).fill(ldapUser.password)
      await page.getByRole('button', { name: 'Sign In with LDAP' }).click()

      await expectSignedInUser(page, ldapUser.username, ldapUser.provider)
    } finally {
      await context.close()
    }
  })

  test('signs in through Dex OAuth', async ({ browser }) => {
    const { context, page } = await openAnonymousPage(browser)

    try {
      await page.goto('/login')

      await expect(
        page.getByRole('button', { name: /^Sign In with Dex$/i })
      ).toBeVisible()
      await page.getByRole('button', { name: /^Sign In with Dex$/i }).click()

      await expect(
        page.getByRole('heading', { name: 'Log in to Your Account' })
      ).toBeVisible()
      await page.getByLabel('Username').fill(oauthUser.username)
      await page
        .getByLabel('Password', { exact: true })
        .fill(oauthUser.password)
      await page.getByRole('button', { name: 'Login' }).click()

      await expectSignedInUser(page, oauthUser.username, oauthUser.provider)
    } finally {
      await context.close()
    }
  })

  test('signs in through Dex OAuth with usernameClaim override', async ({
    browser,
  }) => {
    const { context, page } = await openAnonymousPage(browser)

    try {
      await page.goto('/login')

      await expect(
        page.getByRole('button', {
          name: /^Sign In with Dex-name-username$/i,
        })
      ).toBeVisible()
      await page
        .getByRole('button', {
          name: /^Sign In with Dex-name-username$/i,
        })
        .click()

      await expect(
        page.getByRole('heading', { name: 'Log in to Your Account' })
      ).toBeVisible()
      await page.getByLabel('Username').fill(oauthUser.username)
      await page
        .getByLabel('Password', { exact: true })
        .fill(oauthUser.password)
      await page.getByRole('button', { name: 'Login' }).click()

      await expectSignedInUser(
        page,
        'OAuth E2E',
        usernameClaimOAuthProvider.name
      )

      const currentUser = await fetchCurrentUser(page)
      expect(currentUser.username).toBe('OAuth E2E')
      expect(currentUser.provider).toBe(usernameClaimOAuthProvider.name)
    } finally {
      await context.close()
    }
  })

  test('rejects LDAP credentials with the wrong password', async ({
    browser,
  }) => {
    const { context, page } = await openAnonymousPage(browser)

    try {
      await page.goto('/login')

      await page.getByLabel('Username').fill(ldapUser.username)
      await page.getByLabel('Password', { exact: true }).fill('wrong-password')
      await page.getByRole('button', { name: 'Sign In with LDAP' }).click()

      await expect(page).toHaveURL(/\/login/)
      // 界面按后端错误码本地化（login_invalid_credentials → “Invalid username or
      // password”），不再回显服务端的原始错误文本。
      await expect(page.getByRole('alert')).toContainText(
        'Invalid username or password'
      )
    } finally {
      await context.close()
    }
  })

  test('rejects Dex OAuth users without a mapped group', async ({
    browser,
  }) => {
    const { context, page } = await openAnonymousPage(browser)

    try {
      await page.goto('/login')

      await expect(
        page.getByRole('button', { name: /^Sign In with Dex$/i })
      ).toBeVisible()
      await page.getByRole('button', { name: /^Sign In with Dex$/i }).click()

      await expect(
        page.getByRole('heading', { name: 'Log in to Your Account' })
      ).toBeVisible()
      await page.getByLabel('Username').fill(oauthUserWithoutGroup.username)
      await page
        .getByLabel('Password', { exact: true })
        .fill(oauthUserWithoutGroup.password)
      await page.getByRole('button', { name: 'Login' }).click()

      await expect(page).toHaveURL(/\/login\?/)
      await expect(page.getByRole('alert')).toContainText(
        `Access denied for user "${oauthUserWithoutGroup.username}"`
      )
      await expect(
        page.getByRole('button', { name: 'Try Again with Different Account' })
      ).toBeVisible()
    } finally {
      await context.close()
    }
  })

  test('signs in through Dex OAuth when the user is in an allowed group', async ({
    browser,
  }) => {
    const { context, page } = await openAnonymousPage(browser)

    try {
      await page.goto('/login')

      await expect(
        page.getByRole('button', { name: /^Sign In with Dex-allowed$/i })
      ).toBeVisible()
      await page
        .getByRole('button', { name: /^Sign In with Dex-allowed$/i })
        .click()

      await expect(
        page.getByRole('heading', { name: 'Log in to Your Account' })
      ).toBeVisible()
      await page.getByLabel('Username').fill(oauthUser.username)
      await page
        .getByLabel('Password', { exact: true })
        .fill(oauthUser.password)
      await page.getByRole('button', { name: 'Login' }).click()

      await expectSignedInUser(
        page,
        oauthUser.username,
        restrictedOAuthProvider.name
      )
    } finally {
      await context.close()
    }
  })

  test('signs in through Dex OAuth with groupsClaim override', async ({
    browser,
  }) => {
    const { context, page } = await openAnonymousPage(browser)

    try {
      await page.goto('/login')

      await expect(
        page.getByRole('button', {
          name: /^Sign In with Dex-name-group$/i,
        })
      ).toBeVisible()
      await page
        .getByRole('button', {
          name: /^Sign In with Dex-name-group$/i,
        })
        .click()

      await expect(
        page.getByRole('heading', { name: 'Log in to Your Account' })
      ).toBeVisible()
      await page.getByLabel('Username').fill(oauthUser.username)
      await page
        .getByLabel('Password', { exact: true })
        .fill(oauthUser.password)
      await page.getByRole('button', { name: 'Login' }).click()

      await expectSignedInUser(
        page,
        oauthUser.username,
        customGroupClaimOAuthProvider.name
      )

      const currentUser = await fetchCurrentUser(page)
      expect(currentUser.provider).toBe(customGroupClaimOAuthProvider.name)
      expect(currentUser.oidc_groups).toEqual(['OAuth E2E'])
    } finally {
      await context.close()
    }
  })

  test('rejects Dex OAuth users outside the allowed groups before RBAC', async ({
    browser,
  }) => {
    const { context, page } = await openAnonymousPage(browser)

    try {
      await page.goto('/login')

      await expect(
        page.getByRole('button', { name: /^Sign In with Dex-allowed$/i })
      ).toBeVisible()
      await page
        .getByRole('button', { name: /^Sign In with Dex-allowed$/i })
        .click()

      await expect(
        page.getByRole('heading', { name: 'Log in to Your Account' })
      ).toBeVisible()
      await page.getByLabel('Username').fill(oauthUserWithoutGroup.username)
      await page
        .getByLabel('Password', { exact: true })
        .fill(oauthUserWithoutGroup.password)
      await page.getByRole('button', { name: 'Login' }).click()

      await expect(page).toHaveURL(/\/login\?/)
      await expect(page.getByRole('alert')).toContainText(
        'Authentication succeeded, but your account is not a member of the allowed groups in dex-allowed.'
      )
      await expect(page.getByRole('alert')).toContainText(
        'Please contact your administrator to be added to an allowed group.'
      )
      await expect(
        page.getByRole('button', { name: 'Try Again with Different Account' })
      ).toBeVisible()
    } finally {
      await context.close()
    }
  })
})
