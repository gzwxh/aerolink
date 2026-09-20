import http from 'node:http'
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type APIResponse,
} from '@playwright/test'

import { e2eContextName } from '../env'

// Critical 级 proxy 路径逃逸漏洞的回归测试（CVE review C1）。
//
// 复现的利用链：
//   1. Gin 会把解码后的 %2e%2e 片段透传给 proxy 的 catch-all。
//   2. kube/proxy.go 把解码后的路径交给 url.JoinPath，后者按字面
//      清理 ..，使攻击者得以逃出 /proxy/ 片段。
//   3. 清理后的 URL（例如 /api/v1/namespaces/kube-system/secrets）会带上
//      Kite 自己的 SA 凭据发往 Kubernetes API Server
//      （charts/kite/values.yaml 授予 resources:["*"]、verbs:["*"]）。
//   4. handler.go 只校验来源命名空间上的 pods/services:get，
//      因此在 "default" 中有 pods:get 的只读用户能读取 kube-system 的 secret。
//
// 该测试在存在漏洞的构建上会 FAIL（状态 200 + SecretList 响应体），
// 而在逃逸被阻断后 PASS。失败断言中包含
// 响应体，因此泄露内容在 CI 输出里可见。

async function expectStatus(response: APIResponse, status: number) {
  const text = await response.text()
  expect(response.status(), text).toBe(status)
}

async function expectForbidden(response: APIResponse, expected: string[]) {
  const body = await response.text()
  expect(response.status(), body).toBe(403)
  const parsed = JSON.parse(body) as { error: string }
  for (const value of expected) {
    expect(parsed.error).toContain(value)
  }
}

interface RawResponse {
  status: number
  body: string
  headers: http.IncomingHttpHeaders
}

// sendRawHTTP 发送一个可完全控制请求行路径的请求，
// 因为 Playwright 的 APIRequestContext 可能会规范化路径（把 %2e%2e 折叠掉）。
async function sendRawHTTP(
  baseURL: string,
  method: string,
  path: string,
  cookieHeader: string
): Promise<RawResponse> {
  const url = new URL(baseURL)
  return new Promise<RawResponse>((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? '443' : '80'),
        method,
        path,
        headers: { Cookie: cookieHeader },
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          body += chunk
        })
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body,
            headers: res.headers,
          })
        )
      }
    )
    req.on('error', reject)
    req.end()
  })
}

