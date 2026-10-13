// 日志查看器的关键字命中区间计算（大小写不敏感的包含匹配，与过滤行为一致）。
// 返回 [start, end) 区间，列偏移从 0 开始。

export interface TermRange {
  start: number
  end: number
}

// 匹配前的归一化，消除复制粘贴带入的「看不见的空白」：
// 1) \r\n：行文本里不存在换行，关键字带换行（多行粘贴、输入法带入）时
//    整串匹配永远失败，直接剥掉；
// 2) 不换行空格（U+00A0）：从网页 / PDF / 聊天窗口复制时间戳等内容的
//    常见隐形差异，归一成普通空格。注意是 1:1 字符替换，
//    不影响高亮区间的列偏移。
export function normalizeSearchTerm(term: string): string {
  return term.replace(/[\r\n]/g, '').replace(/\u00a0/g, ' ')
}

// 行文本侧的匹配基线：只做 NBSP 归一 + 小写，不删字符，保证与
// findTermRanges 在同一文本上算出的区间偏移一致。
export function normalizeLineTextForSearch(text: string): string {
  return text.replace(/\u00a0/g, ' ').toLocaleLowerCase()
}

export function findTermRanges(text: string, term: string): TermRange[] {
  if (!term) {
    return []
  }
  const lower = normalizeLineTextForSearch(text)
  const needle = normalizeSearchTerm(term).toLocaleLowerCase()
  const ranges: TermRange[] = []
  let index = lower.indexOf(needle)
  while (index !== -1) {
    ranges.push({ start: index, end: index + needle.length })
    index = lower.indexOf(needle, index + needle.length)
  }
  return ranges
}
