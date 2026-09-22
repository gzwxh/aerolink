import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test'

import { e2eContextName } from '../env'
import { expectJSON, expectStatus } from '../support/admin-api'

/**
 * 「所有能创建的对象都能改」的 UI 冒烟测试（工作负载之外的那几类）。
 *
 * 覆盖四条容易退化、且只有真跑才看得出来的路径：
 *   1. Pod：走的还是工作负载表单（`DeploymentCreatePage` 的 pods 模式），
 *      保存不该被 Pod 的不可变字段挡住；
 *   2. ConfigMap：data 的 value 是多行文本域，换行与内容要能原样读出来再存回去；
 *   3. Secret：改一个值不能让同一条 Secret 里的二进制值（keystore、证书）被改写 ——
 *      base64 解码成字符串再编码会丢字节，二进制值必须原样留在二进制标签页；
 *   4. Service：编辑要保住 clusterIP（不可变）、标签/注解（表单没建模）与具名
 *      targetPort（表单里是文本，不能被当成数字顶成 port）。
 *
 * 对象都由 API 种好（`/resources/apply`），只把「编辑」这一段走界面，用例自清理；
 * 不产生真实运行中的容器（Pod 用命中不了的 nodeSelector，其余对象不涉及）。
 *
 * 运行（对已有集群、真实 K8s）：
 *   make e2e-run-existing KUBECONFIG=~/.kube/config \
 *     E2E_CLUSTER_NAME=<context 名> E2E_CONTEXT_NAME=<context 名> E2E_NODE_NAME=<node> \
 *     SPEC="specs/resource-edit.spec.ts"
 */

const namespace = 'default'
const cluster = e2eContextName
const clusterPath = `/api/v1/_clusters/${encodeURIComponent(cluster)}`

const PREPULLED_IMAGE =
  'swr.cn-south-1.myhuaweicloud.com/gzwxh/docker.io/library/nginx:1.30.3'

const uniqueName = (kind: string) => `zz-e2e-${kind}-${Date.now().toString(36)}`

async function seed(request: APIRequestContext, yaml: string) {
  await expectStatus(
    await request.post(`${clusterPath}/resources/apply`, { data: { yaml } }),
    200
  )
}

async function remove(
  request: APIRequestContext,
  kind: string,
  name: string,
  clusterScoped = false
) {
  const path = clusterScoped
    ? `${clusterPath}/${kind}/_all/${name}`
    : `${clusterPath}/${kind}/${namespace}/${name}`
  await request.delete(path).catch(() => undefined)
}

/** 从详情页进编辑页：这条入口本身就是本次改动的一部分。 */
async function openEditor(page: Page, kind: string, name: string) {
  await page.goto(`/${kind}/${namespace}/${name}`)
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.waitForURL(`**/${kind}/${namespace}/${name}/edit`)
}

async function save(page: Page, kind: string, name: string) {
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForURL(`**/${kind}/${namespace}/${name}`, { timeout: 30000 })
}

