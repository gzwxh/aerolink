import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

import { authFile, e2eBaseUrl, englishStorageState } from './env'

const e2eDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(e2eDir, '..')
const baseURL = e2eBaseUrl
const useSystemChrome = process.env.KITE_E2E_USE_SYSTEM_CHROME === 'true'

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  timeout: 3 * 60 * 1000,
  expect: {
    timeout: 15 * 1000,
  },
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  outputDir: 'test-results',
  use: {
    baseURL,
    // 浏览器没有存储语言偏好时，控制台会回退到中文，
    // 而各测试断言的是英文文案。setup 项目会
    // 保存上下文携带的内容，因此它写入的管理员存储状态
    // 会为已认证项目保留该偏好。
    storageState: englishStorageState(),
    ...(useSystemChrome ? { channel: 'chrome' as const } : {}),
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: useSystemChrome ? 'off' : 'retain-on-failure',
  },
  webServer: process.env.KITE_E2E_BASE_URL
    ? undefined
    : {
        command: './scripts/e2e-start-app.sh',
        cwd: repoRoot,
        url: `${baseURL}/healthz`,
        timeout: 5 * 60 * 1000,
        reuseExistingServer: false,
        gracefulShutdown: {
          signal: 'SIGTERM',
          timeout: 5 * 1000,
        },
      },
  projects: [
    {
      name: 'setup',
      testMatch: /setup\/.*\.setup\.ts/,
    },
    {
      name: 'chromium',
      testIgnore: ['setup/**'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: authFile,
      },
      dependencies: ['setup'],
    },
  ],
})
