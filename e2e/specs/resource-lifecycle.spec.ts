import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Locator,
  type Page,
} from '@playwright/test'

import { e2eContextName } from '../env'

/**
 * 资源「生命周期」冒烟测试：扩缩容 / 重启 / 回滚 / YAML 编辑 / 删除，以及
 * 列表页没有专用创建入口的资源，通过顶栏 `+` 打开的「通用 YAML 弹窗」创建。
 *
 * 运行（对已有集群、真实 K8s）：
 *   make e2e-run-existing KUBECONFIG=~/.kube/config E2E_NODE_NAME=<node> \
 *     SPEC="specs/resource-lifecycle.spec.ts"
 *
 * 说明：
 *   - 资源都建在 default 命名空间，命名带 zz-e2e- 前缀，用例内自清理。
 *   - 工作负载用节点上已缓存的镜像（本环境统一走华为云 SWR），避免依赖外部
 *     仓库可达性。
 *   - 生命周期用例里 Deployment 用接口创建（创建流程已由
 *     resource-creation.spec.ts 覆盖），界面只用来执行被测操作，减少无关失败。
 *   - 界面的 YAML 编辑是「整份替换」，后端 Update 要求带上最新的
 *     resourceVersion，所以粘贴前先读一次对象（界面上编辑器里的值同理）。
 *   - 不测节点驱逐（drain），节点用例见 node-operations.spec.ts。
 */

const namespace = 'default'
const cluster = e2eContextName
const apiBase = `/api/v1/_clusters/${encodeURIComponent(cluster)}`

const PREPULLED_IMAGE =
  'swr.cn-south-1.myhuaweicloud.com/gzwxh/docker.io/library/nginx:1.30.3'

const uniqueName = (kind: string) => `zz-e2e-${kind}-${Date.now().toString(36)}`

async function expectJSON<T>(response: APIResponse, status: number) {
  const text = await response.text()
  expect(response.status(), text).toBe(status)
  return JSON.parse(text) as T
}

async function getJSON<T>(request: APIRequestContext, path: string) {
  return expectJSON<T>(await request.get(path), 200)
}

async function applyYaml(request: APIRequestContext, yamlText: string) {
  return expectJSON<{ name: string }>(
    await request.post(`${apiBase}/resources/apply`, {
      data: { yaml: yamlText },
    }),
    200
  )
}

async function removeResource(
  request: APIRequestContext,
  path: string
): Promise<void> {
  await request.delete(path).catch(() => undefined)
}

/**
 * 往 Monaco 里放整段 YAML。
 *
 * 做法是聚焦编辑器的隐藏输入框后「全选 + 派发一次带 `clipboardData` 的真实 `paste`
 * 事件」：Monaco 的粘贴处理只读事件里的文本，所以不碰系统剪贴板（本环境
 * `navigator.clipboard.writeText` 会偶发 Write permission denied），也不用逐字合成按键
 * （合成按键在这里会丢字符）。
 *
 * 聚焦这一步不能省：Ctrl+A 只在输入框上才是编辑器的「全选」，否则选中的是整个页面，
 * 粘贴就变成「插到光标处」而不是整份替换。这种失败不会当场报错，只会拖到很久之后
 * 的业务断言上，所以下面额外断言粘贴产物落在文末。
 *
 * marker 用来确认「粘贴真的生效了」：编辑器里本来就有内容时（例如编辑已有资源的 YAML），
 * 拿首行（往往是 `apiVersion:`）去断言等于没断言——粘贴静默失败时旧内容里照样有它。
 * 默认从新 YAML 里挑第一行「旧内容里没有」的实质行；调用方知道更准的特征行时可以显式传入。
 */
