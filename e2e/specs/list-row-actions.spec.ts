import { expect, test, type APIRequestContext } from '@playwright/test'

import { e2eContextName } from '../env'
import { expectStatus } from '../support/admin-api'

/**
 * 工作负载列表页的「操作」列。
 *
 * 以前只有 Deployment 的列表有这一列，而且菜单里没有「编辑」：想改一个 Deployment
 * 必须先点进详情页，再用详情页上的编辑按钮进编辑页。这个文件锁住两件事：
 *
 *   1. 这些列表都有操作入口；
 *   2. 菜单里的「编辑」直接跳到编辑页。
 *
 * 覆盖工作负载六类（含 Pod）、Service、ConfigMap / Secret、PV / StorageClass —— 它们都走
 * 同一个行操作菜单（`ui/src/components/resource-row-actions.tsx`）。
 *
 * 每类只种一个「跑不起来」的对象（命中不了的 nodeSelector / replicas 0 /
 * 永不触发的 cron 表达式 / 立刻失败退出的 Job / 什么都不选中的 Service，
 * ConfigMap 与 Secret 则是纯数据、不会跑起来任何东西），
 * 用例自清理，不在集群里留下负载。
 *
 * 需要先种对象的原因：列表为空时页面渲染的是空态、整张表（含表头）都不出现。
 *
 * 运行（对已有集群、真实 K8s）：
 *   make e2e-run-existing KUBECONFIG=~/.kube/config \
 *     E2E_CLUSTER_NAME=<context 名> E2E_CONTEXT_NAME=<context 名> E2E_NODE_NAME=<node> \
 *     SPEC="specs/list-row-actions.spec.ts"
 */

const namespace = 'default'
const cluster = e2eContextName
const clusterPath = `/api/v1/_clusters/${encodeURIComponent(cluster)}`

const PREPULLED_IMAGE =
  'swr.cn-south-1.myhuaweicloud.com/gzwxh/docker.io/library/nginx:1.30.3'

const uniqueName = (kind: string) =>
  `zz-e2e-listact-${kind}-${Date.now().toString(36)}`

type RowActionKind =
  | 'pods'
  | 'deployments'
  | 'statefulsets'
  | 'daemonsets'
  | 'jobs'
  | 'cronjobs'
  | 'services'
  | 'configmaps'
  | 'secrets'
  | 'persistentvolumes'
  | 'storageclasses'

const podTemplate = (name: string, extra = '') => `    spec:
      # 没有节点带这个标签：即使调度器看到了，也不会有 Pod 落到真节点上。
      nodeSelector:
        zz-e2e-no-such-node: "true"
${extra}      containers:
        - name: app
          image: ${PREPULLED_IMAGE}
`

const workloadYaml: Record<RowActionKind, (name: string) => string> = {
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
  persistentvolumes: (name) => `apiVersion: v1
kind: PersistentVolume
metadata:
  name: ${name}
spec:
  capacity:
    storage: 1Gi
  accessModes: [ReadWriteOnce]
  persistentVolumeReclaimPolicy: Retain
  hostPath:
    path: /data/volumes/${name}
    type: DirectoryOrCreate
`,
  storageclasses: (name) => `apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ${name}
provisioner: kubernetes.io/no-provisioner
reclaimPolicy: Retain
volumeBindingMode: WaitForFirstConsumer
`,
  services: (name) => `apiVersion: v1
kind: Service
metadata:
  name: ${name}
  namespace: ${namespace}
spec:
  selector:
    app: ${name}
  ports:
    - port: 80
      targetPort: 80
`,
  configmaps: (name) => `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${name}
  namespace: ${namespace}
data:
  app.conf: |
    key = value
`,
  secrets: (name) => `apiVersion: v1
kind: Secret
metadata:
  name: ${name}
  namespace: ${namespace}
type: Opaque
stringData:
  password: e2e
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

const rowActionKinds = Object.keys(workloadYaml) as RowActionKind[]

async function seed(
  request: APIRequestContext,
  kind: RowActionKind,
  name: string
) {
  await expectStatus(
    await request.post(`${clusterPath}/resources/apply`, {
      data: { yaml: workloadYaml[kind](name) },
    }),
    200
  )
}

/** 集群级资源（PV / StorageClass）的 API 路径是 /:kind/_all/:name，没有命名空间段。 */
const clusterScopedKinds = new Set<RowActionKind>([
  'persistentvolumes',
  'storageclasses',
])

async function remove(
  request: APIRequestContext,
  kind: RowActionKind,
  name: string
) {
  const path = clusterScopedKinds.has(kind)
    ? `${clusterPath}/${kind}/_all/${name}`
    : `${clusterPath}/${kind}/${namespace}/${name}`
  await request.delete(path).catch(() => undefined)
}

test.describe('list row actions', () => {
  for (const kind of rowActionKinds) {
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
        // 必须是最右一列：曾经被插到「创建时间」前面过。
        await expect(page.getByRole('columnheader').last()).toHaveText(
          'Actions'
        )
      } finally {
        await remove(request, kind, name)
      }
    })
  }

  // 「从列表的操作菜单进编辑页」：四种资源的编辑页路由与身份字段各不相同，
  // 差异都放在这张表里，用例本身只有一条。集群级资源（PV / StorageClass）的
  // 编辑路径没有命名空间段，这是最容易写错的地方。
  // search 是列表搜索框里的名字（取的是 catalog 的 pluralLabel，带空格），
  // identity 是编辑页里那个被锁定的名称输入框的 placeholder。
  const editFromList = [
    { kind: 'deployments', search: 'Deployments', identity: 'unique-name' },
    { kind: 'services', search: 'Services', identity: 'my-service' },
    { kind: 'configmaps', search: 'ConfigMaps', identity: 'Enter a name' },
    { kind: 'secrets', search: 'Secrets', identity: 'Enter a name' },
    {
      kind: 'persistentvolumes',
      search: 'Persistent Volumes',
      identity: 'pv-data-01',
    },
    {
      kind: 'storageclasses',
      search: 'Storage Classes',
      identity: 'fast-ssd',
    },
  ] as const

  for (const { kind, search, identity } of editFromList) {
    test(`a ${kind} record is edited straight from the list actions menu`, async ({
      page,
      request,
    }) => {
      const name = uniqueName(kind)
      try {
        await seed(request, kind, name)
        await page.goto(`/${kind}`)
        // 用列表自带的搜索定位这一行，不依赖排序与分页。
        await page
          .getByPlaceholder(`Search ${search} or app=nginx...`)
          .fill(name)

        const row = page.getByRole('row').filter({ hasText: name })
        await expect(row).toBeVisible()

        await row.getByRole('button', { name: 'Actions' }).click()
        // exact：菜单里还有「修改镜像」（Edit image）这类同名开头的项。
        await page.getByRole('menuitem', { name: 'Edit', exact: true }).click()

        // 集群级资源没有命名空间段。
        const expected = ['persistentvolumes', 'storageclasses'].includes(kind)
          ? `**/${kind}/${name}/edit`
          : `**/${kind}/${namespace}/${name}/edit`
        await page.waitForURL(expected)

        // 进的是编辑模式：身份字段来自线上对象且被锁定。
        const input = page.getByPlaceholder(identity, { exact: true })
        await expect(input).toHaveValue(name)
        await expect(input).toBeDisabled()
      } finally {
        await remove(request, kind, name)
      }
    })
  }
})
