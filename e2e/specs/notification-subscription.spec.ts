import { expect, test, type APIRequestContext } from '@playwright/test'

/**
 * 通知订阅的「全体用户」接收者。
 *
 * 订阅以前只能按「用户 / 邮箱」逐个加：要让所有人收到安全提醒，管理员得把每个账号
 * 都加一条，新入职的人还要回来补。「全体用户」在投递时展开成当时所有已启用账号
 * （语义与后端用例见 pkg/notification/service_test.go）。
 *
 * 这里走界面确认交互那条链：接收人类型选「全体用户」后不需要填接收者、添加按钮可用、
 * 提交后订阅真的落库（用管理员 API 断言）。
 *
 * 运行（对已有集群、真实 K8s）：
 *   make e2e-run-existing KUBECONFIG=~/.kube/config \
 *     E2E_CLUSTER_NAME=<context 名> E2E_CONTEXT_NAME=<context 名> E2E_NODE_NAME=<node> \
 *     SPEC="specs/notification-subscription.spec.ts"
 */

const subscriptionsPath = '/api/v1/admin/notification-subscriptions/'

type Subscription = {
  id: number
  receiverType?: string
  receiver?: string
  receiverId?: number
}

async function allUsersSubscriptions(
  request: APIRequestContext
): Promise<Subscription[]> {
  const response = await request.get(subscriptionsPath).catch(() => undefined)
  if (!response?.ok()) return []
  const body = (await response.json()) as { subscriptions?: Subscription[] }
  return (body.subscriptions ?? []).filter(
    (item) => item.receiverType === 'all_users'
  )
}

async function clearAllUsersSubscriptions(request: APIRequestContext) {
  for (const item of await allUsersSubscriptions(request)) {
    await request
      .delete(`${subscriptionsPath}${item.id}`)
      .catch(() => undefined)
  }
}

test.describe('notification subscriptions', () => {
  test('an all-users subscription can be created from the settings page', async ({
    page,
    request,
  }) => {
    // 上一次失败可能留下条目，先清干净，断言才确定。
    await clearAllUsersSubscriptions(request)

    await page.goto('/settings/notification?tab=subscriptions')

    // 接收人类型下拉当前显示「User」；用它的值定位，避免和页面上的其它下拉混淆。
    await page
      .getByRole('combobox')
      .filter({ hasText: /^User$/ })
      .click()
    await page.getByRole('option', { name: 'All users' }).click()

    // 订阅按「事件 × 接收者」逐条建：勾一个事件就建一条，断言才好确定条数。
    // 事件多选默认一个都没勾（这时提交按钮是禁用的），先勾上第一个。
    await page
      .getByRole('checkbox', { name: /^Remote login notice/ })
      .check()

    const add = page.getByRole('button', { name: /^Add subscriptions \(/ })
    await expect(add).toBeEnabled()
    await add.click()

    // 落库的订阅没有具体接收者。
    await expect
      .poll(async () => (await allUsersSubscriptions(request)).length, {
        message: 'the all-users subscription was not stored',
      })
      .toBe(1)

    const [created] = await allUsersSubscriptions(request)
    expect(created.receiver).toBe('')
    expect(created.receiverId).toBe(0)
  })

  test.afterAll(async ({ request }) => {
    await clearAllUsersSubscriptions(request)
  })
})
