package resources

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	semver "github.com/blang/semver/v4"
	"github.com/gin-gonic/gin"
	"github.com/samber/lo"
	"github.com/zxh326/kite/pkg/cluster"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/kube"
	"github.com/zxh326/kite/pkg/middleware"
	"github.com/zxh326/kite/pkg/model"
	"github.com/zxh326/kite/pkg/rbac"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/strategicpatch"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/klog/v2"
	metricsv1 "k8s.io/metrics/pkg/apis/metrics/v1beta1"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

type PodHandler struct {
	*GenericResourceHandler[*corev1.Pod, *corev1.PodList]
}

func NewPodHandler() *PodHandler {
	return &PodHandler{
		GenericResourceHandler: NewGenericResourceHandler[*corev1.Pod, *corev1.PodList](common.Pods),
	}
}

type PodMetrics struct {
	CPUUsage      int64 `json:"cpuUsage,omitempty"`
	CPULimit      int64 `json:"cpuLimit,omitempty"`
	CPURequest    int64 `json:"cpuRequest,omitempty"`
	MemoryUsage   int64 `json:"memoryUsage,omitempty"`
	MemoryLimit   int64 `json:"memoryLimit,omitempty"`
	MemoryRequest int64 `json:"memoryRequest,omitempty"`
}

type PodWithMetrics struct {
	*corev1.Pod `json:",inline"`
	Metrics     *PodMetrics `json:"metrics"`
}

type PodListWithMetrics struct {
	Items           []*PodWithMetrics `json:"items"`
	metav1.TypeMeta `json:",inline"`
	// 标准的列表元数据。
	// 更多信息：https://git.k8s.io/community/contributors/devel/sig-architecture/api-conventions.md#types-kinds
	// +optional
	metav1.ListMeta `json:"metadata" protobuf:"bytes,1,opt,name=metadata"`
}

func GetPodMetrics(metricsMap map[string]metricsv1.PodMetrics, pod *corev1.Pod) *PodMetrics {
	key := pod.Namespace + "/" + pod.Name
	podMetrics, ok := metricsMap[key]
	if !ok || len(podMetrics.Containers) == 0 {
		return nil
	}
	var cpuUsage, memUsage int64
	for _, container := range podMetrics.Containers {
		if cpuQuantity, ok := container.Usage["cpu"]; ok {
			cpuUsage += cpuQuantity.MilliValue()
		}
		if memQuantity, ok := container.Usage["memory"]; ok {
			memUsage += memQuantity.Value()
		}
	}
	var cpuLimit, memLimit int64
	var cpuRequest, memRequest int64
	for _, container := range pod.Spec.Containers {
		if cpuQuantity, ok := container.Resources.Limits["cpu"]; ok {
			cpuLimit += cpuQuantity.MilliValue()
		}
		if memQuantity, ok := container.Resources.Limits["memory"]; ok {
			memLimit += memQuantity.Value()
		}
		if cpuQuantity, ok := container.Resources.Requests["cpu"]; ok {
			cpuRequest += cpuQuantity.MilliValue()
		}
		if memQuantity, ok := container.Resources.Requests["memory"]; ok {
			memRequest += memQuantity.Value()
		}
	}
	return &PodMetrics{
		CPUUsage:      cpuUsage,
		MemoryUsage:   memUsage,
		CPULimit:      cpuLimit,
		MemoryLimit:   memLimit,
		CPURequest:    cpuRequest,
		MemoryRequest: memRequest,
	}
}

const defaultPodMetricsInterval = 15 * time.Second

// podWatchPingInterval 是 SSE 保活注释（`: ping`）的间隔，与指标推送周期解耦：
// 即使把 AEROLINK_POD_METRICS_INTERVAL 调大，心跳也不会跟着变慢。
const podWatchPingInterval = 15 * time.Second

// podMetricsInterval 返回周期推送 Pod 用量的间隔，可用 AEROLINK_POD_METRICS_INTERVAL
// （秒）覆盖，默认与历史行为一致（15s）。
func podMetricsInterval() time.Duration {
	if v := common.Getenv("POD_METRICS_INTERVAL"); v != "" {
		if secs, err := strconv.Atoi(v); err == nil && secs > 0 {
			return time.Duration(secs) * time.Second
		}
	}
	return defaultPodMetricsInterval
}

// podMetricsIntervalFn 供测试注入短周期。
var podMetricsIntervalFn = podMetricsInterval

// podMetricsUpdate 是周期推送的轻量用量变化。requests/limits 属于 Pod 规格，
// 由 Pod 本体携带，不随周期变化，因此这里只带用量。
type podMetricsUpdate struct {
	Namespace   string `json:"namespace"`
	Name        string `json:"name"`
	CPUUsage    int64  `json:"cpuUsage"`
	MemoryUsage int64  `json:"memoryUsage"`
}

// podUsageFromMetrics 汇总一个 PodMetrics 内所有容器的用量，
// 口径与 GetPodMetrics 保持一致。
func podUsageFromMetrics(m metricsv1.PodMetrics) (int64, int64) {
	var cpuUsage, memUsage int64
	for _, container := range m.Containers {
		if cpuQuantity, ok := container.Usage["cpu"]; ok {
			cpuUsage += cpuQuantity.MilliValue()
		}
		if memQuantity, ok := container.Usage["memory"]; ok {
			memUsage += memQuantity.Value()
		}
	}
	return cpuUsage, memUsage
}

