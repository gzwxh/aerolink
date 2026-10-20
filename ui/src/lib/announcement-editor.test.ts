import { describe, expect, it } from 'vitest'

import {
  ANNOUNCEMENT_COLOR_ATTRIBUTE,
  announcementMarkupToHtml,
  htmlToAnnouncementMarkup,
} from './announcement-editor'

/** 用真实 DOM 解析一段编辑器 HTML（测试里我们自己写 html，应用里只由 markupToHtml 产出）。 */
function parse(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  return root
}

function roundTrip(markup: string): string {
  return htmlToAnnouncementMarkup(parse(announcementMarkupToHtml(markup)))
}

describe('announcementMarkupToHtml', () => {
  it('转义文本，不会把尖括号当成标签', () => {
    expect(announcementMarkupToHtml('<img src=x onerror=alert(1)>')).toBe(
      '&lt;img src=x onerror=alert(1)&gt;'
    )
  })

  it('行内标记铺成对应标签', () => {
    expect(announcementMarkupToHtml('**粗** *斜* ~~删~~ `码`')).toBe(
      '<strong>粗</strong> <em>斜</em> <del>删</del> <code>码</code>'
    )
  })

  it('颜色标记铺成带 data 属性与语义色 class 的 span，换行铺成 br', () => {
    // class 是必须的：只有 data 属性时编辑区看不到颜色（顶栏却有），两者就对不上了。
    expect(announcementMarkupToHtml('{warning}停服{/warning}\n第二行')).toBe(
      `<span ${ANNOUNCEMENT_COLOR_ATTRIBUTE}="warning" class="text-warning">停服</span><br>第二行`
    )
  })

  // 畸形数据（交叉嵌套、反复上色取消留下的孤儿标记）不能在界面上以字面 `{danger}` 露出来。
  it('配对失败的孤儿色标被吃掉，未登记色名保持原样', () => {
    expect(announcementMarkupToHtml('{warning}没了{/danger}正文')).toBe(
      '没了正文'
    )
    expect(announcementMarkupToHtml('{rainbow}彩色{/rainbow}')).toBe(
      '{rainbow}彩色{/rainbow}'
    )
  })

  it('未登记的色名按原文保留', () => {
    expect(announcementMarkupToHtml('{rainbow}彩色{/rainbow}')).toBe(
      '{rainbow}彩色{/rainbow}'
    )
  })

  // 转义过的元字符必须是**字面量**：否则用户敲的 `**` 在编辑区显示星号、展示侧却被当加粗，
  // 两边对不上（这正是「输入区里什么样、展示就什么样」被破坏的地方）。
  it('转义的字面元字符原样铺开，不会被当成标记', () => {
    expect(announcementMarkupToHtml('\\*\\*注意\\*\\*')).toBe('**注意**')
    expect(announcementMarkupToHtml('\\{warning}不急\\{/warning}')).toBe(
      '{warning}不急{/warning}'
    )
  })

  it('真标记与转义后的字面量能同时存在', () => {
    expect(announcementMarkupToHtml('**粗** 与 \\*\\*字面\\*\\*')).toBe(
      '<strong>粗</strong> 与 **字面**'
    )
  })

  it('链接标记铺成 a，不允许的协议保持原文', () => {
    expect(announcementMarkupToHtml('[文档](https://example.com/a)')).toBe(
      '<a href="https://example.com/a">文档</a>'
    )
    // 面板里贴进 javascript: 时不生成标签，编辑区与顶栏都不会把它当链接。
    expect(announcementMarkupToHtml('[点我](javascript:alert)')).toBe(
      '[点我](javascript:alert)'
    )
  })
})

describe('htmlToAnnouncementMarkup', () => {
  it('按标签白名单还原成标记', () => {
    expect(
      htmlToAnnouncementMarkup(
        parse(
          `<strong>粗</strong><em>斜</em><del>删</del><code>码</code><span ${ANNOUNCEMENT_COLOR_ATTRIBUTE}="danger">红</span>`
        )
      )
    ).toBe('**粗***斜*~~删~~`码`{danger}红{/danger}')
  })

  // 编辑器里不要的标签（粘贴、浏览器自动包裹、脚本注入）只保留文字。
  it('未知元素只取文字，脚本与属性一律丢弃', () => {
    expect(
      htmlToAnnouncementMarkup(
        parse(
          '<table><tr><td>表格</td></tr></table><script>alert(1)</script><span style="color:red">红</span><img src="x">'
        )
      )
    ).toBe('表格alert(1)红')
  })

  it('回车生成的块级元素当作换行，首尾不留空行', () => {
    expect(htmlToAnnouncementMarkup(parse('<div>一</div><div>二</div>'))).toBe(
      '一\n二'
    )
    expect(htmlToAnnouncementMarkup(parse('一<div>二</div>'))).toBe('一\n二')
    // Chrome 常在末尾留一个空的 div + br
    expect(
      htmlToAnnouncementMarkup(parse('<div>一</div><div><br></div>'))
    ).toBe('一')
  })

  it('链接地址往返，括号与空格编码后仍可解析', () => {
    expect(
      htmlToAnnouncementMarkup(
        parse('<a href="https://example.com/a b">文档</a>')
      )
    ).toBe('[文档](https://example.com/a%20b)')
  })

  // 不允许的协议只留文字：顶栏的 urlTransform 本来就会清空这类地址，
  // 编辑器再把它写成链接标记只会「输入区是链接、线上不是」。
  it('不允许的协议只保留文字', () => {
    expect(
      htmlToAnnouncementMarkup(parse('<a href="javascript:alert">点我</a>'))
    ).toBe('点我')
  })

  it('未登记的 data 颜色属性不会变成标记', () => {
    expect(
      htmlToAnnouncementMarkup(
        parse(`<span ${ANNOUNCEMENT_COLOR_ATTRIBUTE}="rainbow">彩色</span>`)
      )
    ).toBe('彩色')
  })

  // 文本节点里的元字符要转义后再落库，展示侧才会当字面量渲染。
  it('文本里的元字符输出成转义形式', () => {
    expect(htmlToAnnouncementMarkup(parse('**字面** 与 # 井号'))).toBe(
      '\\*\\*字面\\*\\* 与 \\# 井号'
    )
  })
})

// 编辑器每敲一个字都会走一遍「DOM → 标记」，标记本身不能再被第二次序列化改形，
// 否则光标位置与内容会随着输入漂移。
describe('往返稳定', () => {
  const cases = [
    '今晚 22:00 停服',
    '**注意**：请提前保存',
    '{warning}停服{/warning}\n第二行',
    '**加粗** 与 {success}绿色{/success} 混排',
    '`kubectl get pods` 会只读',
    '[文档](https://example.com)',
    // 字面量（转义过的元字符）往返后不能变形，否则用户敲一次星号就多一个反斜杠。
    // 花括号必须**成对**转义：编辑器序列化会把 `{` 与 `}` 一起转义，`\{warning}` 这种
    // 只转义开括号的写法不是编辑器产出的形式，拿它当往返基准没有意义。
    '\\*\\*字面星号\\*\\*',
    '\\{warning\\}不是色标\\{/warning\\}',
    // 方括号也是元字符：字面量不能被当成链接。
    '\\[不是链接\\](https://example.com)',
  ]
  for (const markup of cases) {
    it(JSON.stringify(markup), () => {
      expect(roundTrip(markup)).toBe(markup)
      // 二次往返必须和一次往返一致（幂等）
      expect(roundTrip(roundTrip(markup))).toBe(markup)
    })
  }
})
