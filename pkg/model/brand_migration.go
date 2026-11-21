package model

import (
	"regexp"
	"strings"

	"k8s.io/klog/v2"
)

// 产品从 Kite 改名为鸢联 AeroLink 时，只改了代码里的默认文案。
// EnsureNotificationTemplates 只补种缺失的事件、从不回改已有行，所以改名之前建的库
// 至今仍在用 `[Kite] …` 发站内通知与邮件（验收台账 D-54）。这里做一次性回填。
//
// 只替换品牌词本身：用户在界面上改过的措辞原样保留，不会被整段重置掉。
// 已经发出的历史通知（notifications 表）**不回填**——那是事实记录，改它等于伪造历史。
const (
	legacyBrandName  = "Kite"
	currentBrandName = "鸢联"
)

// MigrateLegacyBrandNames 回填通知模板与 TOTP 签发者里残留的旧品牌名。
// 幂等：库里已经没有旧品牌词时，这一步什么都不做。
func MigrateLegacyBrandNames() error {
	var templates []NotificationTemplate
	if err := DB.Order("id ASC").Find(&templates).Error; err != nil {
		return err
	}

	updated := 0
	for _, template := range templates {
		subject := replaceLegacyBrand(template.Subject)
		body := replaceLegacyBrand(template.Body)
		if subject == template.Subject && body == template.Body {
			continue
		}
		// 用 map 更新：只碰这两列，列名也不拼进 SQL（引号由 GORM 按方言处理，
		// MySQL 的 key/groups 一类保留字才不会踩坑）
		if err := DB.Model(&NotificationTemplate{}).Where("id = ?", template.ID).
			Updates(map[string]any{"subject": subject, "body": body}).Error; err != nil {
			return err
		}
		updated++
	}
	if updated > 0 {
		klog.Infof("品牌改名回填：更新通知模板 %d 条（%s → %s）", updated, legacyBrandName, currentBrandName)
	}

	// TOTP 签发者只在它仍是旧默认值时才改：issuer 会出现在验证器 App 的条目名里，
	// 管理员自定义过的值不能覆盖。
	setting, err := GetSecuritySetting()
	if err != nil {
		// 还没建过安全设置行时 GetSecuritySetting 会报错，这一步跳过即可。
		klog.V(1).Infof("品牌改名回填：跳过 TOTP 签发者名（读取安全设置失败：%v）", err)
	} else if setting != nil && strings.TrimSpace(setting.OTPIssuerName) == legacyBrandName {
		setting.OTPIssuerName = DefaultSecuritySettingData().OTPIssuerName
		if _, err := UpdateSecuritySetting(*setting); err != nil {
			return err
		}
		klog.Infof("品牌改名回填：TOTP 签发者名 %s → %s", legacyBrandName, setting.OTPIssuerName)
	}

	return nil
}

// legacyBrandPattern 只匹配**独立**的品牌词：`[Kite]`、「登录 Kite，」都命中，
// 而 KitePaaS、kite-operator 这类更长的标识符不命中，避免连带改掉无关内容。
// 小写 kite 不改（那是另一个词，且常出现在资源名里）。
var legacyBrandPattern = regexp.MustCompile(`(^|[^A-Za-z0-9])Kite($|[^A-Za-z0-9])`)

// replaceLegacyBrand 只替换品牌词。`[Kite] 标题` 会自然变成 `[鸢联] 标题`。
// 正则的两端各吃掉一个分隔字符，相邻两次出现会共用一个字符（如「Kite,Kite」），
// 所以最多跑三轮直到没有独立品牌词为止。
func replaceLegacyBrand(text string) string {
	if !strings.Contains(text, legacyBrandName) {
		return text
	}
	for range 3 {
		if !legacyBrandPattern.MatchString(text) {
			break
		}
		text = legacyBrandPattern.ReplaceAllString(text, "${1}"+currentBrandName+"${2}")
	}
	return text
}
