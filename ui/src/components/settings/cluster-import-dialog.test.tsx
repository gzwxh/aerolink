/// <reference types="@testing-library/jest-dom" />
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ClusterImportDialog } from './cluster-import-dialog'

// 只认代码里写了 defaultValue 的键（其余回显 key），另外补两条中文键——
// 它们的中文是唯一事实来源、代码里没写 defaultValue。
const LABELS: Record<string, string> = {
  'clusterManagement.dialog.slugExistingBadge': '已存在',
  'clusterManagement.dialog.slugExistingHint':
    '标「已存在」的 context 在平台里已有同名集群，短名在创建时已固化。',
}

vi.mock('react-i18next', () => ({
  // 未保存确认对话框用了 <Trans>，给一个最小实现（回显 key）。
  Trans: ({ i18nKey }: { i18nKey?: string }) => i18nKey ?? null,
  useTranslation: () => ({
    t: (key: string, options?: unknown) =>
      LABELS[key] ??
      (typeof options === 'string'
        ? options
        : ((options as { defaultValue?: string })?.defaultValue ?? key)),
  }),
}))

const KUBECONFIG = `apiVersion: v1
kind: Config
current-context: prod
contexts:
  - name: prod
    context:
      cluster: prod
      user: prod
  - name: staging
    context:
      cluster: staging
      user: staging
`

function dialog(existingSlugs: Record<string, string>, onSubmit: () => void) {
  return (
    <ClusterImportDialog
      open
      onOpenChange={() => {}}
      onSubmit={onSubmit}
      isSubmitting={false}
      existingSlugs={existingSlugs}
    />
  )
}

/** 打开对话框并粘贴 kubeconfig（逐行短名要等 config 有内容才会渲染）。 */
function pasteKubeconfig() {
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: KUBECONFIG },
  })
}

function slugInput(context: string) {
  return screen.getByLabelText(context) as HTMLInputElement
}

function importButton() {
  return screen.getByRole('button', { name: 'Import Clusters' })
}

describe('ClusterImportDialog 的短名置灰', () => {
  it('已有同名集群的 context 只读展示现有短名，且不进提交载荷', () => {
    const onSubmit = vi.fn()
    render(dialog({ prod: 'prod' }, onSubmit))
    pasteKubeconfig()

    // 同名集群短名固化：展示现有值 + 「已存在」标记，不可编辑。
    expect(slugInput('prod')).toHaveValue('prod')
    expect(slugInput('prod').readOnly).toBe(true)
    expect(screen.getByText('已存在')).toBeInTheDocument()
    // 新 context 照旧可填。
    expect(slugInput('staging').readOnly).toBe(false)

    fireEvent.change(slugInput('staging'), { target: { value: 'stage' } })
    fireEvent.click(importButton())

    // prod 的短名不提交：后端对同名集群只更新 config，提交上去会被静默忽略。
    expect(onSubmit).toHaveBeenCalledWith(KUBECONFIG, { staging: 'stage' })
  })

  it('先填后变成已存在的行会被丢弃，不会带着旧值提交', () => {
    const onSubmit = vi.fn()
    const { rerender } = render(dialog({}, onSubmit))
    pasteKubeconfig()

    fireEvent.change(slugInput('prod'), { target: { value: 'legacy' } })
    expect(slugInput('prod')).toHaveValue('legacy')

    // 集群列表刷新后才发现 prod 已存在（列表是 5s 轮询的）。
    rerender(dialog({ prod: 'prod' }, onSubmit))
    expect(slugInput('prod')).toHaveValue('prod')
    expect(slugInput('prod').readOnly).toBe(true)

    fireEvent.click(importButton())

    expect(onSubmit).toHaveBeenCalledWith(KUBECONFIG, {})
  })
})
