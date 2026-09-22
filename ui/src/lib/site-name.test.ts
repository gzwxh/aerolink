import { describe, expect, it } from 'vitest'

import { SITE_NAME_MAX_LENGTH, splitSiteName } from './site-name'

describe('splitSiteName', () => {
  it('短名称原样返回一行', () => {
    expect(splitSiteName('AeroLink')).toEqual(['AeroLink'])
    expect(splitSiteName('运维平台')).toEqual(['运维平台'])
  })

  it('超过一行宽度的中文名称按宽度对半分', () => {
    // 16 个汉字：一行放不下（约 11 个），在中点断成 8 + 8。
    const name = '运维研发部控制台管理系统'
    const lines = splitSiteName(name)
    expect(lines).toHaveLength(2)
    expect(lines.join('')).toBe(name)
    expect(lines[0]).toBe('运维研发部控')
    expect(lines[1]).toBe('制台管理系统')
  })

  it('英文名优先断在空格处，且不留下多余空格', () => {
    const lines = splitSiteName('Kubernetes Control Panel')
    expect(lines).toHaveLength(2)
    expect(lines.join(' ')).toBe('Kubernetes Control Panel')
    expect(lines[0]).toBe('Kubernetes')
    expect(lines[1]).toBe('Control Panel')
    expect(lines.every((line) => line === line.trim())).toBe(true)
  })

  it('以分隔符为界的中文名断在分隔符后面', () => {
    // 11 个汉字 + 1 个 `·` = 23 个半角单位，一行（20）放不下；中点刚好在 `·` 之后。
    const name = '运维平台·研发控制台系统'
    const lines = splitSiteName(name)
    expect(lines).toHaveLength(2)
    expect(lines.join('')).toBe(name)
    expect(lines[0]).toBe('运维平台·')
    expect(lines[1]).toBe('研发控制台系统')
  })

  it('正好一行宽度的名称不折行', () => {
    // 10 个汉字 = 20 个半角单位 = 一行上限。
    expect(splitSiteName('运维研发控制台')).toEqual(['运维研发控制台'])
    expect(splitSiteName('十个字正好一行啊')).toEqual(['十个字正好一行啊'])
  })

  it('空值与空白返回单个空串（调用方按空处理）', () => {
    expect(splitSiteName('')).toEqual([''])
    expect(splitSiteName('   ')).toEqual([''])
  })

  it('折行后拼接（去掉断点处空白）等于原名', () => {
    const name = 'Operation Research & Development Department Console'
    const lines = splitSiteName(name)
    expect(lines).toHaveLength(2)
    expect(lines.join(' ')).toBe(name)
  })

  it('最多折两行（名称有上限，侧边栏不该被撑高）', () => {
    const lines = splitSiteName('运维研发部控制台管理系统综合平台')
    expect(lines).toHaveLength(2)
  })

  it('限制常量与后端一致（16）', () => {
    expect(SITE_NAME_MAX_LENGTH).toBe(16)
  })
})
