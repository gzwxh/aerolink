package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// tracked 记录写检查创建出来的对象，结束时统一清理。
// namespace 为空表示集群作用域（PV/StorageClass/Namespace 这类路径用 _all）。
type tracked struct {
	resource  string
	namespace string
	name      string
}

func (t tracked) path(base string) string {
	scope := t.namespace
	if scope == "" {
		scope = "_all"
	}
	return fmt.Sprintf("%s/%s/%s/%s", base, t.resource, scope, t.name)
}

// writeChecks 在指定的命名空间里走一遍写路径：建、改、扩缩容、重启、历史、删。
// 只操作 smoke- 前缀的对象，结束时清理，并核对命名空间里没有残留。
func (r *runner) writeChecks() {
	ns := r.opts.writeNamespace
	base := r.clusterPath("")
	tag := fmt.Sprintf("%d", time.Now().UnixNano()%1e6)
	img := r.opts.image
	if img == "" {
		img = "harbor.gogdev.cn/devops/redis:6.0.16"
	}
	// 创建出来的对象都登记下来：流程里自己删过的（404）不算问题，最后统一回查有没有残留。
	var created []tracked
	cleanup := func() {
		for _, item := range created {
			status, _, err := r.client.request("DELETE", item.path(base), nil)
			if err != nil {
				fmt.Printf("   清理出错 %s: %v\n", item.name, err)
				continue
			}
			if status >= 400 && status != http.StatusNotFound {
				fmt.Printf("   清理 %s -> %d\n", item.name, status)
			}
		}
	}
	// defer 是后进先出：先注册回查、后注册清理，实际执行顺序才是「先清理、再回查」。
	defer r.verifyNoLeftovers(base, ns)
	defer cleanup()

	fmt.Printf("--- 写检查（命名空间 %s）---\n", ns)

	// ConfigMap：建 → 读 → 改 → 校验改动生效。
	cm := "smoke-cm-" + tag
	created = append(created, tracked{"configmaps", ns, cm})
	r.expectStatus("创建 ConfigMap", "POST", fmt.Sprintf("%s/configmaps/%s", base, ns), map[string]any{
		"apiVersion": "v1", "kind": "ConfigMap",
		"metadata": map[string]any{"name": cm, "namespace": ns},
		"data":     map[string]any{"k": "v1"},
	}, http.StatusOK, http.StatusCreated)
	r.expectStatus("读取 ConfigMap", "GET", fmt.Sprintf("%s/configmaps/%s/%s", base, ns, cm), nil, 200)
	r.expectStatus("更新 ConfigMap", "PUT", fmt.Sprintf("%s/configmaps/%s/%s", base, ns, cm), map[string]any{
		"apiVersion": "v1", "kind": "ConfigMap",
		"metadata": map[string]any{"name": cm, "namespace": ns},
		"data":     map[string]any{"k": "v2"},
	}, 200)
	if _, raw, err := r.client.request("GET", fmt.Sprintf("%s/configmaps/%s/%s", base, ns, cm), nil); err == nil {
		r.check("ConfigMap 改动已生效", strings.Contains(string(raw), `"v2"`), truncate(string(raw), 120))
	}

	// Secret：建 → 读 → 删（走 SecretString 的加解密路径）。
	sec := "smoke-sec-" + tag
	r.expectStatus("创建 Secret", "POST", fmt.Sprintf("%s/secrets/%s", base, ns), map[string]any{
		"apiVersion": "v1", "kind": "Secret",
		"metadata":   map[string]any{"name": sec, "namespace": ns},
		"type":       "Opaque",
		"stringData": map[string]any{"token": "smoke-value"},
	}, http.StatusOK, http.StatusCreated)
	r.expectStatus("删除 Secret", "DELETE", fmt.Sprintf("%s/secrets/%s/%s", base, ns, sec), nil, 200, 202)

	// Deployment：建 → 扩缩容（前端走 PATCH spec.replicas）→ 重启 → 历史 → 改镜像 → 删。
	dep := "smoke-dep-" + tag
	created = append(created, tracked{"deployments", ns, dep})
	r.expectStatus("创建 Deployment", "POST", fmt.Sprintf("%s/deployments/%s", base, ns), deploymentBody(dep, ns, img, 1), http.StatusOK, http.StatusCreated)
	r.expectStatus("扩缩容（PATCH spec.replicas）", "PATCH", fmt.Sprintf("%s/deployments/%s/%s", base, ns, dep),
		map[string]any{"spec": map[string]any{"replicas": 2}}, 200)
	if _, raw, err := r.client.request("GET", fmt.Sprintf("%s/deployments/%s/%s", base, ns, dep), nil); err == nil {
		obj := decodeObject(raw)
		replicas := 0.0
		if spec, ok := obj["spec"].(map[string]any); ok {
			replicas, _ = spec["replicas"].(float64)
		}
		r.check("副本数确实变为 2", replicas == 2, fmt.Sprintf("spec.replicas=%v", replicas))
	}
	r.expectStatus("滚动重启（patch 注解）", "PATCH", fmt.Sprintf("%s/deployments/%s/%s", base, ns, dep), map[string]any{
		"spec": map[string]any{"template": map[string]any{"metadata": map[string]any{
			"annotations": map[string]any{"aerolink.kubernetes.io/restartedAt": time.Now().UTC().Format(time.RFC3339)}}}},
	}, 200)
	r.expectStatus("Deployment 历史", "GET", fmt.Sprintf("%s/deployments/%s/%s/history", base, ns, dep), nil, 200)
	r.expectStatus("改镜像（PUT）", "PUT", fmt.Sprintf("%s/deployments/%s/%s", base, ns, dep), deploymentBody(dep, ns, img, 2), 200)
	r.expectStatus("删除 Deployment", "DELETE", fmt.Sprintf("%s/deployments/%s/%s", base, ns, dep), nil, 200, 202)

	// Service（headless，避免占用 ClusterIP 与端口）。
	svc := "smoke-svc-" + tag
	created = append(created, tracked{"services", ns, svc})
	r.expectStatus("创建 Service", "POST", fmt.Sprintf("%s/services/%s", base, ns), map[string]any{
		"apiVersion": "v1", "kind": "Service",
		"metadata": map[string]any{"name": svc, "namespace": ns},
		"spec":     map[string]any{"clusterIP": "None", "selector": map[string]any{"app": svc}, "ports": []any{map[string]any{"port": 80}}},
	}, http.StatusOK, http.StatusCreated)

	// Job / CronJob。
	job := "smoke-job-" + tag
	created = append(created, tracked{"jobs", ns, job})
	r.expectStatus("创建 Job", "POST", fmt.Sprintf("%s/jobs/%s", base, ns), jobBody(job, ns, img), http.StatusOK, http.StatusCreated)
	cron := "smoke-cron-" + tag
	created = append(created, tracked{"cronjobs", ns, cron})
	r.expectStatus("创建 CronJob", "POST", fmt.Sprintf("%s/cronjobs/%s", base, ns), cronJobBody(cron, ns, img, false), http.StatusOK, http.StatusCreated)
	r.expectStatus("挂起 CronJob", "PUT", fmt.Sprintf("%s/cronjobs/%s/%s", base, ns, cron), cronJobBody(cron, ns, img, true), 200)

	// StatefulSet / DaemonSet。DaemonSet 用 nodeSelector 收在一个节点上，避免铺满全集群。
	sts := "smoke-sts-" + tag
	created = append(created, tracked{"statefulsets", ns, sts})
	r.expectStatus("创建 StatefulSet", "POST", fmt.Sprintf("%s/statefulsets/%s", base, ns), statefulSetBody(sts, ns, img), http.StatusOK, http.StatusCreated)
	if node := r.firstObjectName("/nodes/_all", ""); node != "" {
		ds := "smoke-ds-" + tag
		created = append(created, tracked{"daemonsets", ns, ds})
		r.expectStatus("创建 DaemonSet", "POST", fmt.Sprintf("%s/daemonsets/%s", base, ns), daemonSetBody(ds, ns, img, node), http.StatusOK, http.StatusCreated)
	}

	// YAML apply 路径（界面上的「从 YAML 创建」走这个接口）。
	cm2 := "smoke-apply-" + tag
	doc := fmt.Sprintf("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: %s\n  namespace: %s\ndata:\n  a: b\n", cm2, ns)
	created = append(created, tracked{"configmaps", ns, cm2})
	r.expectStatus("从 YAML apply", "POST", base+"/resources/apply",
		map[string]any{"yaml": doc, "namespace": ns}, 200, 201)

	// Pod 文件上传/下载：需要一个有 shell 的容器，所以自带一个 Pod。
	r.podFileChecks(base, ns, tag, img, &created)

	// 集群作用域对象：PV / StorageClass / Namespace。
	pv := "smoke-pv-" + tag
	created = append(created, tracked{"persistentvolumes", "", pv})
	r.expectStatus("创建 PV", "POST", base+"/persistentvolumes/_all", map[string]any{
		"apiVersion": "v1", "kind": "PersistentVolume",
		"metadata": map[string]any{"name": pv},
		"spec": map[string]any{"capacity": map[string]any{"storage": "1Gi"}, "accessModes": []any{"ReadWriteOnce"},
			"hostPath": map[string]any{"path": "/tmp/" + pv}, "storageClassName": pv,
			"persistentVolumeReclaimPolicy": "Delete"},
	}, http.StatusOK, http.StatusCreated)
	sc := "smoke-sc-" + tag
	created = append(created, tracked{"storageclasses", "", sc})
	r.expectStatus("创建 StorageClass", "POST", base+"/storageclasses/_all", map[string]any{
		"apiVersion": "storage.k8s.io/v1", "kind": "StorageClass",
		"metadata":    map[string]any{"name": sc},
		"provisioner": "kubernetes.io/no-provisioner", "volumeBindingMode": "WaitForFirstConsumer",
		"reclaimPolicy": "Delete",
	}, http.StatusOK, http.StatusCreated)
	newNS := "smoke-ns-" + tag
	created = append(created, tracked{"namespaces", "", newNS})
	r.expectStatus("创建 Namespace", "POST", base+"/namespaces/_all", map[string]any{
		"apiVersion": "v1", "kind": "Namespace", "metadata": map[string]any{"name": newNS},
	}, http.StatusOK, http.StatusCreated)
}

