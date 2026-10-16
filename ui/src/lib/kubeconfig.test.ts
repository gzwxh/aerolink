import { describe, expect, it } from 'vitest'

import { parseKubeconfigContexts } from '@/lib/kubeconfig'

// 方案 §5「前端」：解析结果只用于「逐行填短名」，任何异常都必须降级成空列表
// （不能拦下导入——短名是可选填项，拦了就没法导入 kubeconfig 了）。
describe('parseKubeconfigContexts', () => {
  it('按文件顺序取出所有 context 名', () => {
    const text = `
apiVersion: v1
kind: Config
current-context: prod
contexts:
  - name: prod
    context:
      cluster: prod-cluster
      user: prod-user
  - name: staging
    context:
      cluster: staging-cluster
      user: staging-user
`
    expect(parseKubeconfigContexts(text)).toEqual(['prod', 'staging'])
  })

  it('保留中文等非 ASCII 的 context 名', () => {
    const text = `
contexts:
  - name: 生产集群
  - name: 测试集群
`
    expect(parseKubeconfigContexts(text)).toEqual(['生产集群', '测试集群'])
  })

  it('空文本返回空列表', () => {
    expect(parseKubeconfigContexts('')).toEqual([])
    expect(parseKubeconfigContexts('   \n  ')).toEqual([])
  })

  it('没有 contexts 字段时返回空列表', () => {
    expect(
      parseKubeconfigContexts('apiVersion: v1\ncurrent-context: prod\n')
    ).toEqual([])
    expect(parseKubeconfigContexts('contexts: prod\n')).toEqual([])
    expect(parseKubeconfigContexts('null\n')).toEqual([])
  })

  it('非法 YAML 返回空列表而不是抛异常', () => {
    expect(() => parseKubeconfigContexts('a: [1, 2\n  b: {')).not.toThrow()
    expect(parseKubeconfigContexts('a: [1, 2\n  b: {')).toEqual([])
  })

  it('跳过结构不对的条目', () => {
    const text = `
contexts:
  - name: prod
  - context:
      cluster: no-name
  - name: ''
  - name: 42
  - null
`
    expect(parseKubeconfigContexts(text)).toEqual(['prod'])
  })
})
