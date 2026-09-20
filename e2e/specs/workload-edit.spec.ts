import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test'

import { e2eContextName } from '../env'
import { expectJSON, expectStatus } from '../support/admin-api'

/**
 * 工作负载「编辑」入口的 UI 冒烟测试。
 *
 * Deployment 的详情页一直有一个「编辑」按钮，进的是同一个工作负载表单页的编辑模式
 * （`DeploymentCreatePage` 带 `:name` 参数）。其余类型（StatefulSet / DaemonSet /
 * Job / CronJob）此前只有创建路由，没有任何编辑入口；本文件锁住它们现在也有：
 *
 *   1. 路由 `/…/:namespace/:name/edit` 存在且能读出线上对象（身份字段被锁定、
 *      容器镜像等内容来自集群）；
 *   2. 改动能落回集群（各类型取一个真实字段验证）；
 *   3. Job 这类 Pod 模板不可变的对象，原样保存不会把模板改坏
 *      （表单未建模的字段靠 `mergeEditedManifest` 从线上对象恢复）。
 *
 * 对象都由 API 种好（`/resources/apply`），只把「编辑」这一段走界面，用例自清理。
 * 用例刻意不产生真实运行中的 Pod（replicas 0 / 命中不了的 nodeSelector /
 * 不触发的调度），避免在测试集群里留下负载。
 *
 * 运行（对已有集群、真实 K8s）：
 *   make e2e-run-existing KUBECONFIG=~/.kube/config \
 *     E2E_CLUSTER_NAME=<context 名> E2E_CONTEXT_NAME=<context 名> E2E_NODE_NAME=<node> \
 *     SPEC="specs/workload-edit.spec.ts"
 */

const namespace = 'default'
const cluster = e2eContextName
const clusterPath = `/api/v1/_clusters/${encodeURIComponent(cluster)}`

// 节点上已缓存的 nginx（与 resource-creation.spec.ts 同一来源）。
const PREPULLED_IMAGE =
  'swr.cn-south-1.myhuaweicloud.com/dsy/docker.io/library/nginx:1.30.3'
const EDITED_IMAGE =
  'swr.cn-south-1.myhuaweicloud.com/dsy/docker.io/library/nginx:1.30.2'

const uniqueName = (kind: string) => `zz-e2e-${kind}-${Date.now().toString(36)}`

type ContainerList = {
  spec: { template: { spec: { containers: Array<{ image: string }> } } }
}

async function seed(request: APIRequestContext, yaml: string) {
  await expectStatus(
    await request.post(`${clusterPath}/resources/apply`, { data: { yaml } }),
    200
  )
}

async function remove(request: APIRequestContext, kind: string, name: string) {
  await request
    .delete(`${clusterPath}/${kind}/${namespace}/${name}`)
    .catch(() => undefined)
}

/** 从详情页进编辑页：这条入口本身就是本次改动的一部分。 */
async function openEditor(page: Page, kind: string, name: string) {
  await page.goto(`/${kind}/${namespace}/${name}`)
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.waitForURL(`**/${kind}/${namespace}/${name}/edit`)
}

/**
 * 容器镜像在「容器」页签里，先切过去。
 *
 * 页签名就是容器名（新建流程里默认叫 container-1，编辑已有对象时是对象里的名字），
 * 所以这里按容器名定位。
 */
async function editContainerImage(
  page: Page,
  container: string,
  image: string
) {
  await page.getByRole('tab', { name: container, exact: true }).click()
  await page.getByPlaceholder('nginx:latest').fill(image)
}

async function save(page: Page, kind: string, name: string) {
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForURL(`**/${kind}/${namespace}/${name}`, { timeout: 30000 })
}