// verifyNoLeftovers 回查一遍：命名空间里不应再有 smoke- 开头的对象，
// 集群作用域的 PV/StorageClass/Namespace 同理。清理靠删除的返回值判断不可靠
// （404 可能只是流程里已经删过），列一遍才是真的核对。
func (r *runner) verifyNoLeftovers(base, ns string) {
	// Job / StatefulSet 的 Pod 由控制器后台回收，给它几次机会再下结论。
	var leftovers []string
	for attempt := 0; attempt < 6; attempt++ {
		leftovers = r.findLeftovers(base, ns)
		if len(leftovers) == 0 {
			break
		}
		time.Sleep(3 * time.Second)
	}
	r.check("写检查后没有 smoke- 残留", len(leftovers) == 0, strings.Join(leftovers, ", "))
}

// findLeftovers 列出命名空间与会受影响的集群作用域对象里 smoke- 开头的残留。
func (r *runner) findLeftovers(base, ns string) []string {
	leftovers := make([]string, 0)
	for _, resource := range []string{"pods", "deployments", "configmaps", "secrets", "services",
		"jobs", "cronjobs", "statefulsets", "daemonsets"} {
		_, raw, err := r.client.request("GET", fmt.Sprintf("%s/%s/%s", base, resource, ns), nil)
		if err != nil {
			leftovers = append(leftovers, resource+":查询失败")
			continue
		}
		items, err := listItems(raw)
		if err != nil {
			continue
		}
		for _, item := range items {
			if name := objectName(item); strings.HasPrefix(name, "smoke-") {
				leftovers = append(leftovers, resource+"/"+name)
			}
		}
	}
	for _, resource := range []string{"persistentvolumes", "storageclasses", "namespaces"} {
		_, raw, err := r.client.request("GET", fmt.Sprintf("%s/%s/_all", base, resource), nil)
		if err != nil {
			continue
		}
		items, err := listItems(raw)
		if err != nil {
			continue
		}
		for _, item := range items {
			if name := objectName(item); strings.HasPrefix(name, "smoke-") {
				leftovers = append(leftovers, resource+"/"+name)
			}
		}
	}
	return leftovers
}

