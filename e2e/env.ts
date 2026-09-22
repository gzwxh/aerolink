import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const e2eDir = dirname(fileURLToPath(import.meta.url))

export const authFile = resolve(e2eDir, '.auth', 'admin.json')

export const adminUser = {
  username: process.env.AEROLINK_E2E_ADMIN_USERNAME || 'admin',
  name: process.env.AEROLINK_E2E_ADMIN_NAME || 'AeroLink Admin',
  password: process.env.AEROLINK_E2E_ADMIN_PASSWORD || 'KiteE2E!2345',
}

export const kindClusterName =
  process.env.AEROLINK_E2E_CLUSTER_NAME || 'kite-e2e'

// 被测集群的节点名。kind 暴露的单个节点名为
// `<cluster>-control-plane`；真实集群会报告自己的节点名，因此也允许
// 显式传入。
export const e2eNodeName =
  process.env.AEROLINK_E2E_NODE_NAME || `${kindClusterName}-control-plane`

// 套件从中导入集群的 kubeconfig context。Kite 会用 context 名来命名导入的
// 集群，因此它同时也是 API 与界面使用的集群名。
// kind 的 context 带 `kind-` 前缀；真实 kubeconfig 的 context
// 原样使用。
export const e2eContextName =
  process.env.AEROLINK_E2E_CONTEXT_NAME ||
  (kindClusterName.startsWith('kind-')
    ? kindClusterName
    : `kind-${kindClusterName}`)

export function ensureAuthDir() {
  mkdirSync(dirname(authFile), { recursive: true })
}

// 被测应用的基础 URL。放在这里是为了让 Playwright 配置之外的
// 辅助模块访问同一来源。
export const e2eBaseUrl =
  process.env.AEROLINK_E2E_BASE_URL ||
  `http://127.0.0.1:${process.env.AEROLINK_E2E_PORT || '38080'}`

// 让控制台以英文启动的存储状态。
//
// 浏览器没有存储语言偏好时，控制台会回退到中文，
// 而各测试断言的是英文文案。配置会为每个项目注入它，
// 但那些有意清理管理员会话的上下文（登录流程、匿名访问）
// 必须自己再注入一次。
export function englishStorageState(origin: string = e2eBaseUrl) {
  return {
    cookies: [],
    origins: [
      {
        origin,
        localStorage: [{ name: 'i18nextLng', value: 'en' }],
      },
    ],
  }
}
