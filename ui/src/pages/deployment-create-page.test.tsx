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

// 页面及其渲染的编辑组件里只用 useClusterNavigate 这一个导出。
vi.mock('@/lib/cluster-path', () => ({
  useClusterNavigate: () => navigate,
}))

vi.mock('@/lib/api', () => ({
  applyResource: vi.fn(),
  deleteResource: vi.fn(),
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