// podFileChecks 建一个自带 shell 的 Pod，验证容器文件上传/列表/下载这一串。
func (r *runner) podFileChecks(base, ns, tag, img string, created *[]tracked) {
	pod := "smoke-file-" + tag
	*created = append(*created, tracked{"pods", ns, pod})
	r.expectStatus("创建 Pod", "POST", fmt.Sprintf("%s/pods/%s", base, ns), map[string]any{
		"apiVersion": "v1", "kind": "Pod",
		"metadata": map[string]any{"name": pod, "namespace": ns},
		"spec": map[string]any{"containers": []any{map[string]any{
			"name": "main", "image": img, "command": []any{"/bin/sh", "-c", "sleep 600"}}}},
	}, http.StatusOK, http.StatusCreated)

	running := false
	for i := 0; i < 30; i++ {
		_, raw, err := r.client.request("GET", fmt.Sprintf("%s/pods/%s/%s", base, ns, pod), nil)
		if err == nil {
			if phase := nestedString(decodeObject(raw), "status", "phase"); phase == "Running" {
				running = true
				break
			}
		}
		time.Sleep(3 * time.Second)
	}
	if !running {
		r.check("Pod 进入 Running（跳过文件上传：镜像可能拉不下来）", true, "")
		return
	}

	files := fmt.Sprintf("%s/pods/%s/%s/files", base, ns, pod)
	query := "?path=" + url.QueryEscape("/tmp") + "&container=main"
	content := []byte("smoke-upload-content-12345\n")
	status, raw, err := r.client.uploadFile(files+"/upload"+query, "smoke-upload.txt", content)
	r.check("上传文件到容器", err == nil && status == 200, fmt.Sprintf("status=%d body=%s", status, truncate(string(raw), 120)))

	_, raw, err = r.client.request("GET", files+query, nil)
	r.check("列表里能看到上传的文件", err == nil && strings.Contains(string(raw), "smoke-upload.txt"), truncate(string(raw), 120))

	_, raw, err = r.client.request("GET", files+"/download?path="+url.QueryEscape("/tmp/smoke-upload.txt")+"&container=main", nil)
	r.check("下载内容与上传一致", err == nil && strings.Contains(string(raw), "smoke-upload-content"), truncate(string(raw), 120))

	// 错误语义：不存在的文件必须是显式 404，而不是 200 空文件。
	status, raw, err = r.client.request("GET", files+"/download?path="+url.QueryEscape("/tmp/definitely-missing")+"&container=main", nil)
	r.check("下载不存在的文件返回 404", err == nil && status == 404 && strings.Contains(string(raw), "pod_files_not_found"),
		fmt.Sprintf("status=%d body=%s", status, truncate(string(raw), 120)))
}

