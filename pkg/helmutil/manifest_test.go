package helmutil

import (
	"strings"
	"testing"
)

// 回归（验收台账 D-173，并据此更正 D-117 的根因）。
//
// 第 20/22 轮把 Helm Release 详情「资源」页签恒空的原因记成「后端从不填
// status.resources」——查下来不对：helmrelease_handler.go 的详情路径就是
// ToHelmRelease(rel, true)，而它会调 resolveManifestResources 填这个字段。
// 真正的原因是只装了 `kind: List` 的 chart（stakater/configmap 就是）被解析成 0 个
// 资源：真对象在 items 里，而实现只看顶层。Dry Run 的资源预览同样受影响。

func TestResolveManifestResourcesExpandsListDocuments(t *testing.T) {
	cases := []struct {
		name             string
		manifest         string
		defaultNamespace string
		want             []string
	}{
		{
			// 先钉住普通形态：非 List 的 manifest 一直是能解析出来的。
			name: "普通多文档",
			manifest: `apiVersion: v1
kind: ConfigMap
metadata:
  name: cm-a
---
apiVersion: v1
kind: Service
metadata:
  name: svc-a
`,
			defaultNamespace: "ui-smoke",
			want: []string{
				"ConfigMap/ui-smoke/cm-a",
				"Service/ui-smoke/svc-a",
			},
		},
		{
			name: "kind List 要下钻 items",
			manifest: `apiVersion: v1
kind: List
items:
- apiVersion: v1
  kind: ConfigMap
  metadata:
    name: configmapname
- apiVersion: v1
  kind: Service
  metadata:
    name: svc-in-list
    namespace: elsewhere
`,
			defaultNamespace: "ui-smoke",
			want: []string{
				// List 自身不进结果；条目走同一套 namespace 回落规则。
				"ConfigMap/ui-smoke/configmapname",
				"Service/elsewhere/svc-in-list",
			},
		},
		{
			name: "List 里再套 List 也要摊平",
			manifest: `apiVersion: v1
kind: List
items:
- apiVersion: v1
  kind: List
  items:
  - apiVersion: v1
    kind: Secret
    metadata:
      name: nested
`,
			defaultNamespace: "team-a",
			want:             []string{"Secret/team-a/nested"},
		},
		{
			name: "空的 List 不凭空造记录",
			manifest: `apiVersion: v1
kind: List
metadata:
  name: empty-list
items: []
`,
			defaultNamespace: "ui-smoke",
			want:             nil,
		},
		{
			name: "集群级资源不回落命名空间",
			manifest: `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: reader
`,
			defaultNamespace: "ui-smoke",
			want:             []string{"ClusterRole//reader"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := resolveManifestResources(tc.manifest, tc.defaultNamespace)
			if len(got) != len(tc.want) {
				t.Fatalf("解析出 %d 个资源, want %d: %+v", len(got), len(tc.want), got)
			}
			for i, want := range tc.want {
				item := got[i]
				label := item.Kind + "/" + item.Namespace + "/" + item.Name
				if label != want {
					t.Errorf("第 %d 项 = %q, want %q", i+1, label, want)
				}
			}
		})
	}
}

func TestResolveManifestPreviewResourcesExpandsList(t *testing.T) {
	manifest := `# Source: configmap-demo/templates/all.yaml
apiVersion: v1
kind: List
items:
- apiVersion: v1
  kind: ConfigMap
  metadata:
    name: cm-one
  data:
    k: v
- apiVersion: v1
  kind: ConfigMap
  metadata:
    name: cm-two
`

	got := resolveManifestPreviewResources(manifest, "ui-smoke")
	if len(got) != 2 {
		t.Fatalf("List 里的 2 个资源都应出现在预览里, got %d: %+v", len(got), got)
	}
	if got[0].Path == got[1].Path {
		t.Errorf("预览路径必须能区分两个资源, 两者都是 %q", got[0].Path)
	}
	// 关键：每一项的 content 必须是它自己的清单，而不是整个 List 的文本——
	// 否则 Dry Run 预览里每个资源都显示成同一份 `kind: List`。
	for _, item := range got {
		if strings.Contains(item.Content, "kind: List") || strings.Contains(item.Content, "items:") {
			t.Errorf("%s 的 content 仍是整个 List 文本: %q", item.Path, item.Content)
		}
	}
	if !strings.Contains(got[0].Content, "name: cm-one") {
		t.Errorf("content 应带着本项自己的名字, got %q", got[0].Content)
	}

	// diff 以 Path 为键：List 展开后两边各 2 项要能一一对上，而不是被当成同一份。
	diff := diffManifestPreviewResources(manifest, "ui-smoke", manifest, "ui-smoke")
	unchanged := 0
	for _, item := range diff {
		if item.Status == "unchanged" {
			unchanged++
		}
	}
	if len(diff) != 2 || unchanged != 2 {
		t.Errorf("同一份 List 自身对比应得 2 项 unchanged, got %d 项（unchanged=%d）", len(diff), unchanged)
	}
}
