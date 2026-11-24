package helmutil

import (
	"fmt"
	"strings"

	release "helm.sh/helm/v4/pkg/release/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"sigs.k8s.io/yaml"
)

var manifestClusterScopedKinds = map[string]struct{}{
	"apiservice":                       {},
	"certificatesigningrequest":        {},
	"clusterrole":                      {},
	"clusterrolebinding":               {},
	"customresourcedefinition":         {},
	"gatewayclass":                     {},
	"mutatingwebhookconfiguration":     {},
	"namespace":                        {},
	"node":                             {},
	"persistentvolume":                 {},
	"podsecuritypolicy":                {},
	"priorityclass":                    {},
	"storageclass":                     {},
	"validatingadmissionpolicy":        {},
	"validatingadmissionpolicybinding": {},
	"validatingwebhookconfiguration":   {},
	"volumesnapshotclass":              {},
	"volumesnapshotcontent":            {},
}

func ToHelmReleaseDryRunResponse(rel *release.Release) HelmReleaseDryRunResponse {
	return HelmReleaseDryRunResponse{
		Resources: resolveManifestPreviewResources(rel.Manifest, rel.Namespace),
	}
}

func ToHelmReleaseDryRunDiffResponse(current, next *release.Release) HelmReleaseDryRunResponse {
	return HelmReleaseDryRunResponse{
		Resources: diffManifestPreviewResources(
			current.Manifest,
			current.Namespace,
			next.Manifest,
			next.Namespace,
		),
	}
}

func resolveManifestResources(manifest, defaultNamespace string) []HelmReleaseResource {
	out := []HelmReleaseResource{}
	for _, doc := range splitManifestDocuments(manifest) {
		if isCommentOnlyManifestDocument(doc) {
			continue
		}
		var u unstructured.Unstructured
		if err := yaml.Unmarshal([]byte(doc), &u.Object); err != nil {
			continue
		}
		for _, obj := range expandManifestList(&u) {
			item := obj
			out = append(out, manifestResourceOf(&item, defaultNamespace))
		}
	}
	return out
}

// manifestResourceOf 把一个文档对象翻译成资源标识；没有 namespace 的非集群级资源
// 回落到 release 的命名空间（与 helm 自己的归属口径一致）。
func manifestResourceOf(u *unstructured.Unstructured, defaultNamespace string) HelmReleaseResource {
	ns := u.GetNamespace()
	_, clusterScoped := manifestClusterScopedKinds[strings.ToLower(u.GetKind())]
	if ns == "" && !clusterScoped {
		ns = defaultNamespace
	}
	return HelmReleaseResource{
		APIVersion: u.GetAPIVersion(),
		Kind:       u.GetKind(),
		Name:       u.GetName(),
		Namespace:  ns,
	}
}

// expandManifestList 把一个文档展开成其中真正可跳转的资源。
//
// helm 允许把一组资源包在 corev1 `List` 里交付（stakater 的 configmap chart 就这么渲染），
// 此时真对象在 `items` 里：只扫顶层会把整个 release 解析成 0 个资源（验收台账 D-173，
// 也正是 D-117「资源」页签为空的真因 —— 详情接口本来就在填 status.resources）。
// List 自身不是可跳转资源，只当容器用；非 List 文档原样返回。
func expandManifestList(u *unstructured.Unstructured) []unstructured.Unstructured {
	if u == nil {
		return nil
	}
	if u.GetKind() != "List" {
		if u.GetKind() == "" || u.GetName() == "" {
			return nil
		}
		return []unstructured.Unstructured{*u}
	}
	raw, found, err := unstructured.NestedSlice(u.Object, "items")
	if err != nil || !found {
		return nil
	}
	out := []unstructured.Unstructured{}
	for _, entry := range raw {
		obj, ok := entry.(map[string]interface{})
		if !ok {
			continue
		}
		item := unstructured.Unstructured{Object: obj}
		// 嵌套情形：List 里再套 List 也摊平成一层。
		out = append(out, expandManifestList(&item)...)
	}
	return out
}