// listPodMetrics 读取 Pod 用量并按 ns/name 建索引。结果只取决于集群与过滤条件、
// 与登录用户无关，因此同一个周期内可以在该集群的所有连接之间共享（见 pod watch hub）。
func listPodMetrics(ctx context.Context, cs *cluster.ClientSet, namespace, labelSelector string) (map[string]metricsv1.PodMetrics, error) {
	var metricsList metricsv1.PodMetricsList
	var listOpts []client.ListOption
	if namespace != "" && namespace != common.AllNamespaces {
		listOpts = append(listOpts, client.InNamespace(namespace))
	}
	if labelSelector != "" {
		selector, err := metav1.ParseToLabelSelector(labelSelector)
		if err != nil {
			return nil, fmt.Errorf("invalid labelSelector parameter: %w", err)
		}
		labelSelectorOption, err := metav1.LabelSelectorAsSelector(selector)
		if err != nil {
			return nil, fmt.Errorf("failed to convert labelSelector: %w", err)
		}
		listOpts = append(listOpts, client.MatchingLabelsSelector{Selector: labelSelectorOption})
	}
	if err := cs.K8sClient.List(ctx, &metricsList, listOpts...); err != nil {
		klog.Warningf("Failed to list pod metrics: %v", err)
	}

	return lo.KeyBy(metricsList.Items, func(item metricsv1.PodMetrics) string {
		return item.Namespace + "/" + item.Name
	}), nil
}

func (h *PodHandler) ListMetrics(c *gin.Context) (map[string]metricsv1.PodMetrics, error) {
	cs := c.MustGet("cluster").(*cluster.ClientSet)
	return listPodMetrics(c.Request.Context(), cs, c.Param("namespace"), c.Query("labelSelector"))
}

func (h *PodHandler) List(c *gin.Context) {
	objlist, err := h.list(c)
	if err != nil {
		return
	}
	reduce := c.Query("reduce") == "true"
	metricsMap, err := h.ListMetrics(c)
	if err != nil {
		klog.Warningf("Failed to list pod metrics: %v", err)
	}

	result := &PodListWithMetrics{
		TypeMeta: objlist.TypeMeta,
		ListMeta: objlist.ListMeta,
		Items:    make([]*PodWithMetrics, len(objlist.Items)),
	}

	for i := range objlist.Items {
		item := &PodWithMetrics{
			Pod: &objlist.Items[i],
		}
		item.Metrics = GetPodMetrics(metricsMap, &objlist.Items[i])
		if reduce {
			// 移除不必要的字段以减小响应体积
			item.ObjectMeta = metav1.ObjectMeta{
				Name:              item.Name,
				Namespace:         item.Namespace,
				CreationTimestamp: item.CreationTimestamp,
				DeletionTimestamp: item.DeletionTimestamp,
			}
			item.Spec = corev1.PodSpec{
				NodeName: objlist.Items[i].Spec.NodeName,
				InitContainers: lo.Map(objlist.Items[i].Spec.InitContainers, func(c corev1.Container, _ int) corev1.Container {
					return corev1.Container{Name: c.Name, Image: c.Image, RestartPolicy: c.RestartPolicy}
				}),
				Containers: lo.Map(objlist.Items[i].Spec.Containers, func(c corev1.Container, _ int) corev1.Container {
					return corev1.Container{Name: c.Name, Image: c.Image, RestartPolicy: c.RestartPolicy}
				}),
			}
		}
		result.Items[i] = item
	}
	c.JSON(http.StatusOK, result)
}

func (h *PodHandler) Resize(c *gin.Context) {
	cs := c.MustGet("cluster").(*cluster.ClientSet)
	if !isPodResizeSupported(cs.Version) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "pod resize requires kubernetes >= 1.35.0"})
		return
	}

	patchBytes, err := c.GetRawData()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "failed to read patch data"})
		return
	}

	name := c.Param("name")
	namespace := c.Param("namespace")
	oldPod := &corev1.Pod{}
	namespacedName := types.NamespacedName{Name: name}
	if namespace != "" && namespace != common.AllNamespaces {
		namespacedName.Namespace = namespace
	}
	if err := cs.K8sClient.Get(c.Request.Context(), namespacedName, oldPod); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	var updatedPod *corev1.Pod

	originalBytes, err := json.Marshal(oldPod)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	patchedBytes, err := strategicpatch.StrategicMergePatch(originalBytes, patchBytes, &corev1.Pod{})
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	updatedPod = &corev1.Pod{}
	if err := json.Unmarshal(patchedBytes, updatedPod); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	resizedPod, err := cs.K8sClient.ClientSet.CoreV1().Pods(updatedPod.Namespace).UpdateResize(
		c.Request.Context(),
		updatedPod.Name,
		updatedPod,
		metav1.UpdateOptions{},
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, resizedPod)
}

func isPodResizeSupported(version string) bool {
	parsed, err := parseKubeSemver(version)
	if err != nil {
		return false
	}
	return parsed.GTE(semver.MustParse("1.35.0"))
}

func parseKubeSemver(version string) (semver.Version, error) {
	trimmed := strings.TrimSpace(version)
	trimmed = strings.TrimPrefix(trimmed, "v")
	if trimmed == "" {
		return semver.Version{}, errors.New("empty version")
	}
	return semver.Parse(trimmed)
}