test('proxy path escape via encoded .. cannot bypass RBAC to read secrets', async ({
  request,
}, testInfo) => {
  const baseURL = testInfo.project.use.baseURL
  if (typeof baseURL !== 'string') {
    throw new Error('Playwright baseURL is required')
  }

  const suffix = Date.now().toString(36)
  const username = `e2e-proxy-${suffix}`
  const password = 'E2Eproxy!2345'
  const roleName = `e2e-proxy-role-${suffix}`
  const podName = `e2e-proxy-pod-${suffix}`
  const secretName = `e2e-proxy-secret-${suffix}`
  const secretProofKey = 'proof'
  // base64("proxy-escape-proof-<suffix>")——可识别的载荷，便于
  // 在泄露的 SecretList 响应体中检出。
  const secretProofValue = Buffer.from(`proxy-escape-proof-${suffix}`).toString(
    'base64'
  )

  const clusterName = e2eContextName
  const clusterPath = `/api/v1/_clusters/${encodeURIComponent(clusterName)}`
  const podPath = `${clusterPath}/pods/default/${podName}`
  const secretPath = `${clusterPath}/secrets/kube-system/${secretName}`

  let userId: number | undefined
  let roleId: number | undefined
  let podCreated = false
  let secretCreated = false
  let readerRequest: APIRequestContext | undefined

  try {
    // --- 准备：只在 default 中有 pods:get 的低权限只读用户 -------------
    const createdUser = await request.post('/api/v1/admin/users/', {
      data: { username, password, name: 'Proxy Escape Reader' },
    })
    expect(createdUser.status(), await createdUser.text()).toBe(201)
    userId = (await createdUser.json()).id as number

    const createdRole = await request.post('/api/v1/admin/roles/', {
      data: {
        // 角色是全局的（不带集群属性）：这里靠命名空间维度把它限制在 default。
        name: roleName,
        description:
          'pods:get in default only — must NOT reach secrets/services',
        namespaces: ['default'],
        resources: ['pods'],
        verbs: ['get'],
      },
    })
    expect(createdRole.status(), await createdRole.text()).toBe(201)
    roleId = (await createdRole.json()).role.id as number

    await expectStatus(
      await request.post(`/api/v1/admin/roles/${roleId}/assign`, {
        data: { subjectType: 'user', subject: username },
      }),
      201
    )

    // --- 准备：default 中一个该只读用户有权 "get" 的 pod ------------
    const createdPod = await request.post(`${clusterPath}/pods/default`, {
      data: {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: podName, labels: { 'e2e.kite.io/test': suffix } },
        spec: {
          containers: [
            { name: 'pause', image: 'registry.k8s.io/pause:3.10.1' },
          ],
        },
      },
    })
    expect(createdPod.status(), await createdPod.text()).toBe(201)
    podCreated = true

    // --- 准备：kube-system 中一个该只读用户绝不应看到的 secret ----------------
    const createdSecret = await request.post(
      `${clusterPath}/secrets/kube-system`,
      {
        data: {
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: { name: secretName, namespace: 'kube-system' },
          type: 'Opaque',
          data: { [secretProofKey]: secretProofValue },
        },
      }
    )
    expect(createdSecret.status(), await createdSecret.text()).toBe(201)
    secretCreated = true

    // 等待该 pod 可被 get 到（controller-runtime 缓存有延迟）。
    await expect
      .poll(async () => (await request.get(podPath)).status())
      .toBe(200)

    // --- 以只读用户登录 -------------------------------------------------------
    readerRequest = await playwrightRequest.newContext({
      baseURL,
      storageState: { cookies: [], origins: [] },
    })
    await expectStatus(
      await readerRequest.post('/api/auth/login/password', {
        data: { username, password },
      }),
      204
    )

    // --- 基线：该只读用户可以 get default 中的 pod --------------------------
    await expectStatus(await readerRequest.get(podPath), 200)

    // --- 基线：该只读用户不能 list/get kube-system 中的 secret --------------
    // 直接做 RBAC 校验——这正是 proxy 逃逸绝不能绕过的点。
    await expectForbidden(
      await readerRequest.get(`${clusterPath}/secrets/kube-system`),
      ['get secrets', 'namespace kube-system', clusterName]
    )
    await expectForbidden(await readerRequest.get(secretPath), [
      'get secrets',
      'namespace kube-system',
      clusterName,
    ])

    // 取出用于原始 HTTP 请求的认证 cookie。Playwright 的
    // APIRequestContext 可能会规范化 URL 中的 %2e%2e；我们需要让原始
    // 字节到达 Gin，而不经过客户端侧的路径规范化。
    const storage = await readerRequest.storageState()
    const cookieHeader = storage.cookies
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ')
    expect(cookieHeader).toContain('auth_token=')

    // --- 利用：用编码后的 .. 逃出 /proxy/ → /api/v1/namespaces/kube-system/secrets
    //
    // 发给 Kite 的 URL：
    //   /api/v1/_clusters/<cluster>/namespaces/default/pods/<pod>/proxy/%2e%2e/%2e%2e/%2e%2e/%2e%2e/kube-system/secrets
    //
    // Gin 会把解码后的 .. 片段透传给 kube/proxy.go，后者此前
    // 调用 url.JoinPath(host, "api/v1/namespaces", "default", "pods", <pod>,
    // "proxy", "/../../../../kube-system/secrets") 并把它清理为
    //   <k8s-api-host>/api/v1/namespaces/kube-system/secrets
    // 然后以 Kite 的 SA（默认 chart 中是 cluster-admin）发送。
    const dotdot = '%2e%2e'
    const escapeDepth = 4 // proxy -> pods -> default -> namespaces/
    const exploitPath = `${clusterPath}/namespaces/default/pods/${encodeURIComponent(
      podName
    )}/proxy/${Array(escapeDepth).fill(dotdot).join('/')}/kube-system/secrets`

    const exploitResponse = await sendRawHTTP(
      baseURL,
      'GET',
      exploitPath,
      cookieHeader
    )

    // --- 断言：逃逸必须被阻断 ------------------------------------------------
    // 在存在漏洞的构建上这里会失败，状态 200 且响应体为 SecretList，
    // 其中包含我们的证明用 secret——那次失败本身就是复现。
    expect(
      exploitResponse.status,
      `Proxy path escape was not blocked.\n` +
        `  Exploit URL path: ${exploitPath}\n` +
        `  Expected status: >= 400 (RBAC denial or bad request)\n` +
        `  Actual status:   ${exploitResponse.status}\n` +
        `  Response body preview: ${exploitResponse.body.slice(0, 500)}`
    ).toBeGreaterThanOrEqual(400)

    // 纵深防御：即使放宽状态码校验，证明用 secret
    // 也绝不能出现在响应体中。
    expect(
      exploitResponse.body,
      'Proof secret value leaked through proxy path escape'
    ).not.toContain(secretProofValue)
    expect(
      exploitResponse.body,
      'Proof secret name leaked through proxy path escape'
    ).not.toContain(secretName)

    // --- 同时验证逃逸到集群级 /api/v1/secrets 也被阻断 -------
    // 5 层 .. 可到达 /api/v1/secrets（集群范围的 secret 列表）。
    const clusterScopedPath = `${clusterPath}/namespaces/default/pods/${encodeURIComponent(
      podName
    )}/proxy/${Array(escapeDepth + 1)
      .fill(dotdot)
      .join('/')}/secrets`
    const clusterScopedResponse = await sendRawHTTP(
      baseURL,
      'GET',
      clusterScopedPath,
      cookieHeader
    )
    expect(
      clusterScopedResponse.status,
      `Cluster-scoped proxy escape was not blocked.\n` +
        `  Exploit URL path: ${clusterScopedPath}\n` +
        `  Actual status:   ${clusterScopedResponse.status}\n` +
        `  Response body preview: ${clusterScopedResponse.body.slice(0, 500)}`
    ).toBeGreaterThanOrEqual(400)
    expect(clusterScopedResponse.body).not.toContain(secretProofValue)
    expect(clusterScopedResponse.body).not.toContain(secretName)

    // --- 利用：在资源名中编码 .. 以到达另一个 proxy -
    // Gin 匹配 /namespaces/:namespace/:kind/:name/proxy/*path。攻击者
    // 可以把编码后的 .. 片段放进 :name，使 url.JoinPath 把
    // proxy 基路径清理成另一个 namespace/kind/name。/proxy/ 片段
    // 仍然存在，因此这只针对另一个 pods/services 的 proxy。
    const targetProxyPath = `${clusterPath}/namespaces/kube-system/services/http:kube-dns:metrics/proxy/metrics`

    const targetResponse = await request.get(targetProxyPath)
    const targetBody = await targetResponse.text()
    expect(targetResponse.status(), targetBody).toBe(200)
    expect(targetBody).toContain('# HELP')

    await expectStatus(await readerRequest.get(targetProxyPath), 403)

    const escapedName = [
      '%2e%2e',
      '%2e%2e',
      '%2e%2e',
      'namespaces',
      'kube-system',
      'services',
      'http%3akube-dns%3ametrics',
    ].join('%2f')
    const nameExploitPath = `${clusterPath}/namespaces/default/pods/${escapedName}/proxy/metrics`
    const nameExploitResponse = await sendRawHTTP(
      baseURL,
      'GET',
      nameExploitPath,
      cookieHeader
    )

    expect(
      nameExploitResponse.status,
      `Proxy resource-name escape was not blocked.\n` +
        `  Exploit URL path: ${nameExploitPath}\n` +
        `  Expected status: >= 400 (RBAC denial or bad request)\n` +
        `  Actual status:   ${nameExploitResponse.status}\n` +
        `  Response body preview: ${nameExploitResponse.body.slice(0, 500)}`
    ).toBeGreaterThanOrEqual(400)
    expect(nameExploitResponse.body).not.toContain('# HELP')

    // --- 健全性检查：合法的（不逃逸的）proxy 路径仍然可用 ------
    // 该 pod 运行 pause，因此 Kubernetes 可能返回上游的 400/404/503。
    // 验证请求没有被 Kite 的 proxy 路径校验或
    // RBAC 在到达 Kubernetes 之前拒绝。
    const legitimatePath = `${clusterPath}/namespaces/default/pods/${encodeURIComponent(
      podName
    )}/proxy/`
    const legitimateResponse = await sendRawHTTP(
      baseURL,
      'GET',
      legitimatePath,
      cookieHeader
    )
    expect(
      legitimateResponse.status,
      `Legitimate proxy access was blocked by the fix.\n` +
        `  Path: ${legitimatePath}\n` +
        `  Status: ${legitimateResponse.status}\n` +
        `  Body: ${legitimateResponse.body.slice(0, 200)}`
    ).not.toBe(403)
    expect(legitimateResponse.body).not.toContain('invalid proxy path')
  } finally {
    // --- 清理 --------------------------------------------------------------
    if (podCreated) {
      await request.delete(`${podPath}?wait=false`).catch(() => undefined)
    }
    if (secretCreated) {
      await request.delete(`${secretPath}?wait=false`).catch(() => undefined)
    }
    if (userId !== undefined) {
      await request
        .delete(`/api/v1/admin/users/${userId}`)
        .catch(() => undefined)
    }
    if (roleId !== undefined) {
      await request
        .delete(`/api/v1/admin/roles/${roleId}`)
        .catch(() => undefined)
    }
    await readerRequest?.dispose()
  }
})
