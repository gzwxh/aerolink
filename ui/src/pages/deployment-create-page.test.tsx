/// <reference types="@testing-library/jest-dom" />
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DeploymentCreatePage } from './deployment-create-page'

// --- mock ---

const navigate = vi.hoisted(() => vi.fn())
const useResource = vi.hoisted(() => vi.fn())
const useResources = vi.hoisted(() => vi.fn())
const fetchResources = vi.hoisted(() => vi.fn())

// 页面及其渲染的编辑组件里只用 useClusterNavigate 这一个导出。
vi.mock('@/lib/cluster-path', () => ({
  useClusterNavigate: () => navigate,
}))

vi.mock('@/lib/api', () => ({
  applyResource: vi.fn(),
  deleteResource: vi.fn(),
  fetchResources,
  useResource,
  useResources,
}))

vi.mock('@/hooks/use-can', () => ({
  useCan: () => () => true,
}))

vi.mock('@/hooks/use-page-title', () => ({ usePageTitle: () => undefined }))

// 页面头部会标出目标集群；这里不关心，给 null 让徽章不渲染。
vi.mock('@/hooks/use-cluster', () => ({
  useCluster: () => ({ currentCluster: null, clusters: [] }),
}))

vi.mock('@/lib/unsaved-edits', () => ({
  useUnsavedEdits: () => undefined,
}))

vi.mock('@/hooks/use-namespace-binding-map', () => ({
  useNamespaceBindingMap: () => new Map(),
}))

// Monaco 在 jsdom 里跑不起来：换成一个纯文本域，仍然受控。
vi.mock('@/components/simple-yaml-editor', () => ({
  SimpleYamlEditor: ({
    value,
    onChange,
  }: {
    value: string
    onChange: (value: string) => void
  }) => (
    <textarea
      aria-label="yaml"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      (opts?.defaultValue as string | undefined) ?? key,
    i18n: { language: 'zh' },
  }),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

// jsdom 未实现，cmdk 选中项时会调用
Element.prototype.scrollIntoView = vi.fn()

const deployment = {
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: {
    name: 'web',
    namespace: 'ns-a',
    labels: { app: 'web' },
  },
  spec: {
    replicas: 2,
    selector: { matchLabels: { app: 'web' } },
    template: {
      metadata: { labels: { app: 'web' } },
      spec: {
        containers: [{ name: 'app', image: 'nginx:1.25' }],
      },
    },
  },
}

const namespaces = [
  { metadata: { name: 'ns-a' } },
  { metadata: { name: 'ns-b' } },
]

useResource.mockReturnValue({
  data: deployment,
  isError: false,
  error: null,
})
useResources.mockImplementation((resource: string) => {
  if (resource === 'namespaces') return { data: namespaces, isLoading: false }
  return { data: [], isLoading: false }
})
fetchResources.mockResolvedValue({ items: [] })

const renderClonePage = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/deployments/ns-a/web/clone']}>
        <Routes>
          <Route
            path="deployments/:namespace/:name/clone"
            element={<DeploymentCreatePage clone />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

const renderEditPage = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/deployments/ns-a/web/edit']}>
        <Routes>
          <Route
            path="deployments/:namespace/:name/edit"
            element={<DeploymentCreatePage />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  navigate.mockClear()
})

describe('DeploymentCreatePage 克隆', () => {
  it('克隆页修改目标命名空间时保留已反显的克隆数据，不跳回创建页', async () => {
    renderClonePage()

    // 克隆数据反显：名字带 -copy 后缀、镜像已带入。
    expect(await screen.findByDisplayValue('web-copy')).toBeInTheDocument()

    // 打开命名空间选择器，切到 ns-b。
    fireEvent.click(screen.getByRole('combobox'))
    await screen.findAllByText('ns-b')
    fireEvent.click(screen.getByText('ns-b'))

    // 回归：此前这里会 navigate 到 /deployments/ns-b/create，
    // 使页面离开克隆模式、把反显的表单重置成空白。
    expect(navigate).not.toHaveBeenCalled()

    // 命名空间已切换，但克隆出的名称（以及其余表单数据）仍在。
    await waitFor(() => {
      expect(screen.getByRole('combobox')).toHaveTextContent('ns-b')
    })
    expect(screen.getByDisplayValue('web-copy')).toBeInTheDocument()
  })
})

// 回归（缺陷 D-30）：编辑页只要拉不到同命名空间的 Service（典型如只给了
// deployments/pods 权限、没给 services:get 的角色），就会永远停在加载态，
// 并把同一个 403 每秒重发几十次。Service 列表只是「网络」区块的反显素材，
// 它失败必须降级为「无 Service」继续渲染，而且只该请求一次。
describe('DeploymentCreatePage 编辑', () => {
  it('Service 列表被 RBAC 拒绝时仍能进入编辑表单，且只请求一次', async () => {
    fetchResources.mockRejectedValueOnce(
      new Error(
        'user alice does not have permission to get services in namespace ns-a on cluster prod'
      )
    )

    const { container } = renderEditPage()

    // 卡在加载态时页面只有一个转圈，连标签栏都不会挂载（实测 role=tab = 0）。
    await waitFor(() => {
      expect(container.querySelectorAll('[role=tab]').length).toBeGreaterThan(0)
    })
    expect(fetchResources).toHaveBeenCalledTimes(1)
  })
})