// registerCustomRoutes 注册 pod 专属的额外路由（SSE watch）
func (h *PodHandler) registerCustomRoutes(group *gin.RouterGroup) {
	// 监听命名空间（或 _all）中的 pod
	group.GET("/:namespace/watch", h.Watch)
	group.PATCH("/:namespace/:name/resize", h.Resize)
	group.PATCH("/:namespace/:name/debug", h.Debug)
	group.POST("/:namespace/:name/debug-copy", h.DebugCopy)
	filesGroup := group.Group("/:namespace/:name/files")
	filesGroup.Use(func(c *gin.Context) {
		user := c.MustGet("user").(model.User)
		cs := c.MustGet("cluster").(*cluster.ClientSet)
		namespace := c.Param("namespace")

		// 每类文件操作对应独立动词（view-file / download-file / upload-file），
		// 拥有 exec 的角色视为全部具备，保证既有角色不受影响。
		var verb common.Verb
		switch {
		case c.Request.Method == http.MethodPut:
			verb = common.VerbUploadFile
		case strings.HasSuffix(c.Request.URL.Path, "/download"):
			verb = common.VerbDownloadFile
		default:
			verb = common.VerbViewFile
		}

		if !rbac.CanAccess(user, string(common.Pods), string(common.VerbExec), cs.Name, namespace) &&
			!rbac.CanAccess(user, string(common.Pods), string(verb), cs.Name, namespace) {
			c.JSON(http.StatusForbidden, gin.H{"error": rbac.NoAccess(user.Key(), string(verb), string(common.Pods), namespace, cs.Name)})
			c.Abort()
			return
		}
		c.Next()
	})
	filesGroup.GET("", h.ListFiles)
	filesGroup.GET("/preview", h.PreviewFile)
	filesGroup.GET("/download", h.DownloadFile)
	filesGroup.PUT("/upload", h.UploadFile)
}

type FileInfo struct {
	Name    string `json:"name"`
	IsDir   bool   `json:"isDir"`
	Size    string `json:"size"`
	ModTime string `json:"modTime"`
	Mode    string `json:"mode"`
	UID     string `json:"uid,omitempty"`
	GID     string `json:"gid,omitempty"`
}

func (h *PodHandler) ListFiles(c *gin.Context) {
	namespace := c.Param("namespace")
	podName := c.Param("name")
	container := c.Query("container")
	path := c.Query("path")
	if path == "" {
		path = "/"
	} else if err := validateContainerPath(path); err != nil {
		respondFilePathError(c, err)
		return
	}
	cs := c.MustGet("cluster").(*cluster.ClientSet)
	cmd := []string{"ls", "-lah", "--full-time", safeExecPath(path)}
	stdout, stderr, err := cs.K8sClient.ExecCommandBuffered(c.Request.Context(), namespace, podName, container, cmd)
	if err != nil {
		if containerCommandMissing(err, stderr) {
			respondFileError(c, http.StatusBadRequest, fileCodeUnsupported,
				fmt.Sprintf("File browsing is not supported for %s container (missing 'ls' command)", container),
				gin.H{"container": container})
			return
		}
		c.JSON(http.StatusOK, nil)
		return
	}

	files := parseLsOutput(stdout)
	c.JSON(http.StatusOK, files)
}

func isAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func parseLsOutput(output string) []FileInfo {
	lines := strings.Split(output, "\n")
	files := make([]FileInfo, 0)
	for _, line := range lines {
		if strings.HasPrefix(line, "total") || strings.TrimSpace(line) == "" {
			continue
		}
		parts := strings.Fields(line)
		// 列：mode links uid gid size 日期 时间 时区 名称
		// （ListFiles 用 `ls -lah --full-time`，即 GNU 的 ISO 时间 + 时区）
		if len(parts) < 9 {
			continue
		}

		mode := parts[0]
		isDir := strings.HasPrefix(mode, "d")

		uid := parts[2]
		gid := parts[3]

		// 字符/块设备的 size 列是「主设备号, 次设备号」，`ls` 在逗号后留有空格，
		// strings.Fields 因此会多切出一个 token。不补回来的话后面所有列都错位：
		// 日期读成 "5 2026-09-19"，名称读成 "12:13:44 +0000 null"。
		sizeIndex := 4
		size := parts[sizeIndex]
		if strings.HasSuffix(size, ",") && isAllDigits(parts[sizeIndex+1]) {
			sizeIndex++
			size = size + " " + parts[sizeIndex]
		}
		if len(parts) < sizeIndex+5 {
			continue
		}

		modTime := strings.Join(parts[sizeIndex+1:sizeIndex+3], " ")
		name := strings.Join(parts[sizeIndex+4:], " ")
		// 跳过 . 与 ..
		if name == "." || name == ".." {
			continue
		}
		files = append(files, FileInfo{
			Name:    name,
			IsDir:   isDir,
			Size:    size,
			ModTime: modTime,
			Mode:    mode,
			UID:     uid,
			GID:     gid,
		})
	}
	sort.Slice(files, func(i, j int) bool {
		// 目录优先
		if files[i].IsDir && !files[j].IsDir {
			return true
		}
		if !files[i].IsDir && files[j].IsDir {
			return false
		}
		return strings.ToLower(files[i].Name) < strings.ToLower(files[j].Name)
	})
	return files
}

