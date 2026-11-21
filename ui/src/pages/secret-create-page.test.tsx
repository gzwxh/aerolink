/// <reference types="@testing-library/jest-dom" />
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SecretCreatePage } from './secret-create-page'

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
    // 两种写法都要解析（第二参给字符串默认值，或 opts 里带 defaultValue），
    // 否则按钮可及名会变成 i18n key。
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

const PASSWORD_B64 = 'U3VwM3JTZWNyZXQh' // Sup3rSecret!
const USERNAME_B64 = 'YWRtaW4=' // admin

const liveSecret = {
  apiVersion: 'v1',
  kind: 'Secret',
  type: 'Opaque',
  metadata: {
    name: 's-a',
    namespace: 'ns-a',
    resourceVersion: '12345',
  },
  data: { username: USERNAME_B64, password: PASSWORD_B64 },
}

const renderEditPage = async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/secrets/ns-a/s-a/edit']}>
        <Routes>
          <Route
            path="secrets/:namespace/:name/edit"
            element={<SecretCreatePage />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
  // 等线上对象反显完成（名称输入框填上 s-a）
  await waitFor(() =>
    expect(screen.getByDisplayValue('s-a')).toBeInTheDocument()
  )
  return view
}

beforeEach(() => {
  navigate.mockReset()
  applyResource.mockReset()
  applyResource.mockResolvedValue({})
  useResource.mockReturnValue({
    data: liveSecret,
    isError: false,
    error: null,
  })
})

// 产品决定（2026-11-21，台账 §22）：Secret **编辑页必须能看到原值**。
// 排障和改配置时，看不到「前面填的是什么」就等于盲改；掩码只做视觉遮挡，
// 值仍然反显进表单（详情页的「显示全部」同理）。曾试过改成「值留空 = 不改这个键」
// 以免明文进 DOM，被否掉了 —— 别再用那个方向「优化」这里。
describe('Secret 编辑页反显原值', () => {
  it('原值被填回表单（视觉掩码，不改语义）', async () => {
    const { container } = await renderEditPage()

    const masked = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="password"]')
    ).map((element) => element.value)

    expect(masked).toContain('Sup3rSecret!')
    expect(masked).toContain('admin')
    // 键名同样反显，用户知道对象里有哪些键
    expect(screen.getByDisplayValue('username')).toBeInTheDocument()
    expect(screen.getByDisplayValue('password')).toBeInTheDocument()
  })

  it('什么都不改直接保存：原值原样提交，且带上 resourceVersion', async () => {
    await renderEditPage()

    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(applyResource).toHaveBeenCalledTimes(1))
    const submitted = applyResource.mock.calls[0][0] as string
    expect(submitted).toContain('stringData:')
    expect(submitted).toContain('username: admin')
    expect(submitted).toContain('password: Sup3rSecret!')
    // D-57：编辑态要带 RV，否则并发保存会静默覆盖
    expect(submitted).toMatch(/resourceVersion:\s*['"]?12345/)
  })

  it('只改一个键：其它键保持原值', async () => {
    const { container } = await renderEditPage()

    const passwordField = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="password"]')
    ).find((element) => element.value === 'Sup3rSecret!')
    expect(passwordField).toBeDefined()

    // 敏感值输入框默认只读，聚焦后才换成可写的 textarea
    fireEvent.focus(passwordField!)
    const editables =
      container.querySelectorAll<HTMLTextAreaElement>('textarea')
    expect(editables.length).toBeGreaterThan(0)
    fireEvent.change(editables[0], { target: { value: 'NewPass2026' } })

    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(applyResource).toHaveBeenCalledTimes(1))
    const submitted = applyResource.mock.calls[0][0] as string
    expect(submitted).toContain('password: NewPass2026')
    expect(submitted).toContain('username: admin')
    expect(submitted).not.toContain('Sup3rSecret!')
  })

  it('二进制值按 base64 走 data，不会被当成文本改坏', async () => {
    // 不能安全 UTF-8 往返的内容（FF FE 00 41）
    useResource.mockReturnValue({
      data: {
        ...liveSecret,
        data: { rawbin: '//4AQQ==' },
        metadata: { ...liveSecret.metadata, resourceVersion: '12345' },
      },
      isError: false,
      error: null,
    })

    await renderEditPage()

    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(applyResource).toHaveBeenCalledTimes(1))
    const submitted = applyResource.mock.calls[0][0] as string
    expect(submitted).toContain('data:')
    expect(submitted).toContain('rawbin: //4AQQ==')
    expect(submitted).not.toContain('stringData')
  })
})
