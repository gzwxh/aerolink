import { describe, expect, it } from 'vitest'

import type { SecuritySetting } from '@/lib/api/admin'

import { findLockoutRisks } from './security-lockout'

// 回归（验收台账 D-167）：安全设置「提交」以前没有任何二次确认——改的是全局即时
// 生效的准入策略，配错就把自己和其他管理员一起关在门外，而平台没有恢复入口。

const base: SecuritySetting = {
  loginCaptchaEnabled: false,
  inactiveUserDisableDays: 999,
  defaultUserEnabled: true,
  defaultUserExpireDays: 0,
  remoteLoginNoticeEnabled: true,
  mfaPolicy: 'disabled',
  mfaThirdPartyEnabled: true,
  mfaStepUpEnabled: true,
  mfaVerifyTtlSeconds: 60,
  otpIssuerName: '鸢联 AeroLink',
  otpVerifyWindow: 2,
  userLoginFailLimit: 7,
  userLoginBlockMinutes: 30,
  ipLoginFailLimit: 5,
  ipLoginBlockMinutes: 30,
  ipWhitelist: [],
  ipBlacklist: [],
  singleDeviceLogin: false,
  rejectUnknownUsers: false,
  loginSourceEnforced: false,
  loginSourceAllowlist: [],
  passwordExpireDays: 900,
  passwordHistoryCount: 5,
  passwordMinLength: 8,
  passwordMinClasses: 3,
  adminPasswordMinLength: 12,
  passwordRequireUppercase: true,
  passwordRequireLowercase: true,
  passwordRequireDigit: true,
  passwordRequireSpecial: true,
  sessionExpireOnBrowserClose: true,
  sessionMaxIdleMinutes: 600,
  sessionMaxHours: 24,
}

const changed = (patch: Partial<SecuritySetting>): SecuritySetting => ({
  ...base,
  ...patch,
})

describe('findLockoutRisks', () => {
  it('没有改动时不报风险', () => {
    expect(findLockoutRisks(base, { ...base })).toEqual([])
  })

  it('打开「仅允许指定来源登录」要报', () => {
    expect(
      findLockoutRisks(
        base,
        changed({
          loginSourceEnforced: true,
          loginSourceAllowlist: ['10.0.0.0/8'],
        })
      )
    ).toContain('loginSourceEnforced')
  })

  it('打开「仅允许已存在用户登录」与强制全员 MFA 都要报', () => {
    expect(
      findLockoutRisks(base, changed({ rejectUnknownUsers: true }))
    ).toEqual(['rejectUnknownUsers'])
    expect(findLockoutRisks(base, changed({ mfaPolicy: 'all' }))).toEqual([
      'mfaPolicyAll',
    ])
  })

  it('IP 白名单从空变成有内容要报（不在名单里的地址会被拒）', () => {
    expect(
      findLockoutRisks(base, changed({ ipWhitelist: ['10.1.2.3'] }))
    ).toEqual(['ipWhitelistAdded'])
  })

  // 收紧才拦：反向改动是松绑，跟着弹窗只会让人对确认麻木。
  it('松绑方向一律不报', () => {
    const enforced = changed({
      loginSourceEnforced: true,
      loginSourceAllowlist: ['10.0.0.0/8'],
      rejectUnknownUsers: true,
      mfaPolicy: 'all',
      ipWhitelist: ['10.1.2.3'],
    })
    expect(findLockoutRisks(enforced, base)).toEqual([])
  })

  it('MFA 从 disabled 直接到 admin 不算强制全员', () => {
    expect(findLockoutRisks(base, changed({ mfaPolicy: 'admin' }))).toEqual([])
  })

  it('白名单本来就有内容、只是增删条目时不再报', () => {
    const current = changed({ ipWhitelist: ['10.1.2.3'] })
    const shrink = changed({ ipWhitelist: ['10.1.2.4'] })
    // 已经处于「有白名单」状态，说明这道门本来就开着，改条目不再新引入风险。
    expect(findLockoutRisks(current, shrink)).toEqual([])
    expect(findLockoutRisks(current, changed({ ipWhitelist: [] }))).toEqual([])
  })
})
