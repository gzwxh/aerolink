import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test'

import { e2eContextName } from '../env'

/**
 * 控制台「创建」流程的 UI 冒烟测试：走真实界面创建资源，用 API 复核结果，
 * 最后无论是成功还是失败都把创建出来的对象删掉。
 *
 * 运行（对已有集群、真实 K8s）：
 *   make e2e-run-existing KUBECONFIG=~/.kube/config E2E_NODE_NAME=<node> \
 *     SPEC="specs/resource-creation.spec.ts"
 *
 * 说明：
 *   - 资源都建在 default 命名空间，命名带 zz-e2e- 前缀，用例内自清理。
 *   - 工作负载用节点上已缓存的镜像，避免依赖外部仓库可达性（内网环境拉不到
 *     Docker Hub / registry.k8s.io）。如果集群换镜像，改 PREPULLED_IMAGE 即可。
 */

const namespace = 'default'
const cluster = e2eContextName
const clusterPath = `/api/v1/_clusters/${encodeURIComponent(cluster)}`

// 节点上已缓存的 nginx（本环境镜像统一走华为云 SWR）。
const PREPULLED_IMAGE =
  'swr.cn-south-1.myhuaweicloud.com/dsy/docker.io/library/nginx:1.30.3'

const uniqueName = (kind: string) => `zz-e2e-${kind}-${Date.now().toString(36)}`

async function expectStatus(response: APIResponse, status: number) {
  const text = await response.text()
  expect(response.status(), text).toBe(status)
}

async function expectJSON<T>(response: APIResponse, status: number) {
  const text = await response.text()
  expect(response.status(), text).toBe(status)
  return JSON.parse(text) as T
}

