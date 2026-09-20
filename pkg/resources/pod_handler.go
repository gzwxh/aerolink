package resources

import (
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"path/filepath"
	"sort"
	"strings"
	"time"

	semver "github.com/blang/semver/v4"
	"github.com/gin-gonic/gin"
	"github.com/samber/lo"
	"github.com/zxh326/kite/pkg/cluster"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/kube"
	"github.com/zxh326/kite/pkg/model"
	"github.com/zxh326/kite/pkg/rbac"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
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

func (h *PodHandler) ListMetrics(c *gin.Context) (map[string]metricsv1.PodMetrics, error) {
	cs := c.MustGet("cluster").(*cluster.ClientSet)
	var metricsList metricsv1.PodMetricsList
	var listOpts []client.ListOption
	if namespace := c.Param("namespace"); namespace != "" && namespace != common.AllNamespaces {
		listOpts = append(listOpts, client.InNamespace(namespace))
	}
	if labelSelector := c.Query("labelSelector"); labelSelector != "" {
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
	if err := cs.K8sClient.List(c, &metricsList, listOpts...); err != nil {
		klog.Warningf("Failed to list pod metrics: %v", err)
	}

	metricsMap := lo.KeyBy(metricsList.Items, func(item metricsv1.PodMetrics) string {
		return item.Namespace + "/" + item.Name
	})

	return metricsMap, nil
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
		if strings.Contains(err.Error(), "not found") || strings.Contains(stderr, "not found") {
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

	_, _, err := cs.K8sClient.ExecCommandBuffered(c.Request.Context(), namespace, podName, container, []string{"test", "-d", path})
	isDir := err == nil

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

	err = cs.K8sClient.ExecCommand(c.Request.Context(), kube.ExecOptions{
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
	fileCodePathRequired  = "pod_files_path_required"
	fileCodePathInvalid   = "pod_files_path_invalid"
	fileCodePathTraversal = "pod_files_path_traversal"
)

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
	if err := model.DB.Create(&model.ResourceHistory{
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
	}).Error; err != nil {
		klog.Errorf("failed to record file audit: %v", err)
	}
}

func writeSSE(c *gin.Context, event string, payload any) error {
	c.Writer.Header().Set("Content-Type", "text/event-stream")
	c.Writer.Header().Set("Cache-Control", "no-cache, no-transform")
	c.Writer.Header().Set("Connection", "keep-alive")
	c.Writer.Header().Set("X-Accel-Buffering", "no")
	// 尝试分块流式传输
	c.Writer.Header().Set("Transfer-Encoding", "chunked")

	flusher, ok := c.Writer.(http.Flusher)
	if !ok {
		return fmt.Errorf("streaming unsupported")
	}

	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(c.Writer, "event: %s\n", event); err != nil {
		return err
	}
	if _, err := fmt.Fprintf(c.Writer, "data: %s\n\n", b); err != nil {
		return err
	}
	flusher.Flush()
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

	watchInterface, err := cs.K8sClient.ClientSet.CoreV1().Pods(ns).Watch(c.Request.Context(), listOpts)
	if err != nil {
		_ = writeSSE(c, "error", gin.H{"error": fmt.Sprintf("failed to start watch: %v", err)})
		return
	}
	defer watchInterface.Stop()

	// 保活心跳
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	flusher, _ := c.Writer.(http.Flusher)

	for {
		select {
		case <-c.Request.Context().Done():
			_ = writeSSE(c, "close", gin.H{"message": "connection closed"})
			return
		case <-ticker.C:
			metricsMap, _ = h.ListMetrics(c)
			for _, metrics := range metricsMap {
				if !rbac.CanAccessCurrent(user, string(common.Pods), string(common.VerbGet), cs.Name, metrics.Namespace) {
					continue
				}
				pod, err := h.GetResource(c, metrics.Namespace, metrics.Name)
				if err != nil {
					klog.Warningf("Failed to get pod: %v", err)
					continue
				}
				p := pod.(*corev1.Pod)
				obj := &PodWithMetrics{Pod: p, Metrics: GetPodMetrics(metricsMap, p)}
				_ = writeSSE(c, "modified", obj)
			}
			_, _ = fmt.Fprintf(c.Writer, ": ping\n\n") // comment line per SSE
			flusher.Flush()
		case event, ok := <-watchInterface.ResultChan():
			if !ok {
				_ = writeSSE(c, "close", gin.H{"message": "watch channel closed"})
				return
			}

			pod, ok := event.Object.(*corev1.Pod)
			if !ok || pod == nil {
				continue
			}
			if !rbac.CanAccessCurrent(user, string(common.Pods), string(common.VerbGet), cs.Name, pod.Namespace) {
				continue
			}

			obj := &PodWithMetrics{Pod: pod}
			if reduce {
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
			}
			obj.Metrics = GetPodMetrics(metricsMap, pod)
			switch event.Type {
			case watch.Added:
				_ = writeSSE(c, "added", obj)
			case watch.Modified:
				_ = writeSSE(c, "modified", obj)
			case watch.Deleted:
				_ = writeSSE(c, "deleted", obj)
			case watch.Error:
				_ = writeSSE(c, "error", gin.H{"error": "watch error"})
			default:
				// 忽略
			}
		}
	}
}
