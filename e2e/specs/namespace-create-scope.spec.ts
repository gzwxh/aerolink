import { expect, test } from "@playwright/test";

import { e2eContextName } from "../env";
import {
  deleteBindingGroup,
  deleteUserById,
  expectJSON,
  expectStatus,
  findUserId,
} from "../support/admin-api";
import {
  createPasswordUser,
  loginFreshContext,
  openUsersPage,
} from "../support/users";

const cluster = e2eContextName;
const clusterPath = `/api/v1/_clusters/${encodeURIComponent(cluster)}`;
// 集群级资源的命名空间段用 `_all` 占位（见 pkg/middleware/rbac.go 的 url2namespaceresource）。
const clusterScopedPath = `${clusterPath}/namespaces/_all`;

const adminHeaders = { "x-cluster-name": cluster };
const memberHeaders = { "x-cluster-name": cluster };

function namespaceBody(name: string) {
  return { apiVersion: "v1", kind: "Namespace", metadata: { name } };
}

/**
 * 「创建命名空间只归管理员」的端到端覆盖。口径见
 * docs/dev/plans/2026-09-20-namespace-create-admin-only.md：
 * 命名空间统一由管理员创建，再通过权限绑定组分配给用户使用。因此角色里即便显式写了
 * namespaces + create 也不授予创建（界面入口也不出现），而组内其它授权照旧生效。
 */
test("a namespace-scoped member cannot create a namespace", async ({
  browser,
  page,
  request,
}) => {
  const suffix = Date.now().toString(36);
  const username = `e2e-nscreate-user-${suffix}`;
  const password = "E2Epass!2345";
  const roleName = `e2e-nscreate-role-${suffix}`;
  const groupName = `e2e-nscreate-group-${suffix}`;
  const memberNamespace = `zz-e2e-ns-${suffix}`;
  const adminNamespace = `zz-e2e-admin-ns-${suffix}`;

  let roleId: number | undefined;
  let groupId: number | undefined;
  let userId: number | undefined;

  try {
    await openUsersPage(page);
    const origin = new URL(page.url()).origin;

    await test.step("create the password user", async () => {
      await createPasswordUser(page, username, "E2E NS Create User", password);
      userId = await findUserId(request, username);
      expect(userId, "the new user should be queryable").toBeTruthy();
    });

    await test.step("grant namespace creation and reads through a permission binding", async () => {
      // 角色刻意写成旧口径下「能建命名空间」的形状：显式点名 namespaces 且带 create。
      const role = await expectJSON<{ role: { id: number } }>(
        await request.post("/api/v1/admin/roles/", {
          data: {
            name: roleName,
            description: "tries to create namespaces via a permission binding",
            grants: [{ resource: "namespaces", verbs: ["create", "get"] }],
          },
        }),
        201,
      );
      roleId = role.role.id;

      const group = await expectJSON<{ bindingGroup: { id: number } }>(
        await request.post("/api/v1/admin/binding-groups/", {
          data: {
            cluster,
            name: groupName,
            description: "e2e namespace creation denial",
          },
        }),
        201,
      );
      groupId = group.bindingGroup.id;

      // 组内先给一个命名空间，用来验证组内其它授权没有被这次收紧影响。
      await expectStatus(
        await request.put(
          `/api/v1/admin/binding-groups/${groupId}/namespaces`,
          {
            data: { namespaces: [memberNamespace] },
          },
        ),
        200,
      );
      await expectStatus(
        await request.put(`/api/v1/admin/binding-groups/${groupId}/members`, {
          data: {
            members: [
              {
                subjectType: "user",
                subject: username,
                // 空字符串 = 组内全部命名空间。
                namespace: "",
                roleIds: [roleId],
              },
            ],
          },
        }),
        200,
      );

      // 组内那个命名空间先由管理员建出来（这正是新的正常工作流：管理员创建 → 授权）。
      await expectStatus(
        await request.post(clusterScopedPath, {
          headers: adminHeaders,
          data: namespaceBody(memberNamespace),
        }),
        201,
      );
    });

    const session = await loginFreshContext(
      browser,
      origin,
      username,
      password,
    );
    const userPage = session.page;

    try {
      await test.step("the namespace page offers no create entry", async () => {
        await userPage.goto(`${origin}/namespaces`);
        await expect(userPage.getByRole("heading").first()).toBeVisible();
        await expect(
          userPage.getByRole("button", { name: "Create", exact: true }),
        ).toHaveCount(0);
      });

      await test.step("the API rejects the creation with 403", async () => {
        await expectStatus(
          await userPage.request.post(clusterScopedPath, {
            headers: memberHeaders,
            data: namespaceBody(adminNamespace),
          }),
          403,
        );
      });

      await test.step("the namespace was not created", async () => {
        // 用管理员视角确认集群里没有这个命名空间。
        await expectStatus(
          await request.get(`${clusterScopedPath}/${adminNamespace}`, {
            headers: adminHeaders,
          }),
          404,
        );
      });

      await test.step("the binding group still grants the reads it did grant", async () => {
        await expectStatus(
          await userPage.request.get(
            `${clusterPath}/namespaces/_all/${memberNamespace}`,
            { headers: memberHeaders },
          ),
          200,
        );
      });
    } finally {
      await session.context.close();
    }
  } finally {
    await request
      .delete(`${clusterScopedPath}/${adminNamespace}`, {
        headers: adminHeaders,
      })
      .catch(() => undefined);
    await request
      .delete(`${clusterScopedPath}/${memberNamespace}`, {
        headers: adminHeaders,
      })
      .catch(() => undefined);
    await deleteBindingGroup(request, groupId);
    if (roleId !== undefined) {
      await request
        .delete(`/api/v1/admin/roles/${roleId}`)
        .catch(() => undefined);
    }
    await deleteUserById(request, userId);
  }
});
