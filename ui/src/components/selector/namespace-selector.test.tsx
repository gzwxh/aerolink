import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

import { NamespaceSelector } from './namespace-selector'

const useResources = vi.hoisted(() => vi.fn())
const useNamespaceBindingMap = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', () => ({ useResources }))

vi.mock('@/hooks/use-namespace-binding-map', () => ({ useNamespaceBindingMap }))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, second?: unknown) =>
      typeof second === 'string'
        ? second
        : ((second as { defaultValue?: string } | undefined)?.defaultValue ??
          _key),
  }),
}))

// jsdom 未实现，cmdk 选中项时会调用
Element.prototype.scrollIntoView = vi.fn()

const namespaces = [
  { metadata: { name: 'apisix' } },
  { metadata: { name: 'appmarket' } },
  { metadata: { name: 'kube-system' } },
]

function setup() {
  useResources.mockReturnValue({ data: namespaces, isLoading: false })
  // apisix 绑定到权限绑定组 press；appmarket / kube-system 未绑定
  useNamespaceBindingMap.mockReturnValue(new Map([['apisix', 'press']]))
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={qc}>
      <NamespaceSelector
        multiple
        showAll
        selectedNamespace="_all"
        handleNamespaceChange={vi.fn()}
      />
    </QueryClientProvider>
  )
}

async function openAndSearch(keyword: string) {
  fireEvent.click(screen.getByRole('combobox'))
  await screen.findAllByText('press')
  fireEvent.change(screen.getByPlaceholderText('Search...'), {
    target: { value: keyword },
  })
  await waitFor(() => {
    expect(screen.getByPlaceholderText('Search...')).toHaveValue(keyword)
  })
}

