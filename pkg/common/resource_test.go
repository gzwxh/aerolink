package common

import (
	"reflect"
	"sort"
	"testing"
)

// 钉住「哪些资源类型有 /related 关联发现」。Registry 里的 Related 标记是后端注册
// 该路由的唯一依据（见 pkg/resources/handler.go 用 RelatedResourceTypes 建路由），
// 而前端 ui/src/lib/resource-catalog.ts 的 relatedResourceTypes 是本列表的镜像，
// 用来决定详情页要不要发这个请求：两边不同步时，页面要么对着不存在的路径拿 404
// （缺陷 D-41 的原始现象），要么少了关联卡片。改这里请同步那边。
func TestRelatedResourceTypesArePinned(t *testing.T) {
	got := RelatedResourceTypes()
	sort.Strings(got)

	want := []string{
		"configmaps",
		"daemonsets",
		"deployments",
		"horizontalpodautoscalers",
		"httproutes",
		"ingresses",
		"persistentvolumeclaims",
		"poddisruptionbudgets",
		"pods",
		"secrets",
		"services",
		"statefulsets",
		"storageclasses",
	}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("RelatedResourceTypes() = %v, want %v（改动请同步 ui/src/lib/resource-catalog.ts）", got, want)
	}
}

// 节点没有 /related 路由：它的关联对象就是自己上面的 Pod，详情页已按
// spec.nodeName 直接列 Pod，不需要再发现一次。
func TestNodesHaveNoRelatedRoute(t *testing.T) {
	for _, resourceType := range RelatedResourceTypes() {
		if resourceType == string(Nodes) {
			t.Fatal("nodes 被标成 Related 但 GetRelatedResources 没有对应的关联发现分支")
		}
	}
}
