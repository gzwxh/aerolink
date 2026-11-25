package auth

import (
	"github.com/gzwxh/aerolink/pkg/model"
	"k8s.io/klog/v2"
)

// loginSourceDeniedCode 是「来源地址不允许」的统一错误码，前端据此给出可本地化的提示。
const loginSourceDeniedCode = "login_source_denied"

// loginSourceAllowed 报告该来源地址是否允许访问管理面。
//
// 「仅从指定来源登录」未启用、或允许列表为空时不限制。列表与登录失败白名单共用
// 同一套写法（单地址 / CIDR / 地址区间），解析见 matchIPEntry。
//
// 读不到安全设置时不封锁（fail-open）：能走到这里说明数据库通常已经不可用，
// 此时把所有人挡在门外只会让故障更难恢复；异常会留下警告日志。
func loginSourceAllowed(ip string) bool {
	setting, err := model.GetSecuritySetting()
	if err != nil {
		klog.Warningf("login source check skipped: failed to load security setting: %v", err)
		return true
	}
	if !setting.LoginSourceEnforced || len(setting.LoginSourceAllowlist) == 0 {
		return true
	}
	return matchesIPList(setting.LoginSourceAllowlist, ip)
}
