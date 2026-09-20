/// <reference types="@testing-library/jest-dom" />
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { PVCreatePage } from './pv-create-page'

// --- mock ---

const navigate = vi.fn()
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}))

vi.mock('@/hooks/use-page-title', () => ({ usePageTitle: () => undefined }))

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

const applyResource = vi.fn()
vi.mock('@/lib/api', () => ({
  applyResource: (...args: unknown[]) => applyResource(...args),
  // 编辑模式才会用到；创建模式下页面不读它，给 undefined 即可。
  useResource: () => ({ data: undefined }),
  updateResource: vi.fn(),
  // 存储类下拉用；这里给一个已存在的类，页面不依赖它也能测。
  useResources: () => ({ data: [{ metadata: { name: 'hostpath' } }] }),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'pvCreate.name': 'Name',
        'pvCreate.capacity': 'Capacity',
        'pvCreate.capacityInvalid': 'CAPACITY_INVALID',
        'pvCreate.accessModesRequired': 'ACCESS_MODES_REQUIRED',
        'pvCreate.hostPathRequired': 'HOSTPATH_REQUIRED',
        'pvCreate.claimRefIncomplete': 'CLAIM_REF_INCOMPLETE',
        'pvCreate.claimRefNamespace': '命名空间',
        'pvCreate.claimRefName': 'PVC 名称',
        'pvCreate.noCreatePermission': 'NO_PERMISSION',
        'pvCreate.createButton': 'Create PersistentVolume',
        'pvCreate.created': 'CREATED',
        'common.actions.cancel': 'Cancel',
        'workloadWizard.requiredFields': `REQUIRED:${opts?.fields}`,
      }
      return map[key] ?? key
    },
    i18n: { language: 'en' },
  }),
}))

const canCreate = vi.fn(() => true)
vi.mock('@/hooks/use-can', () => ({
  useCan: () => canCreate,
}))

// 创建页头部会标出目标集群。
vi.mock('@/hooks/use-cluster', () => ({
  useCluster: () => ({ currentCluster: 'test-cluster' }),
}))

const renderPage = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <PVCreatePage />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

const yamlOf = () => applyResource.mock.calls[0][0] as string
const createButton = () =>
  screen.getByRole('button', { name: 'Create PersistentVolume' })

/** 填一份能通过校验的表单（默认卷来源是 hostPath）。 */
async function fillValidForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText('pv-data-01'), 'pv-data-01')
  await user.type(screen.getByPlaceholderText('10Gi'), '10Gi')
  await user.type(
    screen.getByPlaceholderText('/data/volumes/pv-data-01'),
    '/data/volumes/pv-data-01'
  )
}

beforeEach(() => {
  applyResource.mockResolvedValue({})
  canCreate.mockReturnValue(true)
})

describe('PVCreatePage', () => {
  it('submits the generated YAML and returns to the list', async () => {
    const user = userEvent.setup()
    renderPage()

    await fillValidForm(user)
    await user.click(createButton())

    await waitFor(() => expect(applyResource).toHaveBeenCalledTimes(1))
    const doc = yamlOf()
    expect(doc).toContain('name: pv-data-01')
    expect(doc).toContain('storage: 10Gi')
    expect(doc).toContain('path: /data/volumes/pv-data-01')
    expect(doc).toContain('persistentVolumeReclaimPolicy: Retain')
    expect(doc).toContain('accessModes:')
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/persistentvolumes')
    )
  })

  it('blocks a malformed capacity', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByPlaceholderText('pv-data-01'), 'pv-data-01')
    await user.type(screen.getByPlaceholderText('10Gi'), 'abc')
    await user.type(
      screen.getByPlaceholderText('/data/volumes/pv-data-01'),
      '/data/volumes/pv-data-01'
    )
    await user.click(createButton())

    expect(applyResource).not.toHaveBeenCalled()
  })

  it('blocks the submit while a required field is empty and names it', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(createButton())

    expect(applyResource).not.toHaveBeenCalled()
    // 默认卷来源是 hostPath：路径没填时直接指出缺的是它，而不是笼统的「请完善必填信息」。
    expect(toast.error).toHaveBeenCalledWith('HOSTPATH_REQUIRED')
  })

  it('blocks the submit without any access mode', async () => {
    const user = userEvent.setup()
    renderPage()

    await fillValidForm(user)
    // 默认只勾了 ReadWriteOnce，取消它之后访问模式就空了。
    await user.click(screen.getByLabelText('ReadWriteOnce'))

    expect(screen.getByText('ACCESS_MODES_REQUIRED')).toBeInTheDocument()
    await user.click(createButton())
    expect(applyResource).not.toHaveBeenCalled()
  })

  it('sends the YAML editor content once it has been edited by hand', async () => {
    const user = userEvent.setup()
    renderPage()

    await fillValidForm(user)
    const custom =
      'apiVersion: v1\nkind: PersistentVolume\nmetadata:\n  name: from-yaml\n'
    fireEvent.change(screen.getByLabelText('yaml'), {
      target: { value: custom },
    })
    await user.click(createButton())

    await waitFor(() => expect(applyResource).toHaveBeenCalledTimes(1))
    expect(yamlOf()).toBe(custom)
  })

  it('writes mount options and shows which cluster it will land in', async () => {
    const user = userEvent.setup()
    renderPage()

    // 集群级资源的创建页没有任何命名空间上下文能暗示目标集群，头部要有标注。
    const badge = await screen.findByText(/test-cluster/)
    expect(badge).toBeInTheDocument()
    expect(badge.textContent).toContain('test-cluster')

    await fillValidForm(user)
    await user.type(
      screen.getByPlaceholderText('hard, nfsvers=4.1'),
      'hard, nfsvers=4.1'
    )
    await user.click(createButton())

    await waitFor(() => expect(applyResource).toHaveBeenCalledTimes(1))
    expect(yamlOf()).toContain('mountOptions:')
    expect(yamlOf()).toContain('- nfsvers=4.1')
  })

  it('blocks a half-filled claim binding', async () => {
    const user = userEvent.setup()
    renderPage()

    await fillValidForm(user)
    await user.type(screen.getByPlaceholderText('命名空间'), 'dev')
    await user.click(createButton())

    expect(applyResource).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('CLAIM_REF_INCOMPLETE')
  })

  it('disables the submit and explains why without the create permission', async () => {
    canCreate.mockReturnValue(false)
    renderPage()

    expect(await screen.findByText('NO_PERMISSION')).toBeInTheDocument()
    expect(createButton()).toBeDisabled()
  })
})
