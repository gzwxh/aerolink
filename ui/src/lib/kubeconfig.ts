import * as YAML from 'js-yaml'

/**
 * 从 kubeconfig 文本里提取 context 名列表（导入对话框里逐行填短名用）。
 * 解析失败 / 不是预期结构时返回空数组，调用方按「没有可填项」处理。
 */
export function parseKubeconfigContexts(text: string): string[] {
  if (!text.trim()) {
    return []
  }
  try {
    const doc = YAML.load(text) as { contexts?: { name?: unknown }[] } | null
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.contexts)) {
      return []
    }
    return doc.contexts
      .map((context) => context?.name)
      .filter((name): name is string => typeof name === 'string' && !!name)
  } catch {
    return []
  }
}
