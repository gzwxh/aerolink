package common

import (
	"os"
	"sync"

	"k8s.io/klog/v2"
)

// EnvPrefix 是产品改名后环境变量的统一前缀（如 AEROLINK_ENCRYPT_KEY）。
const EnvPrefix = "AEROLINK_"

// legacyEnvPrefix 是改名前的旧前缀，仅作兼容兜底，新部署不要再用。
const legacyEnvPrefix = "KITE_"

// legacyEnvWarned 记录已经提示过的旧变量名，保证每个变量只告警一次。
var legacyEnvWarned sync.Map

// Getenv 按新前缀读取环境变量，缺失时回落到旧前缀。
//
// name 是不带前缀的后半段，例如 Getenv("ENCRYPT_KEY") 读 AEROLINK_ENCRYPT_KEY。
//
// 为什么保留旧名而不是硬切：已经部署的清单/Secret 里写的都是 KITE_*，直接不认会让
// 升级后的实例拒绝启动（AEROLINK_ENCRYPT_KEY 缺失是 fail-fast）。所以旧名作兜底、
// 只打印一次告警；新旧同时设置时以新名为准，便于灰度迁移。
//
// 只打印变量名、不打印取值：这些变量里多为密钥，值不能进日志。
func Getenv(name string) string {
	if v, ok := os.LookupEnv(EnvPrefix + name); ok {
		return v
	}
	legacy := legacyEnvPrefix + name
	v, ok := os.LookupEnv(legacy)
	if !ok {
		return ""
	}
	if _, loaded := legacyEnvWarned.LoadOrStore(legacy, struct{}{}); !loaded {
		klog.Warningf("%s is deprecated, use %s%s instead", legacy, EnvPrefix, name)
	}
	return v
}
