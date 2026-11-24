import type { SecuritySetting } from '@/lib/api/admin'

/**
 * 会把人挡在门外的改动种类。
 *
 * 安全设置是**全局即时生效**的：保存成功的那一刻起所有账号都按新策略登录，
 * 而平台没有「恢复控制台」之类的后门入口。配错的后果不是功能不可用，而是
 * 管理员集体登不进去（验收台账 D-167）。所以这类改动要单独确认一次。
 */
export type LockoutRisk =
  | 'loginSourceEnforced'
  | 'rejectUnknownUsers'
  | 'mfaPolicyAll'
  | 'ipWhitelistAdded'

/**
 * 只在「收紧」时报告：关掉 → 打开、非 all → all、空白名单 → 有内容。
 * 反向改动是松绑，本来就没有把人挡在外面的能力，不该跟着弹确认。
 */
export function findLockoutRisks(
  current: SecuritySetting,
  next: SecuritySetting
): LockoutRisk[] {
  const risks: LockoutRisk[] = []

  if (!current.loginSourceEnforced && next.loginSourceEnforced) {
    risks.push('loginSourceEnforced')
  }
  if (!current.rejectUnknownUsers && next.rejectUnknownUsers) {
    risks.push('rejectUnknownUsers')
  }
  if (current.mfaPolicy !== 'all' && next.mfaPolicy === 'all') {
    risks.push('mfaPolicyAll')
  }
  if (current.ipWhitelist.length === 0 && next.ipWhitelist.length > 0) {
    risks.push('ipWhitelistAdded')
  }

  return risks
}