func (h *PodHandler) PreviewFile(c *gin.Context) {
	namespace := c.Param("namespace")
	podName := c.Param("name")
	container := c.Query("container")
	path := c.Query("path")
	cs := c.MustGet("cluster").(*cluster.ClientSet)
	if path == "" {
		respondFilePathError(c, errPathRequired)
		return
	}
	if strings.Contains(path, "->") {
		path = strings.TrimSpace(strings.SplitN(path, "->", 2)[0])
	}
	if err := validateContainerPath(path); err != nil {
		respondFilePathError(c, err)
		return
	}

	probe := probeContainerPath(c.Request.Context(), cs, namespace, podName, container, path)
	if respondFileProbeFailure(c, probe, container, path, "File preview") {
		return
	}
	if probe.IsDir {
		respondFileError(c, http.StatusBadRequest, fileCodeIsDirectory,
			fmt.Sprintf("%s is a directory and cannot be previewed", path),
			gin.H{"path": path, "container": container})
		return
	}

	cmd := []string{"cat", safeExecPath(path)}

	contentType := mime.TypeByExtension(filepath.Ext(path))
	if contentType == "" {
		contentType = "text/plain; charset=utf-8"
	}
	c.Header("Content-Type", contentType)
	c.Header("Content-Disposition", fmt.Sprintf("inline; filename=\"%s\"", filepath.Base(path)))

	err := cs.K8sClient.ExecCommand(c.Request.Context(), kube.ExecOptions{
		Namespace:     namespace,
		PodName:       podName,
		ContainerName: container,
		Command:       cmd,
		Stdout:        c.Writer,
		Stderr:        nil,
		TTY:           false,
	})

	if err != nil {
		klog.Errorf("Failed to preview file: %v", err)
	}
	h.recordFileAudit(c, cs, namespace, podName, "view-file", path, container, err == nil, err)
}

func (h *PodHandler) DownloadFile(c *gin.Context) {
	namespace := c.Param("namespace")
	podName := c.Param("name")
	container := c.Query("container")
	path := c.Query("path")

	cs := c.MustGet("cluster").(*cluster.ClientSet)

	if path == "" {
		respondFilePathError(c, errPathRequired)
		return
	}
	if strings.Contains(path, "->") {
		path = strings.TrimSpace(strings.SplitN(path, "->", 2)[0])
	}
	if err := validateContainerPath(path); err != nil {
		respondFilePathError(c, err)
		return
	}

	probe := probeContainerPath(c.Request.Context(), cs, namespace, podName, container, path)
	if respondFileProbeFailure(c, probe, container, path, "File download") {
		return
	}
	isDir := probe.IsDir

	var cmd []string
	if isDir {
		c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s.tar\"", filepath.Base(path)))
		c.Header("Content-Type", "application/x-tar")
		cmd = []string{"tar", "cf", "-", safeExecPath(path)}
	} else {
		c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"", filepath.Base(path)))
		c.Header("Content-Type", "application/octet-stream")
		cmd = []string{"cat", safeExecPath(path)}
	}

	// 走到这里说明命令与路径都探过了，剩下的失败（例如传输中途断开）已经无法改写
	// 状态码，只能记日志与审计。
	err := cs.K8sClient.ExecCommand(c.Request.Context(), kube.ExecOptions{
		Namespace:     namespace,
		PodName:       podName,
		ContainerName: container,
		Command:       cmd,
		Stdout:        c.Writer,
		Stderr:        nil,
		TTY:           false,
	})

	if err != nil {
		klog.Errorf("Failed to download file: %v", err)
	}
	h.recordFileAudit(c, cs, namespace, podName, "download-file", path, container, err == nil, err)
}

// safeExecPath 避免用户提供的容器内路径被通过 exec 执行的命令解析成选项
// （cat/tar/ls 会把以 "-" 开头的参数当作标志）。在路径前加 "./" 对所有实现
// 都能消除这种歧义，
// 而 "--" 分隔符在 busybox tar 上并不支持。
func safeExecPath(p string) string {
	if strings.HasPrefix(p, "-") {
		return "./" + p
	}
	return p
}

// validateContainerPath 拒绝客户端本不该发送的形态：
// 空值、NUL 字节以及 ".." 片段。文件浏览器只遍历一个容器内路径，
// 因此只有在请求试图越出用户指定目录时才会出现穿越片段。
// RBAC verb 才是真正的边界，
// 这里只是让 API 对自身契约保持诚实。
//
// 返回的是哨兵错误，调用方用 respondFilePathError 转成可本地化的错误码。
var (
	errPathRequired  = errors.New("path is required")
	errPathInvalid   = errors.New("invalid path")
	errPathTraversal = errors.New("path must not contain '..'")
)

func validateContainerPath(p string) error {
	trimmed := strings.TrimSpace(p)
	if trimmed == "" {
		return errPathRequired
	}
	if strings.ContainsRune(trimmed, 0) {
		return errPathInvalid
	}
	for _, segment := range strings.Split(trimmed, "/") {
		if segment == ".." {
			return errPathTraversal
		}
	}
	return nil
}

// 容器文件接口的错误码：前端按码本地化提示，error 字段保留英文原文供日志排查。
const (
	fileCodeUnsupported   = "pod_files_unsupported"
	fileCodeNotFound      = "pod_files_not_found"
	fileCodeIsDirectory   = "pod_files_is_directory"
	fileCodePathRequired  = "pod_files_path_required"
	fileCodePathInvalid   = "pod_files_path_invalid"
	fileCodePathTraversal = "pod_files_path_traversal"
)

