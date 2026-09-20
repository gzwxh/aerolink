import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Locator,
  type Page,
} from '@playwright/test'

import { e2eContextName, e2eNodeName } from '../env'

/**
 * 节点运维冒烟测试：停止/恢复调度（cordon / uncordon）、污点、标签。
 *
 * 运行（对已有集群、真实 K8s）：
 *   make e2e-run-existing KUBECONFIG=~/.kube/config E2E_NODE_NAME=<node> \
 *     SPEC="specs/node-operations.spec.ts"
 *
 * 说明：
 *   - 刻意不测「驱逐（Drain）」：本集群多为单节点，驱逐会赶走业务 Pod。
 *   - 污点用 PreferNoSchedule（软性），即使清理失败也不会挡住新 Pod 调度；
 *     每个用例的 finally 都会通过接口把改动删干净。
 *   - 用例只动 node1 这个节点的调度标记 / 污点 / 标签，不删节点。
 */

const cluster = e2eContextName
const apiBase = `/api/v1/_clusters/${encodeURIComponent(cluster)}`
const nodePath = `${apiBase}/nodes/_all/${encodeURIComponent(e2eNodeName)}`

const TAINT_KEY = 'zz-e2e-taint'
const LABEL_KEY = 'zz-e2e-label'

interface NodeObject {
  metadata: { name?: string; labels?: Record<string, string> }
  spec: {
    unschedulable?: boolean
    taints?: Array<{ key: string; value?: string; effect?: string }>
  }
}

async function expectJSON<T>(response: APIResponse, status: number) {
  const text = await response.text()
  expect(response.status(), text).toBe(status)
  return JSON.parse(text) as T
}

async function getNode(request: APIRequestContext) {
  return expectJSON<NodeObject>(await request.get(nodePath), 200)
}

/** 恢复调度：cordon / uncordon 都是 PUT（POST 会 404，之前 cleanup 因此静默失效）。 */
async function setUnschedulable(
  request: APIRequestContext,
  unschedulable: boolean
): Promise<void> {
  const action = unschedulable ? 'cordon' : 'uncordon'
  await request.put(`${nodePath}/${action}`).catch(() => undefined)
}

async function isUnschedulable(request: APIRequestContext): Promise<boolean> {
  return (await getNode(request)).spec.unschedulable ?? false
}

/** 通过接口兜底：恢复调度 + 清掉用例写入的污点 / 标签。 */
async function restoreNode(request: APIRequestContext): Promise<void> {
  await setUnschedulable(request, false)

  const node = await getNode(request).catch(() => undefined)
  if (!node) return

  let changed = false
  if (node.spec.taints?.some((taint) => taint.key === TAINT_KEY)) {
    node.spec.taints = node.spec.taints.filter(
      (taint) => taint.key !== TAINT_KEY
    )
    changed = true
  }
  if (node.metadata.labels?.[LABEL_KEY] !== undefined) {
    delete node.metadata.labels[LABEL_KEY]
    changed = true
  }
  if (changed) {
    await request.put(nodePath, { data: node }).catch(() => undefined)
  }
}

async function openNodeRowAction(page: Page, action: string) {
  await page.goto('/nodes')
  const row = page.locator('table tbody tr').first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.getByRole('button', { name: 'Actions' }).click()
  await page.getByRole('menuitem', { name: action, exact: true }).click()
}

function nodeEditDialog(page: Page) {
  return page.getByRole('dialog', {
    name: new RegExp(`Edit node: ${e2eNodeName}`),
  })
}

/**
 * 按首列输入框的当前值找行：kv / 污点行都是「键, 值, …」结构，键在第一个 input。
 * 不能用属性选择器：React 受控 input 不会把值写回 value 属性。
 */
async function rowByFirstInput(scope: Locator, value: string) {
  const rows = scope.locator('div.grid')
  const count = await rows.count()
  for (let index = 0; index < count; index++) {
    const row = rows.nth(index)
    const input = row.locator('input').first()
    if ((await input.count()) === 0) continue
    if ((await input.inputValue()) === value) return row
  }
  throw new Error(`row with first input ${value} not found`)
}