func resolveManifestPreviewResources(manifest, defaultNamespace string) []HelmReleaseDryRunResource {
	out := []HelmReleaseDryRunResource{}
	for i, doc := range splitManifestDocuments(manifest) {
		if isCommentOnlyManifestDocument(doc) {
			continue
		}
		content := trimHelmSourceComment(doc)
		var u unstructured.Unstructured
		if err := yaml.Unmarshal([]byte(doc), &u.Object); err != nil {
			out = append(out, HelmReleaseDryRunResource{
				Path:    fmt.Sprintf("manifest-%d.yaml", i+1),
				Content: content,
			})
			continue
		}
		// 先判 List：`kind: List` 通常没有 metadata.name，拿「有 kind 且有 name」
		// 当可解析判据会让整个文档落回“原样列出”分支（预览里以 manifest-N.yaml 出现）。
		if items := expandManifestList(&u); len(items) > 0 {
			for _, obj := range items {
				item := obj
				itemContent := content
				if u.GetKind() == "List" {
					// 整个文档文本不是某个资源的清单，用各项自己重新序列化。
					if dumped, err := yaml.Marshal(item.Object); err == nil {
						itemContent = strings.TrimSpace(string(dumped))
					}
				}
				resource := manifestResourceOf(&item, defaultNamespace)
				out = append(out, HelmReleaseDryRunResource{
					HelmReleaseResource: resource,
					Path:                manifestPreviewPath(resource, i),
					Content:             itemContent,
				})
			}
			continue
		}
		if u.GetKind() == "" || u.GetName() == "" {
			out = append(out, HelmReleaseDryRunResource{
				Path:    fmt.Sprintf("manifest-%d.yaml", i+1),
				Content: content,
			})
			continue
		}
		resource := manifestResourceOf(&u, defaultNamespace)
		out = append(out, HelmReleaseDryRunResource{
			HelmReleaseResource: resource,
			Path:                manifestPreviewPath(resource, i),
			Content:             content,
		})
	}
	return out
}

func diffManifestPreviewResources(currentManifest, currentNamespace, nextManifest, nextNamespace string) []HelmReleaseDryRunResource {
	currentResources := resolveManifestPreviewResources(currentManifest, currentNamespace)
	nextResources := resolveManifestPreviewResources(nextManifest, nextNamespace)
	currentByPath := make(map[string]HelmReleaseDryRunResource, len(currentResources))
	nextByPath := make(map[string]HelmReleaseDryRunResource, len(nextResources))
	for _, resource := range currentResources {
		currentByPath[resource.Path] = resource
	}
	for _, resource := range nextResources {
		nextByPath[resource.Path] = resource
	}

	out := make([]HelmReleaseDryRunResource, 0, len(currentResources)+len(nextResources))
	seen := make(map[string]struct{}, len(currentResources)+len(nextResources))
	for _, resource := range nextResources {
		if _, ok := seen[resource.Path]; ok {
			continue
		}
		seen[resource.Path] = struct{}{}
		nextResource := nextByPath[resource.Path]
		currentResource, exists := currentByPath[resource.Path]
		nextResource.OriginalContent = currentResource.Content
		nextResource.ModifiedContent = nextResource.Content
		switch {
		case !exists:
			nextResource.Status = "added"
		case currentResource.Content == nextResource.Content:
			nextResource.Status = "unchanged"
		default:
			nextResource.Status = "changed"
		}
		out = append(out, nextResource)
	}

	for _, resource := range currentResources {
		if _, ok := seen[resource.Path]; ok {
			continue
		}
		if _, exists := nextByPath[resource.Path]; exists {
			continue
		}
		resource.OriginalContent = resource.Content
		resource.ModifiedContent = ""
		resource.Status = "deleted"
		out = append(out, resource)
	}
	return out
}

func splitManifestDocuments(manifest string) []string {
	docs := []string{}
	lines := []string{}
	for _, line := range strings.Split(manifest, "\n") {
		marker := strings.TrimRight(line, " \t\r")
		if marker == "---" || strings.HasPrefix(marker, "--- #") {
			doc := strings.TrimSpace(strings.Join(lines, "\n"))
			if doc != "" {
				docs = append(docs, doc)
			}
			lines = lines[:0]
			continue
		}
		lines = append(lines, line)
	}

	doc := strings.TrimSpace(strings.Join(lines, "\n"))
	if doc != "" {
		docs = append(docs, doc)
	}
	return docs
}

func isCommentOnlyManifestDocument(content string) bool {
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if line != "" && !strings.HasPrefix(line, "#") {
			return false
		}
	}
	return true
}

func trimHelmSourceComment(content string) string {
	lines := strings.Split(content, "\n")
	if len(lines) == 0 || !strings.HasPrefix(strings.TrimSpace(lines[0]), "# Source:") {
		return content
	}
	return strings.TrimSpace(strings.Join(lines[1:], "\n"))
}

func manifestPreviewPath(resource HelmReleaseResource, index int) string {
	scope := resource.Namespace
	if scope == "" {
		scope = "cluster"
	}
	kind := resource.Kind
	if kind == "" {
		kind = "Resource"
	}
	name := resource.Name
	if name == "" {
		name = fmt.Sprintf("manifest-%d", index+1)
	}
	return scope + "/" + kind + "/" + name + ".yaml"
}