describe('NamespaceSelector', () => {
  it('不搜索时按权限绑定组分组展示，组名作为标题', async () => {
    setup()
    fireEvent.click(screen.getByRole('combobox'))

    expect(await screen.findAllByText('press')).not.toHaveLength(0)
    expect(screen.getByText('apisix')).toBeInTheDocument()
    expect(screen.getByText('kube-system')).toBeInTheDocument()
  })

  it('条目不再内联显示组名，只由组标题展示分组', async () => {
    setup()
    fireEvent.click(screen.getByRole('combobox'))

    // 组名只出现在组标题一处；条目（及其所在行）旁无内联标记
    await waitFor(() => {
      expect(screen.getByText('apisix')).toBeInTheDocument()
    })
    expect(screen.getAllByText('press')).toHaveLength(1)
    const looseItem = screen.getByText('appmarket')
    expect(within(looseItem.parentElement!).queryByText('press')).toBeNull()
  })

  it('输入权限绑定组名可命中该组下的命名空间，未命中的被移除', async () => {
    setup()
    await openAndSearch('press')

    await waitFor(() => {
      expect(screen.getByText('apisix')).toBeInTheDocument()
    })
    expect(screen.queryByText('appmarket')).not.toBeInTheDocument()
    expect(screen.queryByText('kube-system')).not.toBeInTheDocument()
  })

  it('按命名空间名搜索的行为保持不变', async () => {
    setup()
    await openAndSearch('kube-system')

    await waitFor(() => {
      expect(screen.getByText('kube-system')).toBeInTheDocument()
    })
    expect(screen.queryByText('apisix')).not.toBeInTheDocument()
    expect(screen.queryByText('appmarket')).not.toBeInTheDocument()
  })

  it('组头复选框整组选中、补齐与取消', async () => {
    useResources.mockReturnValue({ data: namespaces, isLoading: false })
    // apisix 与 appmarket 都绑定到权限绑定组 press
    useNamespaceBindingMap.mockReturnValue(
      new Map([
        ['apisix', 'press'],
        ['appmarket', 'press'],
      ])
    )
    const handleNamespaceChange = vi.fn()
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const props = {
      multiple: true as const,
      showAll: true,
      handleNamespaceChange,
    }
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <NamespaceSelector
          {...props}
          selectedNamespace="_all"
        />
      </QueryClientProvider>
    )
    fireEvent.click(screen.getByRole('combobox'))
    await screen.findAllByText('press')

    const groupBox = () =>
      screen.getByRole('checkbox', {
        // t mock 不做插值，aria-label 保留 {{name}} 占位符
        name: /Select all namespaces in group/,
      })

    // 初始 _all：点组头 = 选中组内全部
    fireEvent.click(groupBox())
    expect(handleNamespaceChange).toHaveBeenLastCalledWith('apisix,appmarket')

    // 部分选中：半选态；点组头补齐整组
    rerender(
      <QueryClientProvider client={qc}>
        <NamespaceSelector {...props} selectedNamespace="apisix" />
      </QueryClientProvider>
    )
    expect(groupBox()).toHaveAttribute('data-state', 'indeterminate')
    fireEvent.click(groupBox())
    expect(handleNamespaceChange).toHaveBeenLastCalledWith('apisix,appmarket')

    // 全部选中：点组头取消整组
    rerender(
      <QueryClientProvider client={qc}>
        <NamespaceSelector {...props} selectedNamespace="apisix,appmarket" />
      </QueryClientProvider>
    )
    expect(groupBox()).toHaveAttribute('data-state', 'checked')
    fireEvent.click(groupBox())
    expect(handleNamespaceChange).toHaveBeenLastCalledWith('_all')
  })

  it('多选模式点击条目只切换勾选，不收起下拉', async () => {
    useResources.mockReturnValue({ data: namespaces, isLoading: false })
    useNamespaceBindingMap.mockReturnValue(new Map([['apisix', 'press']]))
    const handleNamespaceChange = vi.fn()
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const props = {
      multiple: true as const,
      showAll: true,
      handleNamespaceChange,
    }
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <NamespaceSelector {...props} selectedNamespace="_all" />
      </QueryClientProvider>
    )
    fireEvent.click(screen.getByRole('combobox'))
    await screen.findAllByText('press')

    // 从「全部」点一个条目：切换为单选该条目，下拉保持打开
    fireEvent.click(screen.getByText('kube-system'))
    expect(handleNamespaceChange).toHaveBeenLastCalledWith('kube-system')
    expect(screen.getByText('kube-system')).toBeInTheDocument()

    // 已选一个时再点另一个：并入多选，下拉仍然保持打开（回归：
    // 此前已选少于 2 个时点击条目会收起下拉，无法连续多选）
    rerender(
      <QueryClientProvider client={qc}>
        <NamespaceSelector {...props} selectedNamespace="kube-system" />
      </QueryClientProvider>
    )
    fireEvent.click(screen.getByText('appmarket'))
    expect(handleNamespaceChange).toHaveBeenLastCalledWith('appmarket,kube-system')
    expect(screen.getByText('appmarket')).toBeInTheDocument()
  })

  it('单选模式选中后不立即收起，鼠标移出下拉区域才关闭', async () => {
    useResources.mockReturnValue({ data: namespaces, isLoading: false })
    useNamespaceBindingMap.mockReturnValue(new Map())
    const handleNamespaceChange = vi.fn()
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={qc}>
        <NamespaceSelector
          showAll
          selectedNamespace="_all"
          handleNamespaceChange={handleNamespaceChange}
        />
      </QueryClientProvider>
    )
    fireEvent.click(screen.getByRole('combobox'))
    await screen.findAllByText('kube-system')

    // 回归：此前单选「选中即收起」。现在选中后下拉保持打开，
    // 由鼠标移出下拉区域触发收起。
    fireEvent.click(screen.getByText('kube-system'))
    expect(handleNamespaceChange).toHaveBeenLastCalledWith('kube-system')
    expect(screen.getByText('kube-system')).toBeInTheDocument()

    fireEvent.mouseLeave(screen.getByRole('dialog'))
    await waitFor(() => {
      expect(screen.queryByText('kube-system')).not.toBeInTheDocument()
    })
  })
})