/** 删除某个 Job 遗留的 Pod（Job 的 Pod 带 job-name 标签）。 */
async function deleteJobPods(
  request: APIRequestContext,
  jobName: string
): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const list = await request
      .get(`${clusterPath}/pods/${namespace}`)
      .catch(() => undefined)
    if (!list?.ok()) return
    const body = (await list.json()) as {
      items?: Array<{
        metadata: { name: string; labels?: Record<string, string> }
      }>
    }
    const pods = (body.items ?? []).filter(
      (pod) => pod.metadata.labels?.['job-name'] === jobName
    )
    if (pods.length === 0) return
    for (const pod of pods) {
      await request
        .delete(`${clusterPath}/pods/${namespace}/${pod.metadata.name}`)
        .catch(() => undefined)
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

/** 创建页通用的工作负载表单：名称 + 容器（名称/镜像）。 */
async function fillWorkloadForm(page: Page, name: string) {
  await page.getByPlaceholder('unique-name').fill(name)

  // 容器面板是一个页签（早期是折叠按钮），选中后才会渲染容器名称/镜像字段。
  const containerTab = page.getByRole('tab', { name: 'container-1' }).first()
  if (await containerTab.count()) {
    await containerTab.click()
    await page.waitForTimeout(500)
  }

  // 容器名称的 Label 没有 htmlFor，只能按 DOM 结构定位（Label 的兄弟 input）。
  await page
    .locator(
      'xpath=//label[contains(normalize-space(.), "Container Name")]/following-sibling::input[1]'
    )
    .fill(name)
  await page.getByPlaceholder('nginx:latest').fill(PREPULLED_IMAGE)
}

test.describe('resource creation', () => {
  test('creates a namespace from the namespaces page', async ({
    page,
    request,
  }) => {
    const name = uniqueName('ns')
    try {
      await page.goto('/namespaces')
      await page.getByRole('button', { name: 'Create' }).first().click()

      const dialog = page.getByRole('dialog', { name: 'Create Namespace' })
      await expect(dialog).toBeVisible()
      await dialog.locator('#ns-create-name').fill(name)
      await dialog.getByRole('button', { name: 'Create' }).click()

      await expect(dialog).toBeHidden({ timeout: 20000 })
      await expect(
        page.getByText(`Namespace ${name} created`, { exact: false })
      ).toBeVisible({ timeout: 15000 })

      const created = await expectJSON<{ metadata: { name: string } }>(
        // 集群级资源的单对象路由带 _all 前缀（见 pkg/resources/handler.go）。
        await request.get(`${clusterPath}/namespaces/_all/${name}`),
        200
      )
      expect(created.metadata.name).toBe(name)
    } finally {
      await request
        .delete(`${clusterPath}/namespaces/_all/${name}`)
        .catch(() => undefined)
    }
  })

  test('creates a configmap with data from the configmap create page', async ({
    page,
    request,
  }) => {
    const name = uniqueName('cm')
    try {
      await page.goto(`/configmaps/${namespace}/create`)
      await page.locator('#configmap-name').fill(name)
      await page.getByPlaceholder('e.g. foo').first().fill('zz-key')
      await page.getByPlaceholder('e.g. bar').first().fill('zz-value')
      await page.getByRole('button', { name: 'Create ConfigMap' }).click()

      await page.waitForURL(`**/configmaps/${namespace}/${name}`, {
        timeout: 30000,
      })

      const created = await expectJSON<{ data: Record<string, string> }>(
        await request.get(`${clusterPath}/configmaps/${namespace}/${name}`),
        200
      )
      expect(created.data['zz-key']).toBe('zz-value')
    } finally {
      await request
        .delete(`${clusterPath}/configmaps/${namespace}/${name}`)
        .catch(() => undefined)
    }
  })

  test('creates a ClusterIP service from the service create page', async ({
    page,
    request,
  }) => {
    const name = uniqueName('svc')
    try {
      await page.goto(`/services/${namespace}/create`)
      await page.getByPlaceholder('my-service').fill(name)
      await page.getByPlaceholder('Port *').first().fill('8080')
      await page.getByRole('button', { name: 'Create Service' }).click()

      await page.waitForURL(`**/services/${namespace}/${name}`, {
        timeout: 30000,
      })

      const created = await expectJSON<{
        spec: { type: string; ports: Array<{ port: number }> }
      }>(await request.get(`${clusterPath}/services/${namespace}/${name}`), 200)
      expect(created.spec.ports.map((p) => p.port)).toContain(8080)
    } finally {
      await request
        .delete(`${clusterPath}/services/${namespace}/${name}`)
        .catch(() => undefined)
    }
  })

  test('creates a deployment from the workload create page', async ({
    page,
    request,
  }) => {
    const name = uniqueName('deploy')
    try {
      await page.goto(`/deployments/${namespace}/create`)
      await fillWorkloadForm(page, name)
      await page.getByRole('button', { name: 'Create Deployment' }).click()

      await page.waitForURL(`**/deployments/${namespace}/${name}`, {
        timeout: 30000,
      })

      const created = await expectJSON<{
        spec: {
          replicas: number
          template: { spec: { containers: unknown[] } }
        }
      }>(
        await request.get(`${clusterPath}/deployments/${namespace}/${name}`),
        200
      )
      expect(created.spec.replicas).toBeGreaterThan(0)
      expect(created.spec.template.spec.containers).toHaveLength(1)
    } finally {
      await request
        .delete(`${clusterPath}/deployments/${namespace}/${name}`)
        .catch(() => undefined)
    }
  })

  test('creates a CronJob that never fires from the workload create page', async ({
    page,
    request,
  }) => {
    const name = uniqueName('cron')
    try {
      await page.goto(`/cronjobs/${namespace}/create`)
      await fillWorkloadForm(page, name)
      // 2 月 31 日永远不存在，用例不会真的跑起来一个 Job。
      await page.getByPlaceholder('*/5 * * * *').fill('0 0 31 2 *')
      await page.getByRole('button', { name: 'Create CronJob' }).click()

      await page.waitForURL(`**/cronjobs/${namespace}/${name}`, {
        timeout: 30000,
      })

      const created = await expectJSON<{ spec: { schedule: string } }>(
        await request.get(`${clusterPath}/cronjobs/${namespace}/${name}`),
        200
      )
      expect(created.spec.schedule).toBe('0 0 31 2 *')
    } finally {
      await request
        .delete(`${clusterPath}/cronjobs/${namespace}/${name}`)
        .catch(() => undefined)
    }
  })

  test('creates a Job from the workload create page', async ({
    page,
    request,
  }) => {
    const name = uniqueName('job')
    try {
      await page.goto(`/jobs/${namespace}/create`)
      await fillWorkloadForm(page, name)
      await page.getByRole('button', { name: 'Create Job' }).click()

      await page.waitForURL(`**/jobs/${namespace}/${name}`, {
        timeout: 30000,
      })

      const created = await expectJSON<{
        spec: { template: { spec: { restartPolicy?: string } } }
      }>(await request.get(`${clusterPath}/jobs/${namespace}/${name}`), 200)
      // Job 的 Pod 模板必须显式给出 restartPolicy（Always 是非法值）。
      expect(created.spec.template.spec.restartPolicy).toBe('OnFailure')
    } finally {
      // Job 的 Pod 会一直跑（nginx 不退出），删除 Job 后再按 job-name 标签清一次 Pod。
      await request
        .delete(`${clusterPath}/jobs/${namespace}/${name}`)
        .catch(() => undefined)
      await deleteJobPods(request, name)
    }
  })
})

/** 用例自清理后补充一次兜底清理，避免失败时在集群里留下 zz-e2e-* 对象。 */
test.afterAll(async ({ request }) => {
  for (const kind of [
    'configmaps',
    'services',
    'deployments',
    'cronjobs',
    'jobs',
  ]) {
    const list = await request
      .get(`${clusterPath}/${kind}/${namespace}`)
      .catch(() => undefined)
    if (!list?.ok()) continue
    const body = (await list.json()) as {
      items?: Array<{ metadata: { name: string } }>
    }
    for (const item of (body.items ?? []).filter((item) =>
      item.metadata.name.startsWith('zz-e2e-')
    )) {
      await request
        .delete(`${clusterPath}/${kind}/${namespace}/${item.metadata.name}`)
        .catch(() => undefined)
    }
  }
})
