package middleware

import "testing"

// 集群名经 x-cluster-name 传输时是 URL 编码的（HTTP 头只能带 ASCII）：写审计记录、
// 选集群都必须先解码，否则库里存的是编码串（界面乱码、按集群筛选也匹配不上）。
func TestDecodeClusterName(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"编码过的中文名还原", "%E7%94%9F%E4%BA%A7%E7%8E%AF%E5%A2%83", "生产环境"},
		{"未编码的名称原样返回", "prod-cluster", "prod-cluster"},
		{"空值返回空", "", ""},
		{"非法转义原样返回（不带病落库，也不拦请求）", "%E7%ZZ", "%E7%ZZ"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := DecodeClusterName(test.input); got != test.want {
				t.Errorf("DecodeClusterName(%q) = %q, want %q", test.input, got, test.want)
			}
		})
	}
}
