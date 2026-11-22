import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import en from './locales/en.json'
import zh from './locales/zh.json'

function flattenKeys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [prefix]
  }
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, child]) => flattenKeys(child, prefix ? `${prefix}.${key}` : key)
  )
}

// 只匹配字面量键：动态拼出来的键没法静态校验。
const KEY_REFERENCE = /\bt\(\s*['"]([A-Za-z0-9_.-]+)['"]/g

function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return collectSourceFiles(path)
    if (!/\.(ts|tsx)$/.test(entry) || entry.includes('.test.')) return []
    return [path]
  })
}

function referencedKeys(): Map<string, string> {
  const refs = new Map<string, string>()
  for (const file of collectSourceFiles(join(process.cwd(), 'src'))) {
    for (const match of readFileSync(file, 'utf-8').matchAll(KEY_REFERENCE)) {
      if (!refs.has(match[1])) refs.set(match[1], file)
    }
  }
  return refs
}

describe('i18n 语言包', () => {
  const zhKeys = new Set(flattenKeys(zh))
  const enKeys = new Set(flattenKeys(en))

  // zh.json 是唯一事实来源：键缺失时 t() 会退回行内 defaultValue，
  // 默认值是英文的话中文界面就会冒出英文原文（见 AGENTS.md）。
  it('zh.json 覆盖代码里引用的所有键', () => {
    const missing = [...referencedKeys()]
      .filter(([key]) => !zhKeys.has(key))
      .map(([key, file]) => `${key} (${file})`)
    expect(missing).toEqual([])
  })

  it('en.json 与 zh.json 的键集合一致', () => {
    expect([...enKeys].filter((key) => !zhKeys.has(key))).toEqual([])
    expect([...zhKeys].filter((key) => !enKeys.has(key))).toEqual([])
  })

  // 回归（第 16 轮 D-128）：`common.messages.*` 这类公共提示带 `{{resource}}` 插值，
  // 调用处只给第二个参当 defaultValue 而不传 resource 时，zh.json 的模板会生效，
  // 占位符就原样贴到界面上（公告管理的「{{resource}}删除成功」）。
  // 模板需要什么参数，调用处就必须给什么 —— 从 zh.json 反推，不写死键名。
  it('带插值的公共提示，每一处调用都传齐了参数', () => {
    const messages = (zh as { common: { messages: Record<string, unknown> } })
      .common.messages
    const required = new Map<string, string[]>()
    for (const [key, value] of Object.entries(messages)) {
      const names = [...String(value).matchAll(/\{\{(\w+)\}\}/g)].map(
        (m) => m[1]
      )
      if (names.length > 0) required.set(key, names)
    }
    // 带插值的模板是这个扫描的前提；一个都没有说明语言包改了，该连同本断言一起收拾
    expect(required.size).toBeGreaterThan(0)

    const offenders: string[] = []
    for (const file of collectSourceFiles(join(process.cwd(), 'src'))) {
      const text = readFileSync(file, 'utf-8')
      for (const [key, names] of required) {
        const needle = `t('common.messages.${key}'`
        for (
          let at = text.indexOf(needle);
          at !== -1;
          at = text.indexOf(needle, at + 1)
        ) {
          // 取调用开头往后一段：参数对象是跨行写的，窗口要够包住
          const call = text.slice(at, at + 240)
          for (const name of names) {
            // `resource: x` 与 ES6 简写 `{ ready, desired }` 两种写法都算传了参数
            const passed =
              call.includes(`${name}:`) ||
              new RegExp(`[,{]\\s*${name}\\s*[,}]`).test(call)
            if (!passed) {
              offenders.push(`${key} 缺 ${name} -> ${file}`)
            }
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
