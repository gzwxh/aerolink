/// <reference types="@testing-library/jest-dom" />
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { CreateResourceDialog } from './create-resource-dialog'

// 回归：空模板是「自由 YAML 模式」——允许多文档（多个 Deployment / StatefulSet
// 一起下发），命名空间由用户写在 YAML 里，界面不提供覆盖入口；选了具体模板则
// 仍保持原来的单选行为。

const mocks = vi.hoisted(() => ({
  templates: [] as Array<{
    id: number
    name: string
    description: string
    yaml: string
  }>,
  namespaces: [] as unknown[],
  applyResource: vi.fn(),
}))

vi.mock('@/components/simple-yaml-editor', () => ({
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

vi.mock('@/components/selector/namespace-selector', () => ({
  NamespaceSelector: () => <div data-testid="namespace-selector" />,
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock('react-i18next', () => ({
  Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  useTranslation: () => ({
    t: (key: string, options?: unknown) => {
      let template = key
      let vars: Record<string, unknown> = {}
      if (typeof options === 'string') {
        template = options
      } else if (options && typeof options === 'object') {
        const { defaultValue, ...rest } = options as Record<string, unknown>
        if (typeof defaultValue === 'string') template = defaultValue
        vars = rest
      }
      return template.replace(/\{\{(\w+)\}\}/g, (_all, name: string) =>
        String(vars[name] ?? '')
      )
    },
  }),
}))

vi.mock('@/lib/api', () => ({
  applyResource: (...args: unknown[]) => mocks.applyResource(...args),
  useResources: (resourceType: string) => ({
    data: resourceType === 'namespaces' ? mocks.namespaces : [],
    isLoading: false,
  }),
  useTemplates: () => ({ data: mocks.templates, isLoading: false }),
}))

const deploymentTemplate = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: default
spec:
  replicas: 1
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
      - name: nginx
        image: nginx:1.21`

const multiDocumentYaml = `${deploymentTemplate}
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: db
  namespace: default
spec:
  serviceName: db
  replicas: 1
  selector:
    matchLabels:
      app: db
  template:
    metadata:
      labels:
        app: db
    spec:
      containers:
      - name: postgres
        image: postgres:16`

// jsdom 没有实现 Radix Select 依赖的 Pointer Events API 与 scrollIntoView。
beforeAll(() => {
  for (const [name, value] of [
    ['hasPointerCapture', () => false],
    ['setPointerCapture', () => undefined],
    ['releasePointerCapture', () => undefined],
    ['scrollIntoView', () => undefined],
  ] as const) {
    Object.defineProperty(Element.prototype, name, {
      configurable: true,
      writable: true,
      value,
    })
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.templates = []
  mocks.namespaces = [{ metadata: { name: 'default' } }]
})

function renderDialog() {
  render(<CreateResourceDialog open onOpenChange={vi.fn()} />)
}

describe('创建资源弹窗的模板模式', () => {
  it('空模板下隐藏命名空间选择，多文档 YAML 原样下发', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    mocks.applyResource.mockResolvedValue({ message: 'ok', count: 2 })
    renderDialog()

    expect(screen.queryByTestId('namespace-selector')).not.toBeInTheDocument()
    expect(screen.getByText(/multi-document YAML/i)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('yaml-draft'), {
      target: { value: multiDocumentYaml },
    })
    await user.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() =>
      expect(mocks.applyResource).toHaveBeenCalledWith(
        multiDocumentYaml,
        undefined
      )
    )
    // 服务端回报 2 个对象时，提示里要体现数量，而不是只说「应用成功」。
    expect(toast.success).toHaveBeenCalledWith('Applied 2 resources')
  })

  it('选择具体模板后展示命名空间选择，编辑器只载入该模板', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    mocks.templates = [
      {
        id: 1,
        name: 'Deployment',
        description: '',
        yaml: deploymentTemplate,
      },
    ]
    renderDialog()

    await user.click(screen.getByRole('combobox'))
    await user.click(screen.getByRole('option', { name: 'Deployment' }))

    expect(screen.getByTestId('namespace-selector')).toBeInTheDocument()
    expect(screen.getByLabelText('yaml-draft')).toHaveValue(deploymentTemplate)
  })

  it('从模板切回空模板时清空 YAML 并重新隐藏命名空间选择', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    mocks.templates = [
      {
        id: 1,
        name: 'Deployment',
        description: '',
        yaml: deploymentTemplate,
      },
    ]
    renderDialog()

    await user.click(screen.getByRole('combobox'))
    await user.click(screen.getByRole('option', { name: 'Deployment' }))
    expect(screen.getByTestId('namespace-selector')).toBeInTheDocument()

    await user.click(screen.getByRole('combobox'))
    await user.click(screen.getByRole('option', { name: 'Empty Template' }))

    expect(screen.queryByTestId('namespace-selector')).not.toBeInTheDocument()
    expect(screen.getByLabelText('yaml-draft')).toHaveValue('')
  })
})