async function pasteYaml(
  page: Page,
  scope: Locator,
  yamlText: string,
  marker?: string
) {
  const viewLines = scope.locator('.monaco-editor:visible .view-lines').first()
  await expect(viewLines).toBeVisible({ timeout: 60_000 })
  const before = await viewLines.innerText()
  const expected = (
    marker ??
    yamlText.split('\n').find((line) => isDistinctive(line, before)) ??
    yamlText.split('\n')[0]
  ).trim()

  // Monaco 的输入实现有两种：老式 textarea（`.inputarea`）与 Chromium 的 EditContext
  // （`.native-edit-context`）。两种都可能出现，所以两个都试、都派发，谁在处理谁生效。
  const inputSelector = 'textarea.inputarea, .native-edit-context'

  const focusInput = async () => {
    const info = await viewLines.evaluate((el, selector) => {
      const container = el.closest('.monaco-editor')
      if (!container) return { reason: '找不到 .monaco-editor' }
      const input = container.querySelector(selector)
      if (!(input instanceof HTMLElement)) {
        return {
          reason: '找不到输入元素',
          hasTextarea: !!container.querySelector('textarea.inputarea'),
          hasNativeEditContext: !!container.querySelector(
            '.native-edit-context'
          ),
        }
      }
      input.focus()
      return {
        reason: 'ok',
        tag: input.tagName,
        className: input.className,
        focused: document.activeElement === input,
        activeElement: `${document.activeElement?.tagName ?? 'null'}.${document.activeElement?.className ?? ''}`,
        editorFocused: container.classList.contains('focused'),
      }
    }, inputSelector)
    if (info.reason !== 'ok' || !info.focused) {
      throw new Error(`Monaco 输入框不可用: ${JSON.stringify(info)}`)
    }
  }

  await focusInput()
  await page.keyboard.press('Control+A')
  await viewLines.evaluate(
    (el, { selector, text }) => {
      const input = el.closest('.monaco-editor')?.querySelector(selector)
      if (!(input instanceof HTMLElement)) throw new Error('Monaco 输入框缺失')
      const data = new DataTransfer()
      data.setData('text/plain', text)
      input.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        })
      )
    },
    { selector: inputSelector, text: yamlText }
  )

  // Monaco 只渲染可见行，特征行可能落在视口之外，所以先拉到文末再看。
  // 对「整份替换」的场景，新 YAML 的收尾行这时候必然在文末；若粘贴只是插到光标处
  // （或压根没生效），这里看到的还是旧内容，失败就停在粘贴这一步。
  await expect(async () => {
    await focusInput()
    await page.keyboard.press('Control+End')
    await expect(viewLines).toContainText(expected, { timeout: 5_000 })
  }).toPass({ timeout: 20_000 })
}

/** 「能证明内容确实换了」的一行：够长、不是注释/分隔符、且旧内容里没有。 */
function isDistinctive(line: string, before: string) {
  const trimmed = line.trim()
  return (
    trimmed.length >= 8 &&
    !trimmed.startsWith('#') &&
    trimmed !== '---' &&
    !before.includes(trimmed)
  )
}

/** 顶栏 `+` → 「Create Resource」弹窗 → 粘贴 YAML → Apply。 */
async function createViaGenericDialog(page: Page, yamlText: string) {
  await page.goto('/')
  await page.locator('[aria-label="Create new resource"]').first().click()

  const dialog = page.getByRole('dialog', { name: 'Create Resource' })
  await expect(dialog).toBeVisible()
  await pasteYaml(page, dialog, yamlText)
  await dialog.getByRole('button', { name: 'Apply' }).click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })
}

interface DeploymentObject {
  metadata: { generation?: number; resourceVersion?: string }
  spec: {
    replicas?: number
    template: {
      metadata?: { annotations?: Record<string, string> }
      spec: {
        containers: Array<{ env?: Array<{ name: string; value: string }> }>
      }
    }
  }
  status?: { observedGeneration?: number; availableReplicas?: number }
}

