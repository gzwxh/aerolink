import {
  expect,
  test,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test'

import { englishStorageState, kindClusterName } from '../env'

const cluster = kindClusterName
const clusterPath = `/api/v1/_clusters/${encodeURIComponent(cluster)}`

// 权限绑定组内被授权的命名空间，以及组外的对照命名空间。
const grantedNamespace = 'kube-system'
const deniedNamespace = 'default'

async function expectJSON<T>(response: APIResponse, status: number) {
  const text = await response.text()
  expect(response.status(), text).toBe(status)
  return JSON.parse(text) as T
}

async function expectStatus(response: APIResponse, status: number) {
  const text = await response.text()
  expect(response.status(), text).toBe(status)
}

async function createPasswordUser(
  page: Page,
  username: string,
  password: string
) {
  await page.goto('/settings/user?tab=users')
  await expect(
    page.getByRole('heading', { name: 'System Settings' })
  ).toBeVisible()

  await page.getByRole('button', { name: 'Add Password User' }).click()

  const dialog = page.getByRole('dialog', { name: 'New user' })
  await expect(dialog).toBeVisible()

  await dialog.getByLabel(/^Username/).fill(username)
  await dialog.getByLabel(/^Name$/).fill('E2E RBAC User')
  await dialog.getByLabel(/^Password/).fill(password)
  await dialog.getByRole('button', { name: 'Create' }).click()

  await expect(dialog).toBeHidden()
  await expect(
    page.getByRole('row').filter({ hasText: username })
  ).toBeVisible()
}

// 角色只定义「资源 + 操作」：这里选 configmaps + Get。
// 生效范围（集群 + 命名空间）由权限绑定决定，所以这个用例下一步会建权限绑定。
async function createCustomRole(page: Page, roleName: string) {
  await page.goto('/settings/rbac?rbacTab=roles')

  await page.getByRole('button', { name: 'Create Role' }).click()
  const dialog = page.getByRole('dialog', { name: 'New Role' })
  await expect(dialog).toBeVisible()

  await dialog.getByLabel(/^Role ID \*$/).fill(roleName)
  await dialog
    .getByLabel('Description')
    .fill('configmaps:get, scoped by a permission binding')

  // 「权限」穿梭框：一条权限 = 一个资源上的一个操作，权限串形如 k8s:configmaps:get。
  // 过滤到 configmaps 的 Get 后直接搬过来（「可用」在左侧，双击也能搬）。
  await dialog.getByPlaceholder('Filter (e.g. pods)').fill('configmaps:get')
  // 条目渲染成「名称 + 权限 ID + 范围徽标」，可访问名是三者拼接，
  // 所以 "Get" 后面没有词边界，/^ConfigMaps · Get\b/ 匹配不上。
  // 「可用」在左侧：单击选中、双击直接搬到「已赋予」（只单击不会产生授权，保存会被拒绝）。
  await dialog
    .getByRole('button', { name: /^ConfigMaps · Get/ })
    .first()
    .dblclick()

  await dialog.getByRole('button', { name: 'Save Role' }).click()
  await expect(dialog).toBeHidden()

  // 角色出现在列表里。表格列为「角色 ID / 名称 / 类型 / 描述 / 操作」，不再单列权限摘要，
  // 所以「搬过去的权限确实落库了」改由下一步的接口断言验证。
  const row = page.getByRole('row').filter({ hasText: roleName })
  await expect(row).toBeVisible()
}

test('custom role is granted inside a permission binding namespace and denied outside', async ({
  browser,
  page,
  request,
}) => {
  const suffix = Date.now().toString(36)
  const username = `e2e-rbac-user-${suffix}`
  const password = 'E2Epass!2345'
  const roleName = `e2e-rbac-role-${suffix}`
  const groupName = `e2e-rbac-group-${suffix}`

  let groupId: number | undefined
  let roleId: number | undefined
  let userId: number | undefined
  let userContext: BrowserContext | undefined

  try {
    await test.step('create the password user from the users page', async () => {
      await createPasswordUser(page, username, password)

      const users = await expectJSON<{
        users: Array<{ id: number; username: string }>
      }>(
        await request.get(
          `/api/v1/admin/users/?search=${encodeURIComponent(username)}`
        ),
        200
      )
      userId = users.users.find((user) => user.username === username)?.id
      expect(
        userId,
        'the new user should be queryable through the API'
      ).toBeTruthy()
    })

    await test.step('create the custom role from the roles page', async () => {
      await createCustomRole(page, roleName)

      const roles = await expectJSON<{
        roles: Array<{
          id: number
          name: string
          clusters: string[]
          resources: string[]
          verbs: string[]
        }>
      }>(await request.get('/api/v1/admin/roles/'), 200)
      const created = roles.roles.find((role) => role.name === roleName)
      expect(created, 'the new role should be listed').toBeTruthy()
      // 角色是全局的：不再带集群属性。
      expect(created?.clusters).toEqual(['*'])
      // 搬运过来的权限确实落库了（roles.resources / verbs 是 grants 的并集）。
      expect(created?.resources).toEqual(['configmaps'])
      expect(created?.verbs).toEqual(['get'])
      roleId = created?.id
    })

    // 权限绑定把「角色」与「集群 + 命名空间 + 主体」绑在一起。绑定弹窗自己的交互
    // 不在这个用例的覆盖范围内，所以这里用接口建授权，重点验证授权效果。
    await test.step('bind the role to the user for one namespace', async () => {
      const created = await expectJSON<{ bindingGroup: { id: number } }>(
        await request.post('/api/v1/admin/binding-groups/', {
          data: { cluster, name: groupName, description: 'e2e rbac scope' },
        }),
        201
      )
      groupId = created.bindingGroup.id

      await expectStatus(
        await request.put(
          `/api/v1/admin/binding-groups/${groupId}/namespaces`,
          {
            data: { namespaces: [grantedNamespace] },
          }
        ),
        200
      )
      await expectStatus(
        await request.put(`/api/v1/admin/binding-groups/${groupId}/members`, {
          data: {
            members: [
              {
                subjectType: 'user',
                subject: username,
                // 空字符串 = 组内全部命名空间。
                namespace: '',
                roleIds: [roleId],
              },
            ],
          },
        }),
        200
      )
    })

    userContext = await browser.newContext({
      storageState: englishStorageState(),
    })
    const userPage = await userContext.newPage()

    await userPage.goto('/login')
    await userPage.getByLabel('Username').fill(username)
    await userPage.getByLabel('Password', { exact: true }).fill(password)
    await userPage
      .getByRole('button', { name: 'Sign In with Password' })
      .click()
    await userPage.waitForURL((url) => url.pathname === '/')

    await test.step('cluster-scoped resources stay denied in the UI', async () => {
      await userPage.goto('/nodes')
      await expect(
        userPage.getByRole('heading', { name: /error loading/i })
      ).toBeVisible()
      await expect(
        userPage.getByText(new RegExp(`User ${username}`, 'i'))
      ).toBeVisible()
      await expect(
        userPage.getByText(/does not have permission/i)
      ).toBeVisible()
    })

    await test.step('API access follows the permission binding scope', async () => {
      const headers = { 'x-cluster-name': cluster }

      // 组内命名空间：放行。
      await expectStatus(
        await userPage.request.get(
          `${clusterPath}/configmaps/${grantedNamespace}`,
          { headers }
        ),
        200
      )

      // 组外命名空间：拒绝。
      await expectStatus(
        await userPage.request.get(
          `${clusterPath}/configmaps/${deniedNamespace}`,
          {
            headers,
          }
        ),
        403
      )

      // 集群级资源：该角色是「指名资源」授权（只给了 configmaps），权限绑定不放行；
      // 只有资源通配 * 的授权（k8s:*:get 等）才覆盖整个集群。
      await expectStatus(
        await userPage.request.get(`${clusterPath}/nodes`, { headers }),
        403
      )

      // 命名空间列表：成员必须能拿到，且只包含绑定组内的命名空间
      //（列表 handler 逐项按 CanAccessNamespace 过滤）。
      const namespaces = await expectJSON<{
        items: Array<{ metadata: { name: string } }>
      }>(await userPage.request.get('/api/v1/namespaces', { headers }), 200)
      expect(namespaces.items.map((item) => item.metadata.name)).toEqual([
        grantedNamespace,
      ])
    })
  } finally {
    await userContext?.close()
    if (groupId !== undefined) {
      await request.delete(`/api/v1/admin/binding-groups/${groupId}`)
    }
    if (roleId !== undefined) {
      await request.delete(`/api/v1/admin/roles/${roleId}`)
    }
    if (userId !== undefined) {
      await request.delete(`/api/v1/admin/users/${userId}`)
    }
  }
})
