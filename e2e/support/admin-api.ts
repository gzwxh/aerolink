import {
  expect,
  type APIRequestContext,
  type APIResponse,
} from '@playwright/test'

// 管理员接口的小工具集合：这些用例需要「先有授权，再验证界面」，
// 而授权现在由权限绑定（或直接分配角色）表达，界面上没有对应的快捷入口。

export async function expectJSON<T>(response: APIResponse, status: number) {
  const text = await response.text()
  expect(response.status(), text).toBe(status)
  return JSON.parse(text) as T
}

export async function expectStatus(response: APIResponse, status: number) {
  const text = await response.text()
  expect(response.status(), text).toBe(status)
}

export async function findRoleId(
  api: APIRequestContext,
  roleName: string
): Promise<number> {
  const roles = await expectJSON<{
    roles: Array<{ id: number; name: string }>
  }>(await api.get('/api/v1/admin/roles/'), 200)
  const role = roles.roles.find((item) => item.name === roleName)
  expect(role, `built-in role ${roleName} should exist`).toBeTruthy()
  return role!.id
}

/**
 * 直接把角色分配给用户 / 用户组（`POST /roles/:id/assign`）。
 *
 * 角色是全局的：这样分配出来的角色对全部集群生效，等价于改造前
 * 「用户页 → 分配角色」的语义。首次分配返回 201，重复分配返回 200。
 */
export async function assignRoleDirectly(
  api: APIRequestContext,
  options: {
    roleName: string
    subject: string
    subjectType?: 'user' | 'group'
  }
) {
  const roleId = await findRoleId(api, options.roleName)
  const response = await api.post(`/api/v1/admin/roles/${roleId}/assign`, {
    data: {
      subjectType: options.subjectType ?? 'user',
      subject: options.subject,
    },
  })
  const text = await response.text()
  expect([200, 201], text).toContain(response.status())
}

/**
 * 建一个只含 `namespace` 的权限绑定，并把角色通过成员绑定给主体。
 * 返回绑定组 id，供用例收尾时删除。
 */
export async function grantRoleInNamespace(
  api: APIRequestContext,
  options: {
    cluster: string
    groupName: string
    roleName: string
    namespace: string
    subject: string
    subjectType?: 'user' | 'group'
  }
): Promise<number> {
  const roleId = await findRoleId(api, options.roleName)

  const created = await expectJSON<{ bindingGroup: { id: number } }>(
    await api.post('/api/v1/admin/binding-groups/', {
      data: {
        cluster: options.cluster,
        name: options.groupName,
        description: 'e2e authorization scope',
      },
    }),
    201
  )
  const groupId = created.bindingGroup.id

  await expectStatus(
    await api.put(`/api/v1/admin/binding-groups/${groupId}/namespaces`, {
      data: { namespaces: [options.namespace] },
    }),
    200
  )
  await expectStatus(
    await api.put(`/api/v1/admin/binding-groups/${groupId}/members`, {
      data: {
        members: [
          {
            subjectType: options.subjectType ?? 'user',
            subject: options.subject,
            // 空字符串 = 组内全部命名空间。
            namespace: '',
            roleIds: [roleId],
          },
        ],
      },
    }),
    200
  )
  return groupId
}

export async function deleteBindingGroup(
  api: APIRequestContext,
  groupId: number | undefined
) {
  if (groupId === undefined) return
  await api.delete(`/api/v1/admin/binding-groups/${groupId}`)
}

export async function findUserId(
  api: APIRequestContext,
  username: string
): Promise<number | undefined> {
  const users = await expectJSON<{
    users: Array<{ id: number; username: string }>
  }>(
    await api.get(
      `/api/v1/admin/users/?search=${encodeURIComponent(username)}`
    ),
    200
  )
  return users.users.find((user) => user.username === username)?.id
}

export async function deleteUserById(
  api: APIRequestContext,
  userId: number | undefined
) {
  if (userId === undefined) return
  await api.delete(`/api/v1/admin/users/${userId}`)
}
