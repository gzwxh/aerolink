import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
 * Helm 冒烟测试：仓库添加 → App Catalog 安装 → 升级 → 回滚 → 卸载。
 *
 * 运行（对已有集群、真实 K8s）：
 *   make e2e-run-existing KUBECONFIG=~/.kube/config E2E_NODE_NAME=<node> \
 *     SPEC="specs/helm-release-local-repo.spec.ts"
 *
 * 为什么自带一个仓库：公网 chart 源（kite-org.github.io、Artifact Hub）在内网环境
 * 到不了（会 502）。这里用本机临时目录现场打一个 chart（0.1.0 / 0.2.0 两个版本），
 * 用 python3 -m http.server 提供静态 Helm 仓库，测试进程与 Kite 在同一台机器上，
 * 因此完全离线可跑。
 *
 * chart 只有一个模板：ConfigMap <release>-zz-e2e，data.message 取自
 * values.message，用来验证升级 / 回滚是否真的生效。
 */

const namespace = 'default'
const cluster = e2eContextName
const apiBase = `/api/v1/_clusters/${encodeURIComponent(cluster)}`
const chartName = 'zz-e2e-chart'
const repositoryName = 'zz-e2e-repo'

const releaseName = `zz-e2e-rel-${Date.now().toString(36)}`
const configMapName = `${releaseName}-zz-e2e`

let repoDir = ''
let server: ChildProcess | undefined
let repoUrl = ''

const chartManifest = (version: string) => `apiVersion: v2
name: ${chartName}
description: Kite e2e chart
version: ${version}
appVersion: "1.0"
`

const configMapTemplate = `apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ .Release.Name }}-zz-e2e
data:
  message: {{ .Values.message | quote }}
`

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = address && typeof address === 'object' ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

async function expectJSON<T>(response: APIResponse, status: number) {
  const text = await response.text()
  expect(response.status(), text).toBe(status)
  return JSON.parse(text) as T
}

async function getJSON<T>(request: APIRequestContext, path: string) {
  return expectJSON<T>(await request.get(path), 200)
}

async function resourceMissing(request: APIRequestContext, path: string) {
  return (await request.get(path)).status() === 404
}

/**
 * 卸载后判断 release 是否消失。
 * 注意：release 不存在时接口返回的是 500 + "release: not found"，不是 404，
 * 所以这里两种都接受。
 */
async function helmReleaseGone(request: APIRequestContext, path: string) {
  const response = await request.get(path)
  if (response.status() === 404) return true
  if (response.status() !== 500) return false
  return (await response.text()).includes('not found')
}

const configMapPath = `${apiBase}/configmaps/${namespace}/${configMapName}`
const releasePath = `${apiBase}/helmrelease/${namespace}/${releaseName}`

/**
 * 剪贴板写入 + Ctrl+V：往 Monaco 里放整段 YAML 最稳的方式。
 * scope 可以是编辑器本身，也可以是包含编辑器的弹窗。
 */
async function pasteYaml(page: Page, scope: Locator, yamlText: string) {
  const viewLines = scope.locator('.view-lines').first()
  await expect(viewLines).toBeVisible({ timeout: 60_000 })
  await viewLines.click({ position: { x: 40, y: 10 } })
  await page.evaluate(async (text) => {
    await navigator.clipboard.writeText(text)
  }, yamlText)
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await page.keyboard.press('Control+V')
  await expect(viewLines).toContainText(yamlText.split('\n')[0], {
    timeout: 15_000,
  })
}

/** 自定义 values 是弹窗里的第二个 Monaco（第一个是只读的默认 values）。 */
function customValuesEditor(dialog: Locator) {
  return dialog.locator('.monaco-editor:visible').nth(1)
}

async function expectConfigMapMessage(
  request: APIRequestContext,
  message: string
) {
  await expect
    .poll(
      async () => {
        const response = await request.get(configMapPath)
        if (!response.ok()) return `status ${response.status()}`
        const body = (await response.json()) as {
          data?: Record<string, string>
        }
        return body.data?.message ?? ''
      },
      {
        timeout: 120_000,
        message: `ConfigMap ${configMapName} should carry message ${message}`,
      }
    )
    .toBe(message)
}

test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

test.beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), 'kite-e2e-helm-'))
  const chartDir = join(repoDir, 'chart')
  const packageDir = join(repoDir, 'repo')
  mkdirSync(join(chartDir, 'templates'), { recursive: true })
  mkdirSync(packageDir, { recursive: true })

  writeFileSync(join(chartDir, 'Chart.yaml'), chartManifest('0.1.0'))
  writeFileSync(join(chartDir, 'values.yaml'), 'message: v1\n')
  writeFileSync(
    join(chartDir, 'templates', 'configmap.yaml'),
    configMapTemplate
  )
  execFileSync('helm', ['package', chartDir, '-d', packageDir], {
    stdio: 'pipe',
  })

  // 第二个版本，用来验证「升级到新 chart 版本」。
  writeFileSync(join(chartDir, 'Chart.yaml'), chartManifest('0.2.0'))
  execFileSync('helm', ['package', chartDir, '-d', packageDir], {
    stdio: 'pipe',
  })

  const port = await getFreePort()
  repoUrl = `http://127.0.0.1:${port}`
  execFileSync('helm', ['repo', 'index', packageDir, '--url', repoUrl], {
    stdio: 'pipe',
  })

  server = spawn(
    'python3',
    [
      '-m',
      'http.server',
      String(port),
      '--bind',
      '127.0.0.1',
      '--directory',
      packageDir,
    ],
    { stdio: 'ignore' }
  )

  await expect
    .poll(
      async () => {
        const response = await fetch(`${repoUrl}/index.yaml`).catch(
          () => undefined
        )
        return response?.ok ?? false
      },
      {
        timeout: 30_000,
        message: 'local chart repository should serve index.yaml',
      }
    )
    .toBe(true)
})

