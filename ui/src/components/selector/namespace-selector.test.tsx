import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
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
        <NamespaceSelector {...props} selectedNamespace="_all" />
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
    // 此前已选少于 2 个时点击条目会收起下拉，无法连续多选）。
    // 顺序按点选顺序追加（选中值本身与顺序无关，展示端只按个数/勾选态判断）。
    rerender(
      <QueryClientProvider client={qc}>
        <NamespaceSelector {...props} selectedNamespace="kube-system" />
      </QueryClientProvider>
    )
    fireEvent.click(screen.getByText('appmarket'))
    expect(handleNamespaceChange).toHaveBeenLastCalledWith(
      'kube-system,appmarket'
    )
    expect(screen.getByText('appmarket')).toBeInTheDocument()
  })

  it('单选模式点击条目后收起下拉', async () => {
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

    fireEvent.click(screen.getByText('kube-system'))
    expect(handleNamespaceChange).toHaveBeenLastCalledWith('kube-system')
    await waitFor(() => {
      expect(screen.queryByText('kube-system')).not.toBeInTheDocument()
    })
  })

  it('多选模式鼠标移出下拉区域不会收起', async () => {
    setup()
    fireEvent.click(screen.getByRole('combobox'))
    await screen.findAllByText('press')

    // 回归：此前靠 onMouseLeave 收起，鼠标一移出列表就关，无法连续勾选
    fireEvent.mouseLeave(screen.getByRole('dialog'))
    expect(screen.getByText('press')).toBeInTheDocument()
  })

  it('多选模式焦点掉到浮层外不会收起下拉', async () => {
    setup()
    fireEvent.click(screen.getByRole('combobox'))
    await screen.findAllByText('press')

    // 回归：cmdk 的条目是不可聚焦的 div，真实点击会让焦点从搜索框掉回 body，
    // Radix 据此判定「焦点离开浮层」并收起下拉，表现就是点一次就关。
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(screen.getByText('press')).toBeInTheDocument()
    outside.remove()
  })

  it('含已选项的分组整体上浮到最前，组内条目保持完整', async () => {
    useResources.mockReturnValue({ data: namespaces, isLoading: false })
    // apisix 与 appmarket 同属 press 组，这里只选 apisix
    useNamespaceBindingMap.mockReturnValue(
      new Map([
        ['apisix', 'press'],
        ['appmarket', 'press'],
      ])
    )
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={qc}>
        <NamespaceSelector
          multiple
          showAll
          selectedNamespace="apisix"
          handleNamespaceChange={vi.fn()}
        />
      </QueryClientProvider>
    )
    fireEvent.click(screen.getByRole('combobox'))
    const listbox = await screen.findByRole('listbox')

    // 含已选项的 press 组排在「其他 Namespace」之前
    const pressHeading = within(listbox).getByText('press')
    const otherHeading = within(listbox).getByText('Other namespaces')
    expect(
      pressHeading.compareDocumentPosition(otherHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    // 回归：条目没有脱离原分组，同组未选中的 appmarket 仍跟在组头之后
    const appmarketRow = within(listbox)
      .getByTitle('appmarket')
      .closest('[cmdk-item]') as HTMLElement
    expect(
      pressHeading.compareDocumentPosition(appmarketRow) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('散装的已选项上浮：其他 Namespace 分组整体排到权限绑定组之前', async () => {
    useResources.mockReturnValue({ data: namespaces, isLoading: false })
    useNamespaceBindingMap.mockReturnValue(new Map([['apisix', 'press']]))
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={qc}>
        <NamespaceSelector
          multiple
          showAll
          selectedNamespace="kube-system"
          handleNamespaceChange={vi.fn()}
        />
      </QueryClientProvider>
    )
    fireEvent.click(screen.getByRole('combobox'))
    const listbox = await screen.findByRole('listbox')

    const otherHeading = within(listbox).getByText('Other namespaces')
    const pressHeading = within(listbox).getByText('press')
    expect(
      otherHeading.compareDocumentPosition(pressHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('同一分组内已选项排到组内最前，未选中的仍按原顺序跟在后面', async () => {
    useResources.mockReturnValue({ data: namespaces, isLoading: false })
    // apisix 与 appmarket 同属 press，这里选字母序靠后的 appmarket
    useNamespaceBindingMap.mockReturnValue(
      new Map([
        ['apisix', 'press'],
        ['appmarket', 'press'],
      ])
    )
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={qc}>
        <NamespaceSelector
          multiple
          showAll
          selectedNamespace="appmarket"
          handleNamespaceChange={vi.fn()}
        />
      </QueryClientProvider>
    )
    fireEvent.click(screen.getByRole('combobox'))
    const listbox = await screen.findByRole('listbox')

    const rowOf = (name: string) =>
      within(listbox).getByTitle(name).closest('[cmdk-item]') as HTMLElement
    const selectedRow = rowOf('appmarket')
    const restRow = rowOf('apisix')
    const groupHeading = within(listbox).getByText('press')

    // 已选项升到组内第一个，但仍留在组头之后
    expect(
      groupHeading.compareDocumentPosition(selectedRow) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      selectedRow.compareDocumentPosition(restRow) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })
})
