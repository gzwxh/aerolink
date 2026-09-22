package common

import "os"

// EnvPrefix 是产品环境变量的统一前缀（如 AEROLINK_ENCRYPT_KEY）。
const EnvPrefix = "AEROLINK_"

// Getenv 读取带统一前缀的环境变量。
//
// name 是不带前缀的后半段，例如 Getenv("ENCRYPT_KEY") 读 AEROLINK_ENCRYPT_KEY。
// 变量不存在时返回空串，由调用方决定缺省行为。只打印变量名、不打印取值：
// 这些变量里多为密钥，值不能进日志。
func Getenv(name string) string {
	return os.Getenv(EnvPrefix + name)
}
