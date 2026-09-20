import type { TFunction } from 'i18next'

export interface PasswordRule {
  label: string
  ok: boolean
  /** 「至少 N 类字符」的四个类别子项，仅展示用。 */
  children?: string[]
}

export interface PasswordPolicyLimits {
  minLength: number
  maxLength: number
  /** 四类字符（小写/大写/数字/特殊）至少包含的类数。 */
  minClasses: number
}

/** 与后端 DefaultSecuritySettingData 对齐的默认策略。 */
export const DEFAULT_PASSWORD_LIMITS: PasswordPolicyLimits = {
  minLength: 8,
  maxLength: 30,
  minClasses: 3,
}

/** 与后端 ValidatePassword 的字符类判定保持一致。 */
const CLASS_PATTERNS = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9\s]/]

export function passwordClassCount(value: string): number {
  return CLASS_PATTERNS.filter((re) => re.test(value)).length
}

/**
 * 按策略构建实时密码要求清单，供密码输入框下方面板展示。
 * limits 未传时使用默认策略；创建/编辑管理员时应传 AdminPasswordMinLength。
 */
export function buildPasswordRules(
  value: string,
  t: TFunction,
  limits: PasswordPolicyLimits = DEFAULT_PASSWORD_LIMITS
): PasswordRule[] {
  return [
    {
      label: t('passwordPolicy.rulesLength', {
        min: limits.minLength,
        max: limits.maxLength,
        defaultValue: `长度在 ${limits.minLength} ~ ${limits.maxLength} 位字符之间`,
      }),
      ok: value.length >= limits.minLength && value.length <= limits.maxLength,
    },
    {
      label: t('passwordPolicy.rulesNoSpace', '不能包含空格'),
      ok: !value.includes(' '),
    },
    {
      label: t('passwordPolicy.rulesNoSlashStart', '不能以 "/" 开头'),
      ok: !value.startsWith('/'),
    },
    {
      label: t('passwordPolicy.rulesMinClasses', {
        count: limits.minClasses,
        defaultValue: `至少包含以下四项中的 ${limits.minClasses} 项`,
      }),
      ok: passwordClassCount(value) >= limits.minClasses,
      children: [
        t('passwordPolicy.classLower', '小写字母 a ~ z'),
        t('passwordPolicy.classUpper', '大写字母 A ~ Z'),
        t('passwordPolicy.classDigit', '数字 0 ~ 9'),
        t(
          'passwordPolicy.classSpecial',
          "特殊字符 ()`~!@#$%^&*-+=_|{}[]:;'<>,.?/"
        ),
      ],
    },
  ]
}

export function isPasswordRulesValid(rules: PasswordRule[]): boolean {
  return rules.every((rule) => rule.ok)
}