// containerCommandMissing 报告一次 exec 失败是不是因为容器里没有这个命令
// （distroless 之类的精简镜像）。k8s 会把「找不到可执行文件」作为 exec 错误返回，
// busybox 系的 shell 则把 not found 写进 stderr，两处都要看。
func containerCommandMissing(err error, stderr string) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), "not found") || strings.Contains(stderr, "not found")
}

// containerPathProbe 是写响应之前对容器内路径的探测结果。
type containerPathProbe struct {
	IsDir bool
	// Exists 为 false 且 Unsupported 为 false 时表示路径不存在。
	Exists bool
	// Unsupported 表示容器里没有 test 命令，文件操作没法进行。
	Unsupported bool
}

// probeContainerPath 在开始流式响应之前探明路径的类型。
//
// 必须探测：下载/预览是把 cat（或 tar）的输出直接流给客户端的，等它报错时 200 与
// 响应头都已经发出去了，客户端只会拿到一个空文件——错误只剩日志。所以「容器缺命令」
// 与「路径不存在」都要在这里分辨出来，返回显式错误。
//
// 顺带一提：test 与 cat/tar 通常由同一套 coreutils/busybox 提供，所以用 test 探活
// 足以覆盖缺命令的情况。
func probeContainerPath(ctx context.Context, cs *cluster.ClientSet, namespace, podName, container, path string) containerPathProbe {
	target := safeExecPath(path)
	if _, stderr, err := cs.K8sClient.ExecCommandBuffered(ctx, namespace, podName, container, []string{"test", "-d", target}); err == nil {
		return containerPathProbe{IsDir: true, Exists: true}
	} else if containerCommandMissing(err, stderr) {
		return containerPathProbe{Unsupported: true}
	}
	if _, stderr, err := cs.K8sClient.ExecCommandBuffered(ctx, namespace, podName, container, []string{"test", "-e", target}); err == nil {
		return containerPathProbe{Exists: true}
	} else if containerCommandMissing(err, stderr) {
		return containerPathProbe{Unsupported: true}
	}
	return containerPathProbe{}
}

// respondFileProbeFailure 按探测结果写错误响应，返回 true 表示已经响应、调用方应返回。
func respondFileProbeFailure(c *gin.Context, probe containerPathProbe, container, path, operation string) bool {
	switch {
	case probe.Unsupported:
		respondFileError(c, http.StatusBadRequest, fileCodeUnsupported,
			fmt.Sprintf("%s is not supported for the %s container (missing required commands)", operation, container),
			gin.H{"container": container})
		return true
	case !probe.Exists:
		respondFileError(c, http.StatusNotFound, fileCodeNotFound,
			fmt.Sprintf("%s is not present in the %s container", path, container),
			gin.H{"path": path, "container": container})
		return true
	}
	return false
}

// respondFileError 写入带错误码的 JSON，params 供前端拼装本地化文案里的变量。
func respondFileError(c *gin.Context, status int, code, message string, params gin.H) {
	body := gin.H{"error": message, "code": code}
	if len(params) > 0 {
		body["params"] = params
	}
	c.JSON(status, body)
}

// respondFilePathError 把路径校验错误映射为错误码后返回。
func respondFilePathError(c *gin.Context, err error) {
	code := fileCodePathInvalid
	switch {
	case errors.Is(err, errPathRequired):
		code = fileCodePathRequired
	case errors.Is(err, errPathTraversal):
		code = fileCodePathTraversal
	}
	respondFileError(c, http.StatusBadRequest, code, err.Error(), nil)
}

// maxUploadSize 限制 pod 文件上传的请求体大小，
// 以免有权限的用户用无上限的请求塞满 pod 的磁盘。
const maxUploadSize = 512 << 20 // 512 MiB

func (h *PodHandler) UploadFile(c *gin.Context) {
	namespace := c.Param("namespace")
	podName := c.Param("name")
	container := c.Query("container")
	path := c.Query("path")
	cs := c.MustGet("cluster").(*cluster.ClientSet)
	if err := validateContainerPath(path); err != nil {
		respondFilePathError(c, err)
		return
	}

	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxUploadSize)
	file, header, err := c.Request.FormFile("file")
	if err != nil {
		if strings.Contains(err.Error(), "request body too large") ||
			strings.Contains(err.Error(), "http: request body too large") {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "uploaded file is too large"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": "failed to get file from request"})
		return
	}
	defer func() {
		if err := file.Close(); err != nil {
			klog.Errorf("failed to close uploaded file: %v", err)
		}
	}()

	filename := filepath.Base(header.Filename)
	if filename == "." || filename == ".." || strings.Contains(filename, "/") || strings.Contains(filename, "\\") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid filename"})
		return
	}

	// 使用清洗后的名称，而不是原始 multipart 值：
	// 上面的校验针对的是文件名，两者不能出现偏差。
	destPath := filepath.Join(path, filename)
	if filepath.Dir(destPath) != filepath.Clean(path) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid destination path"})
		return
	}
	cmd := []string{"tee", destPath}

	err = cs.K8sClient.ExecCommand(c.Request.Context(), kube.ExecOptions{
		Namespace:     namespace,
		PodName:       podName,
		ContainerName: container,
		Command:       cmd,
		Stdin:         file, // Stream file content directly
		Stdout:        nil,
		Stderr:        nil,
		TTY:           false,
	})

	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("failed to upload file: %v", err)})
		h.recordFileAudit(c, cs, namespace, podName, "upload-file", destPath, container, false, err)
		return
	}

	h.recordFileAudit(c, cs, namespace, podName, "upload-file", destPath, container, true, nil)
	c.JSON(http.StatusOK, gin.H{"message": "file uploaded successfully"})
}

