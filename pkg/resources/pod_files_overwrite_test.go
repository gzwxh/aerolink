package resources

import (
	"strings"
	"testing"
)

// 回归（缺陷 D-14）：同名文件不能再用「已上传」一句带过地静默覆盖。
// 这里覆盖判定本身；探测与响应链路在真机验证里跑（需要能 exec 的容器）。
func TestUploadOverwriteBlocked(t *testing.T) {
	existing := containerPathProbe{Exists: true}
	absent := containerPathProbe{}
	unsupported := containerPathProbe{Unsupported: true}

	cases := []struct {
		name      string
		overwrite string
		probe     containerPathProbe
		want      bool
	}{
		{"同名文件默认必须被挡下", "", existing, true},
		{"确认后允许覆盖", "true", existing, false},
		{"没有同名文件照常上传", "", absent, false},
		{"容器里没有 test 命令时不拦，避免弄坏可用功能", "", unsupported, false},
		{"overwrite 传别的值仍按未确认处理", "yes", existing, true},
	}

	for _, tc := range cases {
		if got := uploadOverwriteBlocked(tc.overwrite, tc.probe); got != tc.want {
			t.Errorf("%s: uploadOverwriteBlocked(%q, %+v) = %v, want %v", tc.name, tc.overwrite, tc.probe, got, tc.want)
		}
	}
}

// 错误码必须保持 pod_files_ 前缀：ui/src/lib/utils.ts 按这个前缀整族本地化，
// 换掉前缀就会退化成把英文原文弹给用户。
func TestFileAlreadyExistsCodeFollowsPrefix(t *testing.T) {
	if !strings.HasPrefix(fileCodeAlreadyExists, "pod_files_") {
		t.Fatalf("code %q lost the pod_files_ prefix", fileCodeAlreadyExists)
	}
}
