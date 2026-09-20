import { expect, test, type APIRequestContext } from '@playwright/test'

import { e2eContextName } from '../env'
import { expectStatus } from '../support/admin-api'

/**
 * 工作负载列表页的「操作」列。
 *
 * 以前只有 Deployment 的列表有这一列，而且菜单里没有「编辑」：想改一个 Deployment
 * 必须先点进详情页，再用详情页上的编辑按钮进编辑页。这个文件锁住两件事：
 *
 *   1. 工作负载分组下的六类（含 Pod）列表都有操作入口；
 *   2. 菜单里的「编辑」直接跳到编辑页。
 *
 * 每类只种一个「跑不起来」的对象（命中不了的 nodeSelector / replicas 0 /
 * 永不触发的 cron 表达式 / 立刻失败退出的 Job），用例自清理，不在集群里留下负载。
 *
 * 需要先种对象的原因：列表为空时页面渲染的是空态、整张表（含表头）都不出现。
 *
 * 运行（对已有集群、真实 K8s）：
 *   make e2e-run-existing KUBECONFIG=~/.kube/config \
 *     E2E_CLUSTER_NAME=<context 名> E2E_CONTEXT_NAME=<context 名> E2E_NODE_NAME=<node> \
 *     SPEC="specs/workload-list-actions.spec.ts"
 */

const namespace = 'default'
const cluster = e2eContextName
const clusterPath = `/api/v1/_clusters/${encodeURIComponent(cluster)}`

const PREPULLED_IMAGE =
  'swr.cn-south-1.myhuaweicloud.com/dsy/docker.io/library/nginx:1.30.3'

const uniqueName = (kind: string) =>
  `zz-e2e-listact-${kind}-${Date.now().toString(36)}`

type WorkloadKind =
  'pods' | 'deployments' | 'statefulsets' | 'daemonsets' | 'jobs' | 'cronjobs'

const podTemplate = (name: string, extra = '') => `    spec:
      # 没有节点带这个标签：即使调度器看到了，也不会有 Pod 落到真节点上。
      nodeSelector:
        zz-e2e-no-such-node: "true"
${extra}      containers:
        - name: app
          image: ${PREPULLED_IMAGE}
`

const workloadYaml: Record<WorkloadKind, (name: string) => string> = {
  pods: (name) => `apiVersion: v1
kind: Pod
metadata:
  name: ${name}
  namespace: ${namespace}
spec:
  nodeSelector:
    zz-e2e-no-such-node: "true"
  containers:
    - name: app
      image: ${PREPULLED_IMAGE}
`,
  deployments: (name) => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  namespace: ${namespace}
spec:
  replicas: 0
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
        app: ${name}
${podTemplate(name)}`,
  statefulsets: (name) => `apiVersion: apps/v1
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
${podTemplate(name)}`,
  daemonsets: (name) => `apiVersion: apps/v1
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
${podTemplate(name)}`,
  jobs: (name) => `apiVersion: batch/v1
kind: Job
metadata:
  name: ${name}
  namespace: ${namespace}
spec:
  backoffLimit: 0
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
`,
  cronjobs: (name) => `apiVersion: batch/v1
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
`,
}

/** 工作负载分组（见 ui/src/lib/resource-catalog.ts 的 sidebar.groups.workloads）。 */
const workloadKinds = Object.keys(workloadYaml) as WorkloadKind[]

async function seed(
  request: APIRequestContext,
  kind: WorkloadKind,
  name: string
) {
  await expectStatus(
    await request.post(`${clusterPath}/resources/apply`, {
      data: { yaml: workloadYaml[kind](name) },
    }),
    200
  )
}

async function remove(
  request: APIRequestContext,
  kind: WorkloadKind,
  name: string
) {
  await request
    .delete(`${clusterPath}/${kind}/${namespace}/${name}`)
    .catch(() => undefined)
}

test.describe('workload list actions', () => {
  for (const kind of workloadKinds) {
    test(`the ${kind} list offers a row-actions column`, async ({
      page,
      request,
    }) => {
      const name = uniqueName(kind)
      try {
        await seed(request, kind, name)
        await page.goto(`/${kind}`)

        await expect(
          page.getByRole('columnheader', { name: 'Actions' })
        ).toBeVisible()
      } finally {
        await remove(request, kind, name)
      }
    })
  }

  test('a Deployment is edited straight from the list actions menu', async ({
    page,
    request,
  }) => {
    const name = uniqueName('deployments')
    try {
      await seed(request, 'deployments', name)

      await page.goto('/deployments')
      // 用列表自带的搜索定位这一行，不依赖排序与分页。
      await page
        .getByPlaceholder('Search Deployments or app=nginx...')
        .fill(name)

      const row = page.getByRole('row').filter({ hasText: name })
      await expect(row).toBeVisible()

      await row.getByRole('button', { name: 'Actions' }).click()
      // exact：同一个菜单里还有「修改镜像」（Edit image）。
      await page.getByRole('menuitem', { name: 'Edit', exact: true }).click()

      await page.waitForURL(`**/deployments/${namespace}/${name}/edit`)
      // 进的是编辑模式而不是创建模式：身份字段来自线上对象且被锁定。
      await expect(page.getByPlaceholder('unique-name')).toHaveValue(name)
    } finally {
      await remove(request, 'deployments', name)
    }
  })
})