// recordFileAudit 将容器文件的查看/下载/上传动作写入审计日志。
// operation 为 view-file / download-file / upload-file；文件路径与容器名
// 记录在 resourceYAML 字段中，便于在审计日志中检索。
func (h *PodHandler) recordFileAudit(c *gin.Context, cs *cluster.ClientSet, namespace, podName, operation, path, container string, success bool, opErr error) {
	user, ok := c.MustGet("user").(model.User)
	if !ok {
		return
	}
	var errorMessage string
	if opErr != nil {
		errorMessage = opErr.Error()
	}
	history := model.ResourceHistory{
		ClusterName:     cs.Name,
		ResourceType:    string(common.Pods),
		ResourceName:    podName,
		Namespace:       namespace,
		OperationType:   operation,
		OperationSource: "manual",
		ResourceYAML:    model.LongText(fmt.Sprintf("container: %s\npath: %s", container, path)),
		Success:         success,
		ErrorMessage:    errorMessage,
		OperatorID:      model.OperatorRef(user.ID),
		OperatorName:    user.Username,
		ClientIP:        c.ClientIP(),
		UserAgent:       common.AuditUserAgent(c.Request.UserAgent()),
	}
	if err := model.RecordAudit(c.Request.Context(), &history); err != nil {
		klog.Errorf("failed to record file audit: %v", err)
	}
}

func setSSEHeaders(c *gin.Context) {
	c.Writer.Header().Set("Content-Type", "text/event-stream")
	c.Writer.Header().Set("Cache-Control", "no-cache, no-transform")
	c.Writer.Header().Set("Connection", "keep-alive")
	c.Writer.Header().Set("X-Accel-Buffering", "no")
	// 尝试分块流式传输
	c.Writer.Header().Set("Transfer-Encoding", "chunked")
}

// initSSE 先把响应头与一条注释行写出去。上游 watch 建立前就写出响应头，
// 客户端不必等第一个事件（最长一个推送周期）才拿到响应，避免一直 pending。
func initSSE(c *gin.Context, clusterName string) error {
	setSSEHeaders(c)

	flusher, ok := c.Writer.(http.Flusher)
	if !ok {
		return fmt.Errorf("streaming unsupported")
	}

	c.Writer.WriteHeaderNow()
	connectedWritten, err := fmt.Fprint(c.Writer, ": connected\n\n")
	if err != nil {
		return err
	}
	// 服务端主动断开（event: close）后，浏览器按这个间隔重连，避免立刻回连打风暴。
	retryWritten, err := fmt.Fprint(c.Writer, "retry: 5000\n\n")
	if err != nil {
		return err
	}
	flusher.Flush()

	recordWatchBytes(clusterName, connectedWritten+retryWritten)
	return nil
}

func writeSSE(c *gin.Context, clusterName string, event string, payload any) error {
	setSSEHeaders(c)

	flusher, ok := c.Writer.(http.Flusher)
	if !ok {
		return fmt.Errorf("streaming unsupported")
	}

	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	eventWritten, err := fmt.Fprintf(c.Writer, "event: %s\n", event)
	if err != nil {
		return err
	}
	dataWritten, err := fmt.Fprintf(c.Writer, "data: %s\n\n", b)
	if err != nil {
		return err
	}
	flusher.Flush()

	middleware.WatchEventsPushed.WithLabelValues(clusterName, string(common.Pods), event).Inc()
	recordWatchBytes(clusterName, eventWritten+dataWritten)
	return nil
}

// recordWatchBytes 累计资源 watch 写出到客户端的字节数（未压缩口径）。
func recordWatchBytes(clusterName string, written int) {
	if written <= 0 {
		return
	}
	middleware.WatchPushBytes.WithLabelValues(clusterName, string(common.Pods)).Add(float64(written))
}

// reducePod 按 reduce 参数裁剪 Pod 字段。裁剪只依赖 Pod 本身（与登录用户无关），
// 事件推送与周期推送共用同一份口径。
func reducePod(pod *corev1.Pod, reduce bool) *PodWithMetrics {
	obj := &PodWithMetrics{Pod: pod}
	if !reduce {
		return obj
	}
	obj.Pod = pod.DeepCopy()
	obj.ObjectMeta = metav1.ObjectMeta{
		Name:              pod.Name,
		Namespace:         pod.Namespace,
		CreationTimestamp: pod.CreationTimestamp,
		DeletionTimestamp: pod.DeletionTimestamp,
		GenerateName:      pod.GenerateName,
	}
	obj.Spec = corev1.PodSpec{
		NodeName: pod.Spec.NodeName,
		InitContainers: lo.Map(pod.Spec.InitContainers, func(c corev1.Container, _ int) corev1.Container {
			return corev1.Container{Name: c.Name, Image: c.Image, RestartPolicy: c.RestartPolicy}
		}),
		Containers: lo.Map(pod.Spec.Containers, func(c corev1.Container, _ int) corev1.Container {
			return corev1.Container{Name: c.Name, Image: c.Image, RestartPolicy: c.RestartPolicy}
		}),
	}
	return obj
}