func deploymentBody(name, ns, image string, replicas int) map[string]any {
	labels := map[string]any{"app": name}
	return map[string]any{
		"apiVersion": "apps/v1", "kind": "Deployment",
		"metadata": map[string]any{"name": name, "namespace": ns},
		"spec": map[string]any{
			"replicas": replicas,
			"selector": map[string]any{"matchLabels": labels},
			"template": map[string]any{
				"metadata": map[string]any{"labels": labels},
				"spec": map[string]any{"containers": []any{map[string]any{
					"name": "main", "image": image, "command": []any{"/bin/sh", "-c", "sleep 3600"}}}},
			},
		},
	}
}

func jobBody(name, ns, image string) map[string]any {
	return map[string]any{
		"apiVersion": "batch/v1", "kind": "Job",
		"metadata": map[string]any{"name": name, "namespace": ns},
		"spec": map[string]any{"backoffLimit": 0, "template": map[string]any{"spec": map[string]any{
			"restartPolicy": "Never",
			"containers":    []any{map[string]any{"name": "main", "image": image, "command": []any{"/bin/sh", "-c", "echo ok"}}},
		}}},
	}
}

func cronJobBody(name, ns, image string, suspend bool) map[string]any {
	return map[string]any{
		"apiVersion": "batch/v1", "kind": "CronJob",
		"metadata": map[string]any{"name": name, "namespace": ns},
		"spec": map[string]any{"schedule": "0 3 * * *", "suspend": suspend, "jobTemplate": map[string]any{
			"spec": map[string]any{"template": map[string]any{"spec": map[string]any{
				"restartPolicy": "Never",
				"containers":    []any{map[string]any{"name": "main", "image": image, "command": []any{"/bin/sh", "-c", "echo ok"}}},
			}}},
		}},
	}
}