test.afterAll(async ({ request }) => {
  // 用例失败时也不把 release 留在集群里（Release 删掉后 chart 里的对象会一起回收）。
  await request.delete(releasePath).catch(() => undefined)
  server?.kill('SIGTERM')
  server = undefined
  if (repoDir) {
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test.describe('helm release lifecycle', () => {
  test('adds a repository, then installs, upgrades, rolls back and uninstalls a release', async ({
    page,
    request,
  }) => {
    // ---- 1. 添加仓库（App Catalog → Repositories → Add Repository）----
    await page.goto('/charts')
    await page.getByRole('radio', { name: 'Repositories' }).click()
    await page.getByRole('button', { name: 'Add Repository' }).first().click()

    const repoDialog = page.getByRole('dialog', { name: 'Add Repository' })
    await expect(repoDialog).toBeVisible()
    await repoDialog.locator('#helm-repository-name').fill(repositoryName)
    await repoDialog.locator('#helm-repository-url').fill(repoUrl)
    await repoDialog.getByRole('button', { name: 'Add' }).click()
    await expect(repoDialog).toBeHidden({ timeout: 30_000 })

    const chartLink = page.getByRole('link', { name: chartName, exact: true })
    await expect(chartLink).toBeVisible({ timeout: 30_000 })

    // ---- 2. 安装 ----
    await chartLink.click()
    await page.waitForURL(`**/charts/${repositoryName}/${chartName}`, {
      timeout: 30_000,
    })
    await page.getByRole('button', { name: 'Install', exact: true }).click()

    const installDialog = page.getByRole('dialog', { name: 'Install' })
    await expect(installDialog).toBeVisible()
    await installDialog.locator('#helm-release-name').fill(releaseName)
    await installDialog.locator('#helm-release-namespace').fill(namespace)
    await pasteYaml(page, customValuesEditor(installDialog), 'message: v1\n')
    await installDialog
      .getByRole('button', { name: 'Install', exact: true })
      .click()
    await expect(installDialog).toBeHidden({ timeout: 120_000 })

    await expectConfigMapMessage(request, 'v1')
    const installedRelease = await getJSON<{ metadata: { name: string } }>(
      request,
      releasePath
    )
    expect(installedRelease.metadata.name).toBe(releaseName)

    // ---- 3. 升级：改 values（同版本升级也会生成新 revision）----
    await page.goto(`/helmrelease/${namespace}/${releaseName}`)
    await page.getByRole('button', { name: 'Upgrade', exact: true }).click()

    const upgradeDialog = page.getByRole('dialog', { name: 'Upgrade' })
    await expect(upgradeDialog).toBeVisible()
    await pasteYaml(page, customValuesEditor(upgradeDialog), 'message: v2\n')
    await upgradeDialog
      .getByRole('button', { name: 'Upgrade', exact: true })
      .click()
    await expect(upgradeDialog).toBeHidden({ timeout: 120_000 })

    await expectConfigMapMessage(request, 'v2')

    // ---- 4. 回滚到上一版本 ----
    await page.getByRole('tab', { name: 'History' }).click()
    const rollback = page.getByRole('button', { name: 'Rollback', exact: true })
    await expect(rollback).toBeVisible({ timeout: 30_000 })
    await rollback.click()

    const rollbackDialog = page.getByRole('dialog', {
      name: 'Rollback release?',
    })
    await expect(rollbackDialog).toBeVisible()
    await rollbackDialog
      .getByRole('button', { name: 'Rollback', exact: true })
      .click()
    await expectConfigMapMessage(request, 'v1')

    // ---- 5. 卸载 ----
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    const deleteDialog = page.getByRole('dialog', {
      name: 'Delete Helm Release',
    })
    await expect(deleteDialog).toBeVisible()
    await deleteDialog.locator('#confirmation').fill(releaseName)
    await deleteDialog
      .getByRole('button', { name: 'Delete', exact: true })
      .click()

    await expect
      .poll(async () => helmReleaseGone(request, releasePath), {
        timeout: 120_000,
        message: 'helm release should be uninstalled',
      })
      .toBe(true)
    await expect
      .poll(async () => resourceMissing(request, configMapPath), {
        timeout: 120_000,
        message: 'chart resources should be removed with the release',
      })
      .toBe(true)
  })
})
