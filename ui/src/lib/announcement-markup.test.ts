import { describe, expect, it } from 'vitest'

import {
  ANNOUNCEMENT_COLOR_NAMES,
  ANNOUNCEMENT_COLORS,
  ANNOUNCEMENT_LEVEL_ICONS,
  announcementPlainText,
  parseAnnouncementMarkup,
} from './announcement-markup'

describe('parseAnnouncementMarkup', () => {
  it('没有标记时是一整段纯文本', () => {
    expect(parseAnnouncementMarkup('今晚 22:00 停服')).toEqual([
      { text: '今晚 22:00 停服' },
    ])
  })

  it('把具名颜色标记切成带语义色的段', () => {
    expect(
      parseAnnouncementMarkup('注意：{warning}今晚停服{/warning}，请提前保存。')
    ).toEqual([
      { text: '注意：' },
      { text: '今晚停服', color: 'warning' },
      { text: '，请提前保存。' },
    ])
  })

  it('支持跨行的颜色段与多个标记', () => {
    expect(
      parseAnnouncementMarkup(
        '{danger}第一行\n第二行{/danger} 以及 {success}已恢复{/success}'
      )
    ).toEqual([
      { text: '第一行\n第二行', color: 'danger' },
      { text: ' 以及 ' },
      { text: '已恢复', color: 'success' },
    ])
  })

  // 写错色名时必须按原文显示：吃掉标记会让管理员看不到自己写错了什么。
  it('未登记的色名按原文保留，已登记但未配对的标记被剔除', () => {
    // 未登记 = 管理员自己写错的色名，按原文显示好让他看得见。
    expect(parseAnnouncementMarkup('{rainbow}彩色{/rainbow}')).toEqual([
      { text: '{rainbow}彩色{/rainbow}' },
    ])
    // `{warning}` 已登记却没有配对（闭的是 rainbow）：标记剔除、内容留下。
    // 这类孤儿标记是畸形数据（交叉嵌套、反复上色又取消留下的），露在界面上只会更乱，
    // 而且编辑器再存一次会把它转义成 `\{warning\}`，越修越脏。
    expect(parseAnnouncementMarkup('{warning}停服{/rainbow}')).toEqual([
      { text: '停服{/rainbow}' },
    ])
  })

  it('未闭合的标记：内容留下，标记本身剔除', () => {
    expect(parseAnnouncementMarkup('{warning}停服')).toEqual([{ text: '停服' }])
  })

  // 嵌套按树解析：编辑器是 contentEditable，给一句话里几个字再单独上色时产生的就是
  // 严格嵌套的 DOM。早先把内层当原文，预览里会直接露出 `{success}` 字样。
  it('嵌套标记按树解析（内层单独着色，不再当原文）', () => {
    expect(
      parseAnnouncementMarkup('{warning}外{success}内{/success}层{/warning}')
    ).toEqual([
      {
        text: '',
        color: 'warning',
        children: [
          { text: '外' },
          { text: '内', color: 'success' },
          { text: '层' },
        ],
      },
    ])
  })

  // 手写错的交叉标记（`{a}…{b}…{/a}…{/b}`）：**配不上的标记按原文保留**，
  // 配上的部分照常着色。这样既不丢内容，管理员也能在预览里看见自己写错的那个标记。
  // 交叉结构在 contentEditable 里不可能产生（DOM 是树），所以这条只影响手写输入。
  it('交叉标记：未配对的部分剔除标记保留内容，配对部分正常着色', () => {
    expect(
      parseAnnouncementMarkup('{warning}外{success}内{/warning}层{/success}')
    ).toEqual([{ text: '外' }, { text: '内层', color: 'success' }])
  })

  it('嵌套不会丢内容（纯文本视图）', () => {
    expect(
      announcementPlainText('{warning}外{success}内{/success}层{/warning}')
    ).toBe('外内层')
  })

  // 真实线上数据（2026-09-21 的一条公告）：反复保存累积出来的畸形标记——空色段、
  // 交叉嵌套、裸露的 `**`。这类内容不能再吐出字面的 `{danger}`，否则编辑区与顶栏上
  // 会直接显示这些花括号字符，管理员看到的是一堆噪声。
  it('真实畸形数据：孤儿标记全部吃掉，文字完整保留', () => {
    const messy =
      '十公分***{danger}{primary}{/primary}{/danger}**{info}{danger}{primary}高{danger}的发{info}生过{/info}锅{/danger}***{/info}**'
    const plain = announcementPlainText(messy)
    expect(plain).not.toMatch(/\{\/?[a-z-]+\}/)
    expect(plain).toContain('生过')
    expect(plain).toContain('十公分')
  })

  it('空内容与只有标记时返回空数组', () => {
    expect(parseAnnouncementMarkup('')).toEqual([])
    expect(parseAnnouncementMarkup('{warning}{/warning}')).toEqual([])
  })
})

describe('announcementPlainText', () => {
  it('去掉颜色标记并合并空白', () => {
    expect(announcementPlainText('{warning}今晚\n  22:00{/warning} 停服')).toBe(
      '今晚 22:00 停服'
    )
  })

  it('未识别的标记不会被悄悄丢掉', () => {
    expect(announcementPlainText('{rainbow}彩色{/rainbow}')).toBe(
      '{rainbow}彩色{/rainbow}'
    )
  })
})

// 颜色只能映射到语义 token：写 Tailwind 色阶用具（text-green-600 这类）不会跟随配色
// 主题，也不在 theme-contrast.test.ts 的对比度断言范围内（见 AGENTS.md）。
describe('语义 token 约束', () => {
  it('色名只映射到语义 token', () => {
    for (const name of ANNOUNCEMENT_COLOR_NAMES) {
      expect(ANNOUNCEMENT_COLORS[name]).toMatch(
        /^text-(primary|muted|info|success|warning|attention|destructive)/
      )
      expect(ANNOUNCEMENT_COLORS[name]).not.toMatch(/-\d{2,3}$/)
    }
  })

  it('级别图标只用语义 token，且不套底色/描边', () => {
    for (const level of Object.keys(ANNOUNCEMENT_LEVEL_ICONS) as Array<
      keyof typeof ANNOUNCEMENT_LEVEL_ICONS
    >) {
      const className = ANNOUNCEMENT_LEVEL_ICONS[level]
      expect(className).toMatch(/^text-(info|warning|destructive)$/)
      // 通知栏是顶栏里的一行文字：套色框会很抢眼（§12.7 的修改就是这么定的）。
      expect(className).not.toMatch(/(bg|border)-/)
    }
  })
})