test.describe('node operations', () => {
  test('cordon and uncordon the node', async ({ page, request }) => {
    try {
      await setUnschedulable(request, false)
      expect(await isUnschedulable(request)).toBe(false)

      // 菜单项文案跟着节点状态走：可调度时是 Cordon，不可调度时是 Uncordon。
      await openNodeRowAction(page, 'Cordon')
      await expect
        .poll(async () => isUnschedulable(request), {
          timeout: 30_000,
          message: 'node should become unschedulable',
        })
        .toBe(true)

      await openNodeRowAction(page, 'Uncordon')
      await expect
        .poll(async () => isUnschedulable(request), {
          timeout: 30_000,
          message: 'node should become schedulable again',
        })
        .toBe(false)
    } finally {
      await restoreNode(request)
    }
  })

  test('adds and removes a taint through the node edit dialog', async ({
    page,
    request,
  }) => {
    try {
      await openNodeRowAction(page, 'Edit')
      const dialog = nodeEditDialog(page)
      await expect(dialog).toBeVisible()

      await dialog.getByRole('button', { name: 'Add Taint' }).click()
      const taintRow = dialog.locator('div.grid').last()
      await taintRow.locator('input').nth(0).fill(TAINT_KEY)
      await taintRow.locator('input').nth(1).fill('zz-e2e')
      await taintRow.getByRole('combobox').click()
      await page.getByRole('option', { name: 'PreferNoSchedule' }).click()
      await dialog.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(dialog).toBeHidden({ timeout: 30_000 })

      const created = await getNode(request)
      expect(created.spec.taints?.map((taint) => taint.key)).toContain(
        TAINT_KEY
      )
      expect(
        created.spec.taints?.find((taint) => taint.key === TAINT_KEY)
      ).toMatchObject({
        effect: 'PreferNoSchedule',
      })

      // 再进一次弹窗，把刚加的污点删掉。
      await openNodeRowAction(page, 'Edit')
      const dialog2 = nodeEditDialog(page)
      await expect(dialog2).toBeVisible()
      const taintsTab = dialog2.locator('[data-slot="tabs-content"]:visible')
      const row = await rowByFirstInput(taintsTab, TAINT_KEY)
      await row.getByRole('button', { name: 'Remove' }).click()
      await dialog2.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(dialog2).toBeHidden({ timeout: 30_000 })

      await expect
        .poll(
          async () =>
            (await getNode(request)).spec.taints?.map((taint) => taint.key) ??
            [],
          { timeout: 30_000, message: 'taint should be gone' }
        )
        .not.toContain(TAINT_KEY)
    } finally {
      await restoreNode(request)
    }
  })

  test('adds and removes a label through the node edit dialog', async ({
    page,
    request,
  }) => {
    try {
      await openNodeRowAction(page, 'Edit')
      const dialog = nodeEditDialog(page)
      await expect(dialog).toBeVisible()
      await dialog.getByRole('tab', { name: 'Labels & Annotations' }).click()

      const labelsSection = dialog
        .locator('div.space-y-3')
        .filter({ hasText: 'Add Label' })
      await labelsSection.getByRole('button', { name: 'Add Label' }).click()
      const newRow = labelsSection.locator('div.grid').last()
      await newRow.locator('input').nth(0).fill(LABEL_KEY)
      await newRow.locator('input').nth(1).fill('yes')
      await dialog.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(dialog).toBeHidden({ timeout: 30_000 })

      const created = await getNode(request)
      expect(created.metadata.labels?.[LABEL_KEY]).toBe('yes')

      await openNodeRowAction(page, 'Edit')
      const dialog2 = nodeEditDialog(page)
      await expect(dialog2).toBeVisible()
      await dialog2.getByRole('tab', { name: 'Labels & Annotations' }).click()
      const labelsSection2 = dialog2
        .locator('div.space-y-3')
        .filter({ hasText: 'Add Label' })
      const labelRow = await rowByFirstInput(labelsSection2, LABEL_KEY)
      await labelRow.getByRole('button').click()
      await dialog2.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(dialog2).toBeHidden({ timeout: 30_000 })

      await expect
        .poll(
          async () => (await getNode(request)).metadata.labels?.[LABEL_KEY],
          { timeout: 30_000, message: 'label should be gone' }
        )
        .toBeUndefined()
    } finally {
      await restoreNode(request)
    }
  })
})

test.afterAll(async ({ request }) => {
  await restoreNode(request)
})