test.describe('resource editing', () => {
  test('a Pod is edited through the workload form', async ({
    page,
    request,
  }) => {
    const name = uniqueName('podedit')
    try {
      await seed(
        request,
        `apiVersion: v1
kind: Pod
metadata:
  name: ${name}
  namespace: ${namespace}
spec:
  # 命中不了的节点标签：这个 Pod 不会被调度，也就不真的跑容器。
  nodeSelector:
    zz-e2e-no-such-node: "true"
  containers:
    - name: app
      image: ${PREPULLED_IMAGE}
`
      )

      await openEditor(page, 'pods', name)
      await expect(page.getByPlaceholder('unique-name')).toBeDisabled()
      // 容器页签就是容器名。
      await page.getByRole('tab', { name: 'app', exact: true }).click()
      await page
        .getByPlaceholder('nginx:latest')
        .fill(`${PREPULLED_IMAGE}-edited`)
      await save(page, 'pods', name)

      const edited = await expectJSON<{
        spec: { containers: Array<{ image: string }>; nodeSelector?: unknown }
      }>(await request.get(`${clusterPath}/pods/${namespace}/${name}`), 200)
      expect(edited.spec.containers[0].image).toBe(`${PREPULLED_IMAGE}-edited`)
      // 表单没建模的字段照旧保留。
      expect(edited.spec.nodeSelector).toEqual({
        'zz-e2e-no-such-node': 'true',
      })
    } finally {
      await remove(request, 'pods', name)
    }
  })

  test('a ConfigMap keeps multi-line values in the textarea', async ({
    page,
    request,
  }) => {
    const name = uniqueName('cmedit')
    const original = 'server {\n  listen 80;\n}\n'
    const updated = 'server {\n  listen 8080;\n}\n'
    try {
      await seed(
        request,
        `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${name}
  namespace: ${namespace}
data:
  nginx.conf: |
${original
  .split('\n')
  .slice(0, -1)
  .map((line) => `    ${line}`)
  .join('\n')}
`
      )

      await openEditor(page, 'configmaps', name)
      await expect(page.getByLabel(/name/i).first()).toBeDisabled()

      // 多行值在多行文本域里原样呈现（以前是单行输入框，换行看不见）。
      const value = page.getByPlaceholder('e.g. bar').first()
      expect(value).toHaveJSProperty('tagName', 'TEXTAREA')
      await expect(value).toHaveValue(original)
      await value.fill(updated)
      await save(page, 'configmaps', name)

      const edited = await expectJSON<{ data: Record<string, string> }>(
        await request.get(`${clusterPath}/configmaps/${namespace}/${name}`),
        200
      )
      expect(edited.data['nginx.conf']).toBe(updated)
    } finally {
      await remove(request, 'configmaps', name)
    }
  })

  test('editing a Secret does not rewrite its binary values', async ({
    page,
    request,
  }) => {
    const name = uniqueName('secretedit')
    // 非 UTF-8 字节（0xFF 0xFE）：解码成字符串再编码回去就与原值不同，
    // 必须原样留在二进制标签页，否则「只改一个明文值」也会把载荷改坏。
    const binaryValue = '//4='
    const binaryKey = 'keystore'
    const textKey = 'greeting'
    try {
      await seed(
        request,
        `apiVersion: v1
kind: Secret
metadata:
  name: ${name}
  namespace: ${namespace}
type: Opaque
data:
  ${textKey}: ${Buffer.from('hello').toString('base64')}
  ${binaryKey}: ${binaryValue}
`
      )

      await openEditor(page, 'secrets', name)
      // 明文值在多行文本域里，默认遮住，点「Show」后可见可改。
      await page.getByRole('button', { name: 'Show' }).first().click()
      const value = page.getByPlaceholder('e.g. bar').first()
      expect(value).toHaveJSProperty('tagName', 'TEXTAREA')
      await expect(value).toHaveValue('hello')
      await value.fill('hello-edited')
      await save(page, 'secrets', name)

      const edited = await expectJSON<{ data: Record<string, string> }>(
        await request.get(`${clusterPath}/secrets/${namespace}/${name}`),
        200
      )
      expect(Buffer.from(edited.data[textKey], 'base64').toString('utf8')).toBe(
        'hello-edited'
      )
      // 二进制值逐字节不变。
      expect(edited.data[binaryKey]).toBe(binaryValue)
    } finally {
      await remove(request, 'secrets', name)
    }
  })

  test('editing a Service keeps its clusterIP, labels and named target port', async ({
    page,
    request,
  }) => {
    const name = uniqueName('svcedit')
    try {
      await seed(
        request,
        `apiVersion: v1
kind: Service
metadata:
  name: ${name}
  namespace: ${namespace}
  labels:
    zz-e2e-keep: "yes"
  annotations:
    zz-e2e-note: keep me
spec:
  selector:
    app: ${name}
  ports:
    - name: http
      port: 80
      targetPort: http
`
      )

      const before = await expectJSON<{
        spec: {
          clusterIP?: string
          ports: Array<{ port: number; targetPort: unknown }>
        }
      }>(await request.get(`${clusterPath}/services/${namespace}/${name}`), 200)
      const clusterIP = before.spec.clusterIP
      expect(clusterIP).toBeTruthy()

      await openEditor(page, 'services', name)
      // 身份字段锁定（名字是 Service 的标识，改名字等于换一个对象）。
      await expect(page.getByPlaceholder('my-service')).toBeDisabled()

      // 改服务端口；targetPort（具名 "http"）不能被顶成数字。
      const portInput = page.getByPlaceholder('Port *')
      await expect(portInput).toHaveValue('80')
      await portInput.fill('8080')
      await save(page, 'services', name)

      const edited = await expectJSON<{
        metadata: {
          labels?: Record<string, string>
          annotations?: Record<string, string>
        }
        spec: {
          clusterIP?: string
          selector?: Record<string, string>
          ports: Array<{ port: number; targetPort: unknown }>
        }
      }>(await request.get(`${clusterPath}/services/${namespace}/${name}`), 200)
      expect(edited.spec.ports[0].port).toBe(8080)
      // 具名 targetPort 原样保留：表单没有数字可填时不能把它替换成 port。
      expect(edited.spec.ports[0].targetPort).toBe('http')
      // 不可变字段与表单没建模的字段都从线上对象带了过去。
      expect(edited.spec.clusterIP).toBe(clusterIP)
      expect(edited.spec.selector).toEqual({ app: name })
      expect(edited.metadata.labels?.['zz-e2e-keep']).toBe('yes')
      expect(edited.metadata.annotations?.['zz-e2e-note']).toBe('keep me')
    } finally {
      await remove(request, 'services', name)
    }
  })
})

/** 用例自清理后补一次兜底清理，避免失败时在集群里留下 zz-e2e-* 对象。 */
test.afterAll(async ({ request }) => {
  for (const kind of ['pods', 'configmaps', 'secrets', 'services']) {
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
