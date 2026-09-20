/**
 * 把文本复制到剪贴板。
 *
 * `navigator.clipboard` 只存在于安全上下文（HTTPS 或 localhost）中，
 * 因此通过纯 HTTP 提供的控制台（常见的内部部署方式）根本
 * 拿不到 Clipboard API。这里回退到已废弃的 `document.execCommand`
 * 方案，它在非安全来源下仍然可用。
 *
 * 返回文本是否真的进入了剪贴板，这样调用方可以提示
 * 用户手动复制，而不是报告一个从未发生的成功。
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Clipboard API 存在但被阻止（权限、焦点、嵌入的 frame）。
  }
  return execCommandCopy(text)
}

function execCommandCopy(text: string): boolean {
  if (typeof document.execCommand !== 'function') {
    return false
  }
  // 模态对话框会捕获焦点，并立刻把焦点从任何追加到 <body> 的
  // 元素上拉走，导致复制命令没有任何选中内容，
  // 因此要把这个辅助元素挂载到点击来源所在的对话框内部。
  const active = document.activeElement
  const container =
    active instanceof Element
      ? (active.closest('[role="dialog"]') ?? document.body)
      : document.body

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.top = '0'
  textarea.style.left = '-9999px'
  container.appendChild(textarea)
  try {
    textarea.select()
    textarea.setSelectionRange(0, text.length)
    // Chrome 即使在某些东西把焦点（连同选区）从我们脚下拉走时
    // 也会报告成功，因此在信任命令结果之前，
    // 要确认辅助元素仍然处于焦点状态。
    if (document.activeElement !== textarea) {
      return false
    }
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    container.removeChild(textarea)
  }
}