function deploymentYaml(options: {
  name: string
  envValue: string
  replicas: number
  resourceVersion?: string
}) {
  // resourceVersion 必须带引号：它在 YAML 里是字符串，不加引号会被解析成数字，
  // 后端反序列化直接 400（json: cannot unmarshal number into ... resourceVersion）。
  const resourceVersion = options.resourceVersion
    ? `\n  resourceVersion: "${options.resourceVersion}"`
    : ''
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${options.name}
  namespace: ${namespace}${resourceVersion}
spec:
  replicas: ${options.replicas}
  selector:
    matchLabels:
      app: ${options.name}
  template:
    metadata:
      labels:
        app: ${options.name}
    spec:
      containers:
        - name: app
          image: ${PREPULLED_IMAGE}
          env:
            - name: ZZ_REV
              value: ${options.envValue}
`
}

function envValueOf(deployment: DeploymentObject) {
  return deployment.spec.template.spec.containers[0]?.env?.[0]?.value ?? ''
}

/** 等 Deployment 收敛（observedGeneration 追平 generation 且副本数达标）。 */
async function waitForDeploymentStable(
  request: APIRequestContext,
  name: string,
  replicas: number
) {
  await expect
    .poll(
      async () => {
        const deployment = await getJSON<DeploymentObject>(
          request,
          `${apiBase}/deployments/${namespace}/${name}`
        )
        const { metadata, status, spec } = deployment
        return (
          status?.observedGeneration === metadata.generation &&
          status?.availableReplicas === replicas &&
          spec.replicas === replicas
        )
      },
      {
        timeout: 120_000,
        message: `deployment ${name} should settle at ${replicas} replica(s)`,
      }
    )
    .toBe(true)
}

test.describe('deployment lifecycle', () => {
  test('scales, restarts, edits YAML, rolls back and deletes a deployment', async ({
    page,
    request,
  }) => {
    const name = uniqueName('lc')
    const deploymentPath = `${apiBase}/deployments/${namespace}/${name}`
    try {
      await applyYaml(
        request,
        deploymentYaml({ name, envValue: 'one', replicas: 1 })
      )
      await waitForDeploymentStable(request, name, 1)

      await page.goto(`/deployments/${namespace}/${name}`)

      // ---- 扩缩容：详情页头部 Scale 气泡 ----
      await page
        .locator('[data-slot="popover-trigger"]', { hasText: 'Scale' })
        .click()
      const scalePopover = page.locator('[data-slot="popover-content"]:visible')
      await expect(
        scalePopover.getByText('Scale Deployment', { exact: true })
      ).toBeVisible()
      await scalePopover.locator('#replicas').fill('2')
      await scalePopover
        .getByRole('button', { name: 'Scale', exact: true })
        .click()
      await waitForDeploymentStable(request, name, 2)

      // ---- 重启：写 restartedAt 注解 ----
      // 详情页头部的重启入口收在「更多」下拉菜单里，执行前有确认弹窗。
      await page
        .getByRole('button', { name: 'More', exact: true })
        .click()
      await page
        .locator('[data-slot="dropdown-menu-content"]:visible')
        .getByText('Restart', { exact: true })
        .click()
      const restartDialog = page.getByRole('dialog', {
        name: 'Restart Deployment',
      })
      await expect(restartDialog).toBeVisible()
      await restartDialog
        .getByRole('button', { name: 'Restart', exact: true })
        .click()
      await expect
        .poll(
          async () =>
            (await getJSON<DeploymentObject>(request, deploymentPath)).spec
              .template.metadata?.annotations?.[
              'aerolink.kubernetes.io/restartedAt'
            ] ?? '',
          { timeout: 60_000, message: 'restart annotation should be written' }
        )
        .not.toBe('')

      // ---- YAML 编辑：整份替换（带上实时 resourceVersion）----
      // 重启会触发滚动更新，页面在这期间每 1s 自动刷新；编辑器在编辑态不能被
      // 下发的新对象覆盖，否则刚粘贴的内容会被冲掉（见 yaml-editor.tsx）。
      await waitForDeploymentStable(request, name, 2)
      await page.getByRole('tab', { name: 'YAML' }).click()
      await expect(async () => {
        const live = await getJSON<DeploymentObject>(request, deploymentPath)
        const dialog = page.locator('[data-slot="tabs-content"]:visible')
        const editButton = dialog.getByRole('button', {
          name: 'Edit',
          exact: true,
        })
        if (await editButton.isVisible().catch(() => false)) {
          await editButton.click()
        }
        // 编辑器必须已进入编辑态：只读时 Monaco 会直接丢掉粘贴，
        // 下面就会以「粘贴没生效」收场，看不出真正原因。
        await expect(
          dialog.getByRole('button', { name: 'Save', exact: true })
        ).toBeVisible()
        await pasteYaml(
          page,
          dialog,
          deploymentYaml({
            name,
            envValue: 'two',
            replicas: 2,
            resourceVersion: live.metadata.resourceVersion,
          }),
          // 新 YAML 与旧内容的唯一差异就是 env 的取值：用它确认粘贴真的改动了编辑器，
          // 否则「保存成功但存的是旧内容」会拖到下面 120s 的值比对才报错。
          'value: two'
        )
        await dialog.getByRole('button', { name: 'Save', exact: true }).click()

        const updated = await getJSON<DeploymentObject>(request, deploymentPath)
        expect(envValueOf(updated)).toBe('two')
      }).toPass({ timeout: 120_000 })

      // ---- 回滚：历史 → Rollout Revisions → 回滚到最早的版本 ----
      await page.getByRole('tab', { name: 'History' }).click()
      await page.getByRole('tab', { name: 'Rollout Revisions' }).click()
      const rollbackButtons = page.getByRole('button', { name: 'Rollback' })
      await expect
        .poll(async () => rollbackButtons.count(), { timeout: 60_000 })
        .toBeGreaterThan(0)
      // 列表按版本倒序，最后一行是最早的版本（env: one）。
      await rollbackButtons.last().click()
      const rollbackDialog = page.getByRole('dialog', { name: 'Rollback?' })
      await expect(rollbackDialog).toBeVisible()
      await rollbackDialog
        .getByRole('button', { name: 'Rollback', exact: true })
        .click()
      await expect
        .poll(
          async () =>
            envValueOf(
              await getJSON<DeploymentObject>(request, deploymentPath)
            ),
          {
            timeout: 60_000,
            message: 'rollback should restore the first revision',
          }
        )
        .toBe('one')

      // ---- 删除：详情页「更多」→ Delete → 输入名称确认 ----
      await page.getByRole('button', { name: 'More', exact: true }).click()
      await page
        .locator('[data-slot="dropdown-menu-content"]:visible')
        .getByText('Delete', { exact: true })
        .click()
      const deleteDialog = page.getByRole('dialog', {
        name: 'Delete Deployment',
      })
      await expect(deleteDialog).toBeVisible()
      await deleteDialog.locator('#confirmation').fill(name)
      await deleteDialog
        .getByRole('button', { name: 'Delete', exact: true })
        .click()
      await expect
        .poll(async () => (await request.get(deploymentPath)).status(), {
          timeout: 60_000,
          message: 'deployment should be gone',
        })
        .toBe(404)
    } finally {
      await removeResource(request, deploymentPath)
    }
  })
})

interface DialogCase {
  label: string
  yaml: (name: string) => string
  resource: string
  assert?: (body: Record<string, unknown>) => void
  /** 创建前需要的其它对象（如 HPA 的目标工作负载）。 */
  prepare?: (request: APIRequestContext, name: string) => Promise<void>
  /** 创建后、断言前执行的补充动作（如给 PVC 挂一个消费者让它变成 Bound）。 */
  postCreate?: (request: APIRequestContext, name: string) => Promise<void>
  /** 除删除自身之外的额外清理。 */
  cleanup?: (request: APIRequestContext, name: string) => Promise<void>
}

const dialogCases: DialogCase[] = [
  {
    label: 'Secret',
    resource: 'secrets',
    yaml: (name) => `apiVersion: v1
kind: Secret
metadata:
  name: ${name}
  namespace: ${namespace}
type: Opaque
stringData:
  zz-key: zz-value
`,
    assert: (body) => {
      expect(body.type).toBe('Opaque')
      expect(Object.keys(body.data as Record<string, string>)).toContain(
        'zz-key'
      )
    },
  },
  {
    label: 'ServiceAccount',
    resource: 'serviceaccounts',
    yaml: (name) => `apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${name}
  namespace: ${namespace}
`,
  },
  {
    label: 'Role',
    resource: 'roles',
    yaml: (name) => `apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: ${name}
  namespace: ${namespace}
rules:
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["get", "list"]
`,
    assert: (body) => {
      const rules = body.rules as Array<{ verbs: string[] }>
      expect(rules).toHaveLength(1)
      expect(rules[0].verbs).toContain('get')
    },
  },
  {
    label: 'RoleBinding',
    resource: 'rolebindings',
    yaml: (name) => `apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ${name}
  namespace: ${namespace}
subjects:
  - kind: ServiceAccount
    name: default
    namespace: ${namespace}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: ${name}-role
`,
    // RoleBinding 的 roleRef 不校验存在性，但绑定一个真实 Role 更贴近实际用法。
    prepare: async (request, name) => {
      await applyYaml(
        request,
        `apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: ${name}-role
  namespace: ${namespace}
rules:
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["get"]
`
      )
    },
    cleanup: async (request, name) => {
      await removeResource(
        request,
        `${apiBase}/roles/${namespace}/${name}-role`
      )
    },
    assert: (body) => {
      const roleRef = body.roleRef as { kind: string; name: string }
      expect(roleRef.kind).toBe('Role')
    },
  },
  {
    label: 'PodDisruptionBudget',
    resource: 'poddisruptionbudgets',
    yaml: (name) => `apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: ${name}
  namespace: ${namespace}
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: ${name}
`,
    assert: (body) => {
      expect((body.spec as { minAvailable: number }).minAvailable).toBe(1)
    },
  },
  {
    label: 'Ingress',
    resource: 'ingresses',
    yaml: (name) => `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${name}
  namespace: ${namespace}
spec:
  rules:
    - host: ${name}.zz-e2e.invalid
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: ${name}-svc
                port:
                  number: 80
`,
    assert: (body) => {
      const rules = (body.spec as { rules: Array<{ host: string }> }).rules
      expect(rules[0].host).toContain('.zz-e2e.invalid')
    },
  },
  {
    label: 'HorizontalPodAutoscaler',
    resource: 'horizontalpodautoscalers',
    yaml: (name) => `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: ${name}
  namespace: ${namespace}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: ${name}-target
  minReplicas: 1
  maxReplicas: 3
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 80
`,
    prepare: async (request, name) => {
      await applyYaml(
        request,
        deploymentYaml({
          name: `${name}-target`,
          envValue: 'hpa',
          replicas: 1,
        })
      )
    },
    cleanup: async (request, name) => {
      await removeResource(
        request,
        `${apiBase}/deployments/${namespace}/${name}-target`
      )
    },
    assert: (body) => {
      const spec = body.spec as { maxReplicas: number }
      expect(spec.maxReplicas).toBe(3)
    },
  },
  {
    label: 'PersistentVolumeClaim',
    resource: 'persistentvolumeclaims',
    yaml: (name) => `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${name}
  namespace: ${namespace}
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: standard
  resources:
    requests:
      storage: 64Mi
`,
    // kind 自带的默认 StorageClass（standard，rancher.io/local-path）的
    // volumeBindingMode 是 WaitForFirstConsumer：没有 Pod 消费就会一直 Pending，
    // 所以要起一个挂载它的 Pod 才能等到 Bound。
    postCreate: async (request, name) => {
      await applyYaml(
        request,
        `apiVersion: v1
kind: Pod
metadata:
  name: ${name}-consumer
  namespace: ${namespace}
spec:
  restartPolicy: Never
  containers:
    - name: app
      image: ${PREPULLED_IMAGE}
      command: ["sh", "-c", "sleep 300"]
      volumeMounts:
        - name: data
          mountPath: /data
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: ${name}
`
      )
      await expect
        .poll(
          async () =>
            (
              await getJSON<{ status?: { phase?: string } }>(
                request,
                `${apiBase}/persistentvolumeclaims/${namespace}/${name}`
              )
            ).status?.phase ?? '',
          { timeout: 120_000, message: `pvc ${name} should become Bound` }
        )
        .toBe('Bound')
    },
    cleanup: async (request, name) => {
      await removeResource(
        request,
        `${apiBase}/pods/${namespace}/${name}-consumer`
      )
    },
    assert: (body) => {
      expect((body.status as { phase?: string })?.phase).toBe('Bound')
    },
  },
]

test.describe('create resources through the generic YAML dialog', () => {
  for (const dialogCase of dialogCases) {
    test(`creates a ${dialogCase.label}`, async ({ page, request }) => {
      const name = uniqueName(dialogCase.resource.slice(0, 6))
      const resourcePath = `${apiBase}/${dialogCase.resource}/${namespace}/${name}`
      try {
        if (dialogCase.prepare) {
          await dialogCase.prepare(request, name)
        }

        await createViaGenericDialog(page, dialogCase.yaml(name))

        const created = await getJSON<Record<string, unknown>>(
          request,
          resourcePath
        )
        const metadata = created.metadata as { name: string }
        expect(metadata.name).toBe(name)

        if (dialogCase.postCreate) {
          // 有 postCreate 的用例（如 PVC 等 Bound）在补充动作之后才断言。
          await dialogCase.postCreate(request, name)
          dialogCase.assert?.(
            await getJSON<Record<string, unknown>>(request, resourcePath)
          )
        } else {
          dialogCase.assert?.(created)
        }
      } finally {
        await removeResource(request, resourcePath)
        if (dialogCase.cleanup) {
          await dialogCase.cleanup(request, name)
        }
      }
    })
  }

  test('creates a cert-manager Issuer (Custom Resource) and lists it on the CRD page', async ({
    page,
    request,
  }) => {
    const name = uniqueName('issuer')
    const crd = 'issuers.cert-manager.io'
    const resourcePath = `${apiBase}/${crd}/${namespace}/${name}`
    try {
      await createViaGenericDialog(
        page,
        `apiVersion: cert-manager.io/v1
kind: Issuer
metadata:
  name: ${name}
  namespace: ${namespace}
spec:
  selfSigned: {}
`
      )

      const created = await getJSON<{ kind: string }>(request, resourcePath)
      expect(created.kind).toBe('Issuer')

      // CRD 列表页（/crds/:crd）应能列出刚创建的自定义资源。
      await page.goto(`/crds/${crd}`)
      await expect(page.getByRole('link', { name, exact: true })).toBeVisible({
        timeout: 30_000,
      })
    } finally {
      await removeResource(request, resourcePath)
    }
  })
})

/** 兜底清理：用例失败时也不把 zz-e2e-* 留在集群里。 */
test.afterAll(async ({ request }) => {
  for (const resource of [
    'deployments',
    'persistentvolumeclaims',
    'pods',
    'secrets',
    'serviceaccounts',
    'roles',
    'rolebindings',
    'poddisruptionbudgets',
    'horizontalpodautoscalers',
    'ingresses',
  ]) {
    const list = await request
      .get(`${apiBase}/${resource}/${namespace}`)
      .catch(() => undefined)
    if (!list?.ok()) continue
    const body = (await list.json()) as {
      items?: Array<{ metadata: { name: string } }>
    }
    for (const item of (body.items ?? []).filter((item) =>
      item.metadata.name.startsWith('zz-e2e-')
    )) {
      await removeResource(
        request,
        `${apiBase}/${resource}/${namespace}/${item.metadata.name}`
      )
    }
  }

  const issuers = await request
    .get(`${apiBase}/issuers.cert-manager.io/${namespace}`)
    .catch(() => undefined)
  if (issuers?.ok()) {
    const body = (await issuers.json()) as {
      items?: Array<{ metadata: { name: string } }>
    }
    for (const item of (body.items ?? []).filter((item) =>
      item.metadata.name.startsWith('zz-e2e-')
    )) {
      await removeResource(
        request,
        `${apiBase}/issuers.cert-manager.io/${namespace}/${item.metadata.name}`
      )
    }
  }
})
