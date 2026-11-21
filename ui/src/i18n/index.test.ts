import { afterAll, describe, expect, it } from 'vitest'

import i18n from './index'

// 回归（验收台账 D-101）：`ui/index.html` 把 `<html lang="en">` 写死，代码里也从没改过，
// 于是中文界面下文档语言仍是 en —— 读屏软件的发音、字体选择与断行都按它走。
describe('文档语言跟随界面语言', () => {
  it('初始化时就同步 <html lang>', () => {
    expect(document.documentElement.lang).toBe(i18n.resolvedLanguage)
  })

  it('切换语言后同步更新', async () => {
    await i18n.changeLanguage('en')
    expect(document.documentElement.lang).toBe('en')

    await i18n.changeLanguage('zh')
    expect(document.documentElement.lang).toBe('zh')
  })

  afterAll(async () => {
    await i18n.changeLanguage('zh')
  })
})
