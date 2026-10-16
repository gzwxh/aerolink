package common

import "testing"

func TestSlugifyClusterName(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"普通名字", "Prod Cluster", "prod-cluster"},
		{"连续非法字符折成一个连字符", "prod///cluster@2", "prod-cluster-2"},
		{"首尾非法字符被去掉", "--Prod--", "prod"},
		{"大小写归一", "PROD", "prod"},
		{"纯中文名退化为 cluster", "生产环境", "cluster"},
		{"纯符号名退化为 cluster", "///", "cluster"},
		{"超长名截断到 48", stringsRepeat("a", 60), stringsRepeat("a", 48)},
		{"截断后尾部连字符被去掉", stringsRepeat("a", 47) + "-b", stringsRepeat("a", 47)},
	}
	for _, tc := range cases {
		if got := SlugifyClusterName(tc.in); got != tc.want {
			t.Errorf("%s: SlugifyClusterName(%q) = %q, want %q", tc.name, tc.in, got, tc.want)
		}
	}
}

func stringsRepeat(s string, n int) string {
	out := ""
	for i := 0; i < n; i++ {
		out += s
	}
	return out
}