// watchMetricsMap 取本周期用于推送的 Pod 用量：有共享 hub 且请求不带 labelSelector 时，
// 复用该集群本周期的读取结果（省掉「每连接各读一次」的重复计算，P1）；
// 带 labelSelector 或没有 hub 时退回每连接各自读取，结果始终与请求条件一致。
func (h *PodHandler) watchMetricsMap(c *gin.Context, cs *cluster.ClientSet, hub *podWatchHub, namespace, labelSelector string, interval time.Duration) map[string]metricsv1.PodMetrics {
	if hub != nil && labelSelector == "" {
		metricsMap, err := hub.podMetricsMap(c.Request.Context(), cs, namespace, interval)
		if err == nil {
			return metricsMap
		}
		klog.V(2).Infof("shared pod metrics unavailable for cluster %s, falling back to per-connection read: %v", cs.Name, err)
	}
	metricsMap, _ := h.ListMetrics(c)
	return metricsMap
}

// sendPodWatchSnapshot 用 informer 缓存的快照补上「直连 watch 会补发的那批 ADDED」。
// 读缓存不产生 apiserver 请求，逐条仍走与事件相同的鉴权与裁剪口径。
func (h *PodHandler) sendPodWatchSnapshot(
	c *gin.Context,
	cs *cluster.ClientSet,
	user model.User,
	namespace, labelSelector, fieldSelector string,
	reduce bool,
	metricsMap map[string]metricsv1.PodMetrics,
) error {
	var (
		podList  corev1.PodList
		listOpts []client.ListOption
	)
	if namespace != "" {
		listOpts = append(listOpts, client.InNamespace(namespace))
	}
	if labelSelector != "" {
		selector, err := metav1.ParseToLabelSelector(labelSelector)
		if err != nil {
			return fmt.Errorf("invalid labelSelector parameter: %w", err)
		}
		parsed, err := metav1.LabelSelectorAsSelector(selector)
		if err != nil {
			return fmt.Errorf("failed to convert labelSelector: %w", err)
		}
		listOpts = append(listOpts, client.MatchingLabelsSelector{Selector: parsed})
	}
	if err := cs.K8sClient.List(c.Request.Context(), &podList, listOpts...); err != nil {
		return err
	}

	// fieldSelector 里可能有缓存不支持索引的字段，这里与 hub 的过滤口径保持一致，逐条匹配。
	var fieldMatcher fields.Selector
	if fieldSelector != "" {
		parsed, err := fields.ParseSelector(fieldSelector)
		if err != nil {
			return fmt.Errorf("invalid fieldSelector parameter: %w", err)
		}
		fieldMatcher = parsed
	}

	for i := range podList.Items {
		pod := &podList.Items[i]
		if fieldMatcher != nil && !fieldMatcher.Matches(podFieldSet(pod)) {
			continue
		}
		if !rbac.CanAccessCurrent(user, string(common.Pods), string(common.VerbGet), cs.Name, pod.Namespace) {
			continue
		}
		obj := reducePod(pod, reduce)
		obj.Metrics = GetPodMetrics(metricsMap, pod)
		if err := writeSSE(c, cs.Name, "added", obj); err != nil {
			return err
		}
	}
	return nil
}