test.describe('workload editing', () => {
  test('a StatefulSet is edited from its detail page', async ({
    page,
    request,
  }) => {
    const name = uniqueName('ssedit')
    try {
      await seed(
        request,
        `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: ${name}
  namespace: ${namespace}
spec:
  serviceName: ${name}
  replicas: 0
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
        app: ${name}
    spec:
      # 没有任何节点带这个标签：即使表单把 replicas 归一成 1，也不会有 Pod 落到真节点上。
      nodeSelector:
        zz-e2e-no-such-node: "true"
      containers:
        - name: app
          image: ${PREPULLED_IMAGE}
`
      )

      await openEditor(page, 'statefulsets', name)
      // 编辑模式：身份字段锁定并且来自线上对象。
      await expect(page.getByPlaceholder('unique-name')).toHaveValue(name)
      await expect(page.getByPlaceholder('unique-name')).toBeDisabled()

      await editContainerImage(page, 'app', EDITED_IMAGE)
      await save(page, 'statefulsets', name)

      const edited = await expectJSON<
        ContainerList & { spec: { serviceName?: string } }
      >(
        await request.get(`${clusterPath}/statefulsets/${namespace}/${name}`),
        200
      )
      expect(edited.spec.template.spec.containers[0].image).toBe(EDITED_IMAGE)
      expect(edited.spec.serviceName).toBe(name)
    } finally {
      await remove(request, 'statefulsets', name)
    }
  })

  test('a DaemonSet is edited from its detail page and keeps its node selector', async ({
    page,
    request,
  }) => {
    const name = uniqueName('dsedit')
    try {
      await seed(
        request,
        `apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: ${name}
  namespace: ${namespace}
spec:
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
        app: ${name}
    spec:
      # 没有节点带这个标签，因此这个 DaemonSet 不会真的在每个节点上起 Pod。
      nodeSelector:
        zz-e2e-no-such-node: "true"
      containers:
        - name: app
          image: ${PREPULLED_IMAGE}
`
      )

      await openEditor(page, 'daemonsets', name)
      await editContainerImage(page, 'app', EDITED_IMAGE)
      await save(page, 'daemonsets', name)

      const edited = await expectJSON<
        ContainerList & {
          spec: {
            template: { spec: { nodeSelector?: Record<string, string> } }
          }
        }
      >(
        await request.get(`${clusterPath}/daemonsets/${namespace}/${name}`),
        200
      )
      expect(edited.spec.template.spec.containers[0].image).toBe(EDITED_IMAGE)
      // 表单没有建模 Node 选择器这一栏之外的内容也必须保留下来。
      expect(edited.spec.template.spec.nodeSelector).toEqual({
        'zz-e2e-no-such-node': 'true',
      })
    } finally {
      await remove(request, 'daemonsets', name)
    }
  })

  test('a CronJob schedule is edited from its detail page', async ({
    page,
    request,
  }) => {
    const name = uniqueName('cronedit')
    try {
      await seed(
        request,
        `apiVersion: batch/v1
kind: CronJob
metadata:
  name: ${name}
  namespace: ${namespace}
spec:
  # 2 月 31 日永远不存在，用例不会真的跑起来一个 Job。
  schedule: "0 0 31 2 *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: app
              image: ${PREPULLED_IMAGE}
`
      )

      await openEditor(page, 'cronjobs', name)
      const schedule = page.getByPlaceholder('*/5 * * * *')
      await expect(schedule).toHaveValue('0 0 31 2 *')
      await schedule.fill('0 0 31 3 *')
      await save(page, 'cronjobs', name)

      const edited = await expectJSON<{ spec: { schedule: string } }>(
        await request.get(`${clusterPath}/cronjobs/${namespace}/${name}`),
        200
      )
      expect(edited.spec.schedule).toBe('0 0 31 3 *')
    } finally {
      await remove(request, 'cronjobs', name)
    }
  })

  test('a Job is edited without touching its immutable pod template', async ({
    page,
    request,
  }) => {
    const name = uniqueName('jobedit')
    const labelKey = 'zz-e2e-edited'
    try {
      await seed(
        request,
        `apiVersion: batch/v1
kind: Job
metadata:
  name: ${name}
  namespace: ${namespace}
  labels:
    app: ${name}
spec:
  backoffLimit: 1
  template:
    metadata:
      labels:
        app: ${name}
    spec:
      # 快速失败退出：不让这个 Job 的 Pod 一直占着节点。
      restartPolicy: Never
      containers:
        - name: app
          image: ${PREPULLED_IMAGE}
          command: ["/bin/false"]
`
      )

      await openEditor(page, 'jobs', name)
      await expect(page.getByPlaceholder('unique-name')).toHaveValue(name)
      // Job 的元数据标签是可改的（Pod 模板不可改），改第一行标签。
      await page.getByPlaceholder('e.g. foo').first().fill(labelKey)
      await page.getByPlaceholder('e.g. bar').first().fill(labelKey)
      await save(page, 'jobs', name)

      const edited = await expectJSON<{
        metadata: { labels?: Record<string, string> }
        spec: {
          selector?: { matchLabels?: Record<string, string> }
          template: {
            spec: {
              restartPolicy?: string
              containers: Array<{ image: string; command?: string[] }>
            }
          }
        }
      }>(await request.get(`${clusterPath}/jobs/${namespace}/${name}`), 200)

      expect(edited.metadata.labels?.[labelKey]).toBe(labelKey)
      // 保存成功本身就说明 Pod 模板没被改写（改了会被 API 以 field is immutable 拒绝）；
      // 这里再把关键字段钉一遍。
      expect(edited.spec.template.spec.restartPolicy).toBe('Never')
      expect(edited.spec.template.spec.containers[0].image).toBe(
        PREPULLED_IMAGE
      )
      expect(edited.spec.template.spec.containers[0].command).toEqual([
        '/bin/false',
      ])
    } finally {
      await remove(request, 'jobs', name)
    }
  })
})

/** 用例自清理后补一次兜底清理，避免失败时在集群里留下 zz-e2e-* 对象。 */
test.afterAll(async ({ request }) => {
  for (const kind of ['statefulsets', 'daemonsets', 'cronjobs', 'jobs']) {
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
