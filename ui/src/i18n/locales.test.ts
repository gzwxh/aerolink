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
})