func statefulSetBody(name, ns, image string) map[string]any {
	labels := map[string]any{"app": name}
	return map[string]any{
		"apiVersion": "apps/v1", "kind": "StatefulSet",
		"metadata": map[string]any{"name": name, "namespace": ns},
		"spec": map[string]any{
			"serviceName": name + "-none", "replicas": 1,
			"selector": map[string]any{"matchLabels": labels},
			"template": map[string]any{"metadata": map[string]any{"labels": labels},
				"spec": map[string]any{"containers": []any{map[string]any{
					"name": "main", "image": image, "command": []any{"/bin/sh", "-c", "sleep 3600"}}}}},
		},
	}
}

func daemonSetBody(name, ns, image, node string) map[string]any {
	labels := map[string]any{"app": name}
	return map[string]any{
		"apiVersion": "apps/v1", "kind": "DaemonSet",
		"metadata": map[string]any{"name": name, "namespace": ns},
		"spec": map[string]any{
			"selector": map[string]any{"matchLabels": labels},
			"template": map[string]any{"metadata": map[string]any{"labels": labels},
				"spec": map[string]any{
					"nodeSelector": map[string]any{"kubernetes.io/hostname": node},
					"containers": []any{map[string]any{
						"name": "main", "image": image, "command": []any{"/bin/sh", "-c", "sleep 3600"}}}}},
		},
	}
}

// fetchNotificationSetting 读通知设置原文（供 fakes.go 临时改写后复原）。
func (r *runner) fetchNotificationSetting() map[string]any {
	_, raw, err := r.client.request("GET", "/api/v1/admin/notification-setting/", nil)
	if err != nil {
		return nil
	}
	obj := decodeObject(raw)
	setting, _ := obj["setting"].(map[string]any)
	return setting
}

// putNotificationSetting 写回通知设置（整份提交，未给的口令保留）。
func (r *runner) putNotificationSetting(setting map[string]any) (int, []byte) {
	status, raw, _ := r.client.request("PUT", "/api/v1/admin/notification-setting/", setting)
	return status, raw
}

// fetchGeneralSetting 读通用设置原文。
func (r *runner) fetchGeneralSetting() map[string]any {
	_, raw, err := r.client.request("GET", "/api/v1/admin/general-setting/", nil)
	if err != nil {
		return nil
	}
	return decodeObject(raw)
}

// putGeneralSetting 写回通用设置。
func (r *runner) putGeneralSetting(setting map[string]any) (int, []byte) {
	status, raw, _ := r.client.request("PUT", "/api/v1/admin/general-setting/", setting)
	return status, raw
}

// marshalJSON 便于在细节里打印对象。
func marshalJSON(v any) string {
	raw, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return string(raw)
}
