/// <reference types="@testing-library/jest-dom" />
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  emptyPortRow,
  type PortRow,
  type ServicePortErrorCode,
} from '@/lib/service-yaml'

import { ServicePortsEditor } from './service-ports-editor'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // 第二参数可能是字符串兜底，也可能是带 defaultValue 的插值选项（真实 i18next 两者都收）。
    t: (_key: string, second?: unknown) =>
      typeof second === 'string'
        ? second
        : ((second as { defaultValue?: string } | undefined)?.defaultValue ??
          _key),
  }),
}))

// 默认「不知道集群的 NodePort 范围」：此时不提示具体数字、也不做范围校验
// （口径见 lib/node-port-range.ts）。
const nodePortRangeMock = vi.hoisted(() => ({
  value: null as { min: number; max: number } | null,
}))
vi.mock('@/hooks/use-node-port-range', () => ({
  useNodePortRange: () => nodePortRangeMock.value,
}))

const row = (overrides: Partial<PortRow> = {}): PortRow => ({
  ...emptyPortRow(),
  ...overrides,
})

const renderEditor = (
  ports: PortRow[],
  options: {
    serviceType?: 'ClusterIP' | 'NodePort' | 'LoadBalancer' | 'ExternalName'
    errors?: Map<number, ServicePortErrorCode>
    onChange?: (ports: PortRow[]) => void
  } = {}
) => {
  const onChange = options.onChange ?? vi.fn()
  const result = render(
    <ServicePortsEditor
      ports={ports}
      serviceType={options.serviceType ?? 'ClusterIP'}
      errors={options.errors}
      onChange={onChange}
    />
  )
  return { ...result, onChange }
}

describe('ServicePortsEditor', () => {
  it('只有 NodePort 类型才显示监听端口列，范围未知时不写死数字', () => {
    const { rerender } = renderEditor([row()])
    expect(screen.queryByPlaceholderText('留空自动分配')).toBeNull()

    rerender(
      <ServicePortsEditor
        ports={[row()]}
        serviceType="NodePort"
        onChange={vi.fn()}
      />
    )
    expect(screen.getByPlaceholderText('留空自动分配')).toBeInTheDocument()
    expect(
      screen.getByText('留空自动分配，端口范围以集群实际配置为准')
    ).toBeInTheDocument()
  })

  it('改端口会把整份端口行回传', () => {
    const { onChange } = renderEditor([row({ port: '80' })])

    fireEvent.change(screen.getByPlaceholderText('端口 *'), {
      target: { value: '8080' },
    })

    expect(onChange).toHaveBeenCalledWith([row({ port: '8080' })])
  })

  it('添加与删除端口行', () => {
    const onChange = vi.fn()
    const { rerender } = renderEditor([row()], { onChange })

    fireEvent.click(screen.getByText('添加端口'))
    expect(onChange).toHaveBeenCalledWith([row(), emptyPortRow()])

    rerender(
      <ServicePortsEditor
        ports={[row(), row({ port: '81' })]}
        serviceType="ClusterIP"
        onChange={onChange}
      />
    )
    fireEvent.click(screen.getAllByLabelText('移除该端口')[0])
    expect(onChange).toHaveBeenLastCalledWith([row({ port: '81' })])
  })

  it('行内错误按错误码给文案并标红对应输入框', () => {
    renderEditor([row({ port: '8080', targetPort: 'Bad_Name' })], {
      errors: new Map([[0, 'targetPortName']]),
    })

    expect(
      screen.getByText(
        '目标端口要么是 1-65535 的数字，要么是合法的端口名（小写字母/数字/-，最长 15 个字符）'
      )
    ).toBeInTheDocument()
  })

  it('拿到集群真实范围时提示具体范围，并按其给出错误文案', () => {
    nodePortRangeMock.value = { min: 20000, max: 30000 }
    try {
      renderEditor([row({ nodePort: '31000' })], {
        serviceType: 'NodePort',
        errors: new Map([[0, 'nodePortRange']]),
      })

      expect(
        screen.getByText('NodePort 范围 20000-30000，留空自动分配')
      ).toBeInTheDocument()
      expect(
        screen.getByText('NodePort 必须为 20000-30000')
      ).toBeInTheDocument()
    } finally {
      nodePortRangeMock.value = null
    }
  })
})
