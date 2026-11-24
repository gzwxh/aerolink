/// <reference types="@testing-library/jest-dom" />
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ResourceType } from '@/types/api'
import { CloneResourceDialog } from './clone-resource-dialog'

// 回归（验收台账 D-153，第 22 轮登记、第 24 轮收口）。
//
// 克隆草稿是一次性生成的 YAML 文本，`alignWorkloadSelector` 只在生成那一刻把
// Pod 标签改成 `<源名>-copy`；用户之后改名或不改名，都可能让克隆体的 selector
// 与**另一个已存在的**负载逐项相同 —— 两边控制器争抢同一批 Pod，关联 Service 的
// 端点也会跨负载混在一起，而 k8s 自身不拦这种重叠。
// 拦截逻辑本身在 lib/clone-workload.test.ts 有单测；这里钉的是**对话框真的接了线**
// 并且拦得住（漏接 case 正是 D-123 那类缺陷的形态）。

vi.mock('@/components/simple-yaml-editor', () => ({
  // 真实实现是 Monaco（@/lib/monaco-loader），jsdom 里起不来；提交读的是
  // yamlContent 状态，所以换成受控 textarea 不影响被测路径。
  SimpleYamlEditor: ({
    value,
    onChange,
  }: {
    value: string
    onChange?: (value: string | undefined) => void
  }) => (
    <textarea
      aria-label="yaml-draft"
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock('react-i18next', () => ({
  Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  useTranslation: () => ({
    t: (key: string, options?: unknown) => {
      // 带插值的调用（撞车提示要把对方名字填进去）要真做替换，
      // 否则断言「提示里写的是哪个负载」就没意义。
      if (options && typeof options === 'object' && 'defaultValue' in options) {
        const { defaultValue, ...vars } = options as Record<string, string>
        return String(defaultValue).replace(
          /\{\{(\w+)\}\}/g,
          (_all, name: string) => String(vars[name] ?? '')
        )
      }
      return key
    },
  }),
}))

const navigate = vi.fn()
vi.mock('@/lib/cluster-path', () => ({ useClusterNavigate: () => navigate }))

const mockCreateResource = vi.fn()
const mockApplyResource = vi.fn()
const mockFetchResource = vi.fn()
// 按资源类型给出「同命名空间里现存的对象」，对应对话框里的三个 useResources。
let existingByType: Record<string, unknown[]> = {}
vi.mock('@/lib/api', () => ({
  createResource: (...args: unknown[]) => mockCreateResource(...args),
  applyResource: (...args: unknown[]) => mockApplyResource(...args),
  fetchResource: (...args: unknown[]) => mockFetchResource(...args),
  useResources: (resourceType: string) => ({
    data: existingByType[resourceType] ?? [],
    isLoading: false,
  }),
}))

const source = {
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name: 'app', namespace: 'team-a' },
  spec: {
    replicas: 1,
    selector: { matchLabels: { app: 'app' } },
    template: { metadata: { labels: { app: 'app' } } },
  },
}

function workload(name: string, app: string) {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, namespace: 'team-a' },
    spec: {
      selector: { matchLabels: { app } },
      template: { metadata: { labels: { app } } },
    },
  }
}

async function openAndSubmit() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CloneResourceDialog
        open
        onOpenChange={vi.fn()}
        resourceType={'deployments' as ResourceType}
        resourceLabel="Deployment"
        sourceName="app"
        namespace="team-a"
        resource={source}
      />
    </QueryClientProvider>
  )
  // 草稿里应已把 Pod 标签对齐成 app-copy：确认测的是接了线的真实草稿而不是手搭对象。
  await waitFor(() =>
    expect(screen.getByLabelText('yaml-draft').value).toMatch(/app: app-copy/)
  )
  await userEvent.click(screen.getByRole('button', { name: /cloneResource.create/ }))
  return screen.getByLabelText('yaml-draft')
}

beforeEach(() => {
  vi.clearAllMocks()
  existingByType = {}
})

describe('克隆时的 selector 撞车拦截', () => {
  it('与另一个现存负载 selector 完全相同时拦住，且不调用任何创建接口', async () => {
    // 异名同 selector：正是第 19 轮实测到的危害（两个克隆体抢同一批 Pod）。
    existingByType = {
      deployments: [workload('shadow', 'app-copy')],
      statefulsets: [],
      daemonsets: [],
    }

    await openAndSubmit()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('shadow')
    expect(alert.textContent).toMatch(/争抢同一批 Pod/)
    expect(mockCreateResource).not.toHaveBeenCalled()
    expect(mockApplyResource).not.toHaveBeenCalled()
  })

  it('selector 不与任何现存负载重合时正常创建', async () => {
    existingByType = {
      deployments: [workload('other', 'other-x')],
      statefulsets: [],
      daemonsets: [],
    }
    mockCreateResource.mockResolvedValue({})

    await openAndSubmit()

    await waitFor(() => expect(mockCreateResource).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('草稿与它自己同名不算撞车（由服务端的存在性判断兜住）', async () => {
    // 源对象叫 app、克隆体默认叫 app-copy：如果拿 app-copy 这个**同名**对象来比，
    // 每次「克隆再克隆」都会被误拦，所以 findSelectorCollision 按名字排自身。
    existingByType = {
      deployments: [workload('app-copy', 'app-copy')],
      statefulsets: [],
      daemonsets: [],
    }
    mockCreateResource.mockResolvedValue({})

    await openAndSubmit()

    await waitFor(() => expect(mockCreateResource).toHaveBeenCalledTimes(1))
    expect(
      screen.queryByText(/选择器与已存在的工作负载「app-copy」/)
    ).not.toBeInTheDocument()
  })
})