// Watch 实现基于 SSE 的 pod 列表监听：先给初始快照，再给增量更新
func (h *PodHandler) Watch(c *gin.Context) {
	cs := c.MustGet("cluster").(*cluster.ClientSet)

	// 解析参数
	namespace := c.Param("namespace")
	if namespace == "" {
		namespace = common.AllNamespaces
	}
	reduce := c.DefaultQuery("reduce", "false") == "true"
	labelSelector := c.Query("labelSelector")
	fieldSelector := c.Query("fieldSelector")

	// 对每个流式推送的条目按最新角色配置重新鉴权，
	// 这样角色被回收后无需等连接关闭即可生效。
	// 对跨命名空间监听而言，这也会在中间件的资源级入口校验之后
	// 丢弃来自未授权命名空间的事件。
	user := c.MustGet("user").(model.User)

	// P3：按 (用户, 集群) 限制并发连接。超限时在建立上游 watch / 读用量之前就拒绝，
	// 明确告知客户端（429），前端据此降级为轮询——而不是让一个人开几十个标签页
	// 把连接数与推送量一起推上去。
	release, ok := podWatchLimiter.acquire(user.Username, cs.Name, common.MaxWatchPerUser)
	if !ok {
		middleware.WatchRejected.WithLabelValues(cs.Name).Inc()
		klog.V(2).Infof("pod watch rejected for user %s on cluster %s: over limit %d", user.Username, cs.Name, common.MaxWatchPerUser)
		c.Header("Retry-After", strconv.Itoa(int(watchLimitRetryAfter.Seconds())))
		c.JSON(http.StatusTooManyRequests, gin.H{
			"error": fmt.Sprintf("too many concurrent watch connections (limit %d per user per cluster)", common.MaxWatchPerUser),
			"code":  watchLimitExceededCode,
		})
		return
	}
	defer release()

	listOpts := metav1.ListOptions{}
	if labelSelector != "" {
		listOpts.LabelSelector = labelSelector
	}
	if fieldSelector != "" {
		listOpts.FieldSelector = fieldSelector
	}

	ns := namespace
	if ns == common.AllNamespaces {
		ns = ""
	}
	metricsMap, err := h.ListMetrics(c)
	if err != nil {
		klog.Warningf("Failed to list pod metrics: %v", err)
	}

	// 先把响应头与 retry 写出去：上游 watch 建立前客户端就能拿到响应头，
	// 不必等第一个事件（最长一个推送周期）才结束 pending。
	middleware.WatchConnections.WithLabelValues(cs.Name, string(common.Pods)).Inc()
	defer middleware.WatchConnections.WithLabelValues(cs.Name, string(common.Pods)).Dec()

	if err := initSSE(c, cs.Name); err != nil {
		klog.Warningf("failed to init SSE stream: %v", err)
		return
	}

	// P1：优先订阅集群级共享的 hub——上游 pod watch 从「每连接一条」降为「每集群一条」。
	// 缓存不可用（DISABLE_CACHE=true 或客户端已停用）时显式退回直连 watch，不静默降级。
	var (
		watchEvents <-chan podWatchEvent
		stopSource  func()
	)
	hub, hubErr := acquirePodWatchHub(cs)
	if hubErr == nil {
		subscription, err := hub.subscribe(ns, labelSelector, fieldSelector)
		if err != nil {
			hubErr = err
		} else {
			watchEvents = subscription.Events()
			stopSource = subscription.Close
			// 直连 watch 建立时 apiserver 会补发一批 ADDED 当作初始快照，
			// hub 路径没有这一步，这里用缓存快照补上（不产生 apiserver 请求）。
			if err := h.sendPodWatchSnapshot(c, cs, user, ns, labelSelector, fieldSelector, reduce, metricsMap); err != nil {
				klog.Warningf("failed to send pod watch snapshot for cluster %s: %v", cs.Name, err)
			}
		}
	}
	if watchEvents == nil {
		klog.V(2).Infof("pod watch for cluster %s uses direct watch: %v", cs.Name, hubErr)
		events, stop, err := directPodWatch(c.Request.Context(), cs, ns, listOpts)
		if err != nil {
			_ = writeSSE(c, cs.Name, "error", gin.H{"error": fmt.Sprintf("failed to start watch: %v", err)})
			return
		}
		watchEvents = events
		stopSource = stop
	}
	defer stopSource()

	// 指标推送与保活心跳各自独立定时器：心跳节奏不随 AEROLINK_POD_METRICS_INTERVAL 变化。
	metricsInterval := podMetricsIntervalFn()
	ticker := time.NewTicker(metricsInterval)
	defer ticker.Stop()
	pingTicker := time.NewTicker(podWatchPingInterval)
	defer pingTicker.Stop()

	flusher, _ := c.Writer.(http.Flusher)

	// lastUsage 记录上一次下发的用量：周期内没有变化的 Pod 不再推送，
	// 推送量因此与「变化量」成正比，而不是与 Pod 总数成正比。
	// 每轮只保留当前仍可见的 Pod，Pod 消失后条目随之释放。
	lastUsage := make(map[string][2]int64)

	for {
		select {
		case <-c.Request.Context().Done():
			_ = writeSSE(c, cs.Name, "close", gin.H{"message": "connection closed"})
			return
		case <-pingTicker.C:
			_, _ = fmt.Fprintf(c.Writer, ": ping\n\n") // comment line per SSE
			flusher.Flush()
		case <-ticker.C:
			metricsMap = h.watchMetricsMap(c, cs, hub, ns, labelSelector, metricsInterval)
			updates := make([]podMetricsUpdate, 0, len(metricsMap))
			nextUsage := make(map[string][2]int64, len(metricsMap))
			for _, metrics := range metricsMap {
				if !rbac.CanAccessCurrent(user, string(common.Pods), string(common.VerbGet), cs.Name, metrics.Namespace) {
					continue
				}
				// 与 GetPodMetrics 同一口径：没有容器用量时不下发，避免把数字刷成 0。
				if len(metrics.Containers) == 0 {
					continue
				}
				key := metrics.Namespace + "/" + metrics.Name
				cpuUsage, memUsage := podUsageFromMetrics(metrics)
				if prev, ok := lastUsage[key]; ok && prev[0] == cpuUsage && prev[1] == memUsage {
					nextUsage[key] = prev
					continue
				}
				nextUsage[key] = [2]int64{cpuUsage, memUsage}
				updates = append(updates, podMetricsUpdate{
					Namespace:   metrics.Namespace,
					Name:        metrics.Name,
					CPUUsage:    cpuUsage,
					MemoryUsage: memUsage,
				})
			}
			lastUsage = nextUsage
			if len(updates) > 0 {
				_ = writeSSE(c, cs.Name, "metrics", updates)
			}
		case event, ok := <-watchEvents:
			if !ok {
				_ = writeSSE(c, cs.Name, "close", gin.H{"message": "watch channel closed"})
				return
			}

			pod := event.Pod
			if pod == nil {
				continue
			}
			if !rbac.CanAccessCurrent(user, string(common.Pods), string(common.VerbGet), cs.Name, pod.Namespace) {
				continue
			}

			obj := reducePod(pod, reduce)
			obj.Metrics = GetPodMetrics(metricsMap, pod)
			switch event.Type {
			case watch.Added:
				_ = writeSSE(c, cs.Name, "added", obj)
			case watch.Modified:
				_ = writeSSE(c, cs.Name, "modified", obj)
			case watch.Deleted:
				_ = writeSSE(c, cs.Name, "deleted", obj)
			case watch.Error:
				_ = writeSSE(c, cs.Name, "error", gin.H{"error": "watch error"})
			default:
				// 忽略
			}
		}
	}
}
