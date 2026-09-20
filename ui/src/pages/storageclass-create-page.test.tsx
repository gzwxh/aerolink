/// <reference types="@testing-library/jest-dom" />
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { StorageClassCreatePage } from './storageclass-create-page'

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
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'storageClassCreate.name': 'Name',
        'storageClassCreate.provisioner': 'Provisioner',
        'storageClassCreate.staticProvisionerHint': 'STATIC_HINT',
        'storageClassCreate.duplicateParameters': `DUP:${opts?.keys}`,
        'storageClassCreate.noCreatePermission': 'NO_PERMISSION',
        'storageClassCreate.createButton': 'Create StorageClass',
        'common.actions.cancel': 'Cancel',
        'common.actions.delete': 'Delete',
        'common.fields.key': 'Key',
        'common.fields.value': 'Value',
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
        <StorageClassCreatePage />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

const yamlOf = () => applyResource.mock.calls[0][0] as string

beforeEach(() => {
  applyResource.mockResolvedValue({})
  canCreate.mockReturnValue(true)
})

describe('StorageClassCreatePage', () => {
  it('submits the generated YAML and returns to the list', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByPlaceholderText('fast-ssd'), 'fast-ssd')
    await user.type(
      screen.getByPlaceholderText('rancher.io/local-path'),
      'rancher.io/local-path'
    )
    await user.click(
      screen.getByRole('button', { name: 'Create StorageClass' })
    )

    await waitFor(() => expect(applyResource).toHaveBeenCalledTimes(1))
    expect(yamlOf()).toContain('name: fast-ssd')
    expect(yamlOf()).toContain('provisioner: rancher.io/local-path')
    expect(yamlOf()).toContain('volumeBindingMode: Immediate')
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/storageclasses')
    )
  })

  it('blocks the submit when the name or the provisioner is missing', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(
      screen.getByRole('button', { name: 'Create StorageClass' })
    )

    expect(applyResource).not.toHaveBeenCalled()
    expect(await screen.findByText(/Name/)).toBeInTheDocument()
  })

  // 纯静态卷用 Immediate 会让 PVC 绑到 Pod 调度不上去的节点上（Bound 却一直 Pending）。
  it('switches a static provisioner to WaitForFirstConsumer and says so', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByPlaceholderText('fast-ssd'), 'static-class')
    await user.type(
      screen.getByPlaceholderText('rancher.io/local-path'),
      'kubernetes.io/no-provisioner'
    )

    expect(await screen.findByText('STATIC_HINT')).toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: 'Create StorageClass' })
    )
    await waitFor(() => expect(applyResource).toHaveBeenCalledTimes(1))
    expect(yamlOf()).toContain('volumeBindingMode: WaitForFirstConsumer')
  })

  // 同名参数在生成的 YAML 里只会保留最后一行，不能让用户以为两行都生效。
  it('marks duplicate parameter names and refuses to submit', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByPlaceholderText('fast-ssd'), 'dup-class')
    await user.type(
      screen.getByPlaceholderText('rancher.io/local-path'),
      'csi-hostpath'
    )

    const [firstKey] = screen.getAllByPlaceholderText('Key')
    await user.type(firstKey, 'server')
    await user.click(
      screen.getByRole('button', { name: /addParameter|添加参数/ })
    )

    const keys = screen.getAllByPlaceholderText('Key')
    await user.type(keys[1], 'server')

    expect(await screen.findByText('DUP:server')).toBeInTheDocument()
    expect(screen.getAllByPlaceholderText('Key')[1]).toHaveAttribute(
      'aria-invalid',
      'true'
    )

    await user.click(
      screen.getByRole('button', { name: 'Create StorageClass' })
    )
    expect(applyResource).not.toHaveBeenCalled()
  })

  it('writes allowed topologies and blocks a malformed line', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByPlaceholderText('fast-ssd'), 'topology-class')
    await user.type(
      screen.getByPlaceholderText('rancher.io/local-path'),
      'csi-hostpath'
    )

    const topology = screen.getByPlaceholderText(
      'topology.kubernetes.io/zone=cn-south-1a'
    )
    await user.type(topology, 'zone')
    await user.click(
      screen.getByRole('button', { name: 'Create StorageClass' })
    )
    expect(applyResource).not.toHaveBeenCalled()

    await user.clear(topology)
    await user.type(
      topology,
      'topology.kubernetes.io/zone=cn-south-1a,cn-south-1b'
    )
    await user.click(
      screen.getByRole('button', { name: 'Create StorageClass' })
    )
    await waitFor(() => expect(applyResource).toHaveBeenCalledTimes(1))
    expect(yamlOf()).toContain('allowedTopologies:')
    expect(yamlOf()).toContain('- cn-south-1b')
  })

  it('disables the submit and explains why without the create permission', async () => {
    canCreate.mockReturnValue(false)
    renderPage()

    expect(await screen.findByText('NO_PERMISSION')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Create StorageClass' })
    ).toBeDisabled()
  })
})
