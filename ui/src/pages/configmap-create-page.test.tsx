/// <reference types="@testing-library/jest-dom" />
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ConfigMapCreatePage } from './configmap-create-page'

// --- mock ---

const navigate = vi.hoisted(() => vi.fn())
const applyResource = vi.hoisted(() => vi.fn())
const useResource = vi.hoisted(() => vi.fn())

vi.mock('@/lib/cluster-path', () => ({
  useClusterNavigate: () => navigate,
}))

vi.mock('@/lib/api', () => ({
  applyResource,
  useResource,
  useResources: () => ({ data: [], isLoading: false }),
}))

vi.mock('@/hooks/use-can', () => ({
  useCan: () => () => true,
}))

vi.mock('@/hooks/use-page-title', () => ({ usePageTitle: () => undefined }))

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
  SimpleYamlEditor: ({ value }: { value: string }) => (
    <textarea aria-label="yaml" readOnly value={value} />
  ),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // 跟真实行为一致：两种写法都要解析（第二参给字符串默认值，或 opts 里带 defaultValue），
    // 否则按钮名会变成 i18n key，用角色名查不到。
    t: (key: string, opts?: unknown) => {
      if (typeof opts === 'string') return opts
      if (opts && typeof opts === 'object' && 'defaultValue' in opts) {
        return String((opts as { defaultValue?: string }).defaultValue ?? key)
      }
      return key
    },
    i18n: { language: 'zh' },
  }),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

Element.prototype.scrollIntoView = vi.fn()

// 线上对象：带 resourceVersion，编辑页必须把它带回去。
const liveConfigMap = {
  apiVersion: 'v1',
  kind: 'ConfigMap',
  metadata: {
    name: 'cm-a',
    namespace: 'ns-a',
    resourceVersion: '12345',
    labels: { app: 'cm-a' },
  },
  data: { key1: 'value1' },
}

const renderEditPage = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/configmaps/ns-a/cm-a/edit']}>
        <Routes>
          <Route
            path="configmaps/:namespace/:name/edit"
            element={<ConfigMapCreatePage />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  navigate.mockReset()
  applyResource.mockReset()
  applyResource.mockResolvedValue({})
  useResource.mockReturnValue({
    data: liveConfigMap,
    isError: false,
    error: null,
  })
})

// 回归（缺陷 D-57）：表单生成的 ConfigMap 不带 metadata.resourceVersion 时，
// apply 是无条件覆盖 —— 「A 打开编辑页 → B 先保存 → A 再保存」会把 B 的改动
// 无声抹掉（HTTP 200，既不报冲突也不提示刷新）。
describe('ConfigMap 编辑页的乐观锁', () => {
  it('编辑态提交的 YAML 带上线上对象的 resourceVersion', async () => {
    renderEditPage()

    // 等线上对象反显完成（名称输入框填上 cm-a）再保存，否则测的是空表单路径。
    await waitFor(() =>
      expect(screen.getByDisplayValue('cm-a')).toBeInTheDocument()
    )

    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(applyResource).toHaveBeenCalledTimes(1))
    const submitted = applyResource.mock.calls[0][0] as string
    expect(submitted).toMatch(/resourceVersion:\s*["']?12345/)
    expect(submitted).toContain('name: cm-a')
  })
})
