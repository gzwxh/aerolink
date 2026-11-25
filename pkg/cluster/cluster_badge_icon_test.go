package cluster

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/gzwxh/aerolink/pkg/common"
	"github.com/gzwxh/aerolink/pkg/imageupload"
	"github.com/gzwxh/aerolink/pkg/model"
)

// iconRouter 挂上徽章图标的三条路由，前缀与 routes.go 保持一致，
// 这样 BadgeIconPath 写进 badge_icon_url 的地址在测试里就是可直接请求的路径。
func iconRouter() *gin.Engine {
	router := gin.New()
	admin := router.Group("/api/v1/admin/clusters")
	admin.POST("/:id/badge-icon", UploadClusterBadgeIcon)
	admin.DELETE("/:id/badge-icon", DeleteClusterBadgeIcon)
	router.GET("/api/v1/clusters/:id/badge-icon", GetClusterBadgeIcon)
	return router
}

func adminIconPath(clusterID uint) string {
	return fmt.Sprintf("/api/v1/admin/clusters/%d/badge-icon", clusterID)
}

// encodeTestImage 生成一张指定尺寸的测试图片（色块，压缩后很小）。
func encodeTestImage(t *testing.T, format string, width, height int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for x := 0; x < width; x++ {
		img.Set(x, 0, color.RGBA{R: 255, A: 255})
	}

	buf := &bytes.Buffer{}
	var err error
	switch format {
	case "png":
		err = png.Encode(buf, img)
	case "jpeg":
		err = jpeg.Encode(buf, img, nil)
	default:
		t.Fatalf("unsupported test format %q", format)
	}
	if err != nil {
		t.Fatalf("encoding test image: %v", err)
	}
	return buf.Bytes()
}

func performIconUpload(router *gin.Engine, clusterID uint, filename string, data []byte) *httptest.ResponseRecorder {
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, err := writer.CreateFormFile("file", filename)
	if err != nil {
		panic(err)
	}
	if _, err := part.Write(data); err != nil {
		panic(err)
	}
	if err := writer.Close(); err != nil {
		panic(err)
	}

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, adminIconPath(clusterID), body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	router.ServeHTTP(recorder, request)
	return recorder
}

func createIconTestCluster(t *testing.T, name string) *model.Cluster {
	t.Helper()
	cluster := &model.Cluster{Name: name, Config: model.SecretString("secret-kubeconfig"), Enable: true}
	if err := model.AddCluster(cluster); err != nil {
		t.Fatalf("creating cluster %s: %v", name, err)
	}
	return cluster
}

func loadIconURL(t *testing.T, clusterID uint) string {
	t.Helper()
	stored, err := model.GetClusterByID(clusterID)
	if err != nil {
		t.Fatalf("loading cluster %d: %v", clusterID, err)
	}
	return stored.BadgeIconURL
}

func decodeIconErrorCode(t *testing.T, recorder *httptest.ResponseRecorder) string {
	t.Helper()
	var payload struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decoding error response %q: %v", recorder.Body.String(), err)
	}
	return payload.Code
}

// TestUploadClusterBadgeIconStoresBytesAndEnablesIcon 覆盖上传主路径：
// 字节落库、badge_icon_url 指向取图接口、顺带打开「自定义图标」开关，
// 以及取图接口的类型/缓存头/ETag/304。
func TestUploadClusterBadgeIconStoresBytesAndEnablesIcon(t *testing.T) {
	setupClusterHandlerTestDB(t)
	router := iconRouter()
	cluster := createIconTestCluster(t, "primary")
	imageBytes := encodeTestImage(t, "png", 64, 64)

	response := performIconUpload(router, cluster.ID, "icon.png", imageBytes)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusOK, response.Body.String())
	}

	icon, err := model.GetClusterBadgeIcon(cluster.ID)
	if err != nil {
		t.Fatalf("loading stored icon: %v", err)
	}
	if icon.ContentType != "image/png" {
		t.Errorf("content type = %q, want image/png", icon.ContentType)
	}
	if !bytes.Equal(icon.Data, imageBytes) {
		t.Error("stored bytes differ from the uploaded file")
	}

	stored, err := model.GetClusterByID(cluster.ID)
	if err != nil {
		t.Fatalf("loading cluster: %v", err)
	}
	if want := BadgeIconPath(cluster.ID, icon.ContentHash); stored.BadgeIconURL != want {
		t.Errorf("badge_icon_url = %q, want %q", stored.BadgeIconURL, want)
	}
	// 传了图却不打开开关的话，界面上看不到任何变化，只能当成功能坏了。
	if !stored.BadgeIconEnabled {
		t.Error("uploading an icon did not enable the custom icon")
	}

	// 取图：类型、nosniff、长缓存、字节一致，并支持 ETag 304。
	request := httptest.NewRequest(http.MethodGet, stored.BadgeIconURL, nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("get icon status = %d, want %d", recorder.Code, http.StatusOK)
	}
	if got := recorder.Header().Get("Content-Type"); got != "image/png" {
		t.Errorf("content type = %q, want image/png", got)
	}
	if got := recorder.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("x-content-type-options = %q, want nosniff", got)
	}
	if !strings.Contains(recorder.Header().Get("Cache-Control"), "immutable") {
		t.Errorf("cache-control = %q, want an immutable long cache", recorder.Header().Get("Cache-Control"))
	}
	if !bytes.Equal(recorder.Body.Bytes(), imageBytes) {
		t.Error("served bytes differ from the uploaded file")
	}

	etag := recorder.Header().Get("ETag")
	if etag == "" {
		t.Fatal("ETag header is missing")
	}
	request = httptest.NewRequest(http.MethodGet, stored.BadgeIconURL, nil)
	request.Header.Set("If-None-Match", etag)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotModified {
		t.Errorf("status with If-None-Match = %d, want %d", recorder.Code, http.StatusNotModified)
	}

	// 换一张不同的图：URL 变（浏览器缓存因此失效），字节被替换。
	replaced := encodeTestImage(t, "jpeg", 32, 32)
	if response := performIconUpload(router, cluster.ID, "icon.jpg", replaced); response.Code != http.StatusOK {
		t.Fatalf("replace status = %d: %s", response.Code, response.Body.String())
	}
	afterReplace, err := model.GetClusterBadgeIcon(cluster.ID)
	if err != nil {
		t.Fatalf("loading replaced icon: %v", err)
	}
	if afterReplace.ContentHash == icon.ContentHash {
		t.Error("content hash did not change after uploading different bytes")
	}
	if afterReplace.ContentType != "image/jpeg" || !bytes.Equal(afterReplace.Data, replaced) {
		t.Error("replaced icon did not overwrite the stored bytes")
	}
	if got, want := loadIconURL(t, cluster.ID), BadgeIconPath(cluster.ID, afterReplace.ContentHash); got != want {
		t.Errorf("badge_icon_url = %q, want %q", got, want)
	}
}

// TestUploadClusterBadgeIconRejectsInvalidFiles 覆盖各类拒绝：非图片（含 SVG / GIF）、
// 声明成 PNG 但内容损坏、尺寸超限、体积超限。全部不得落库，也不得动 badge_icon_url。
func TestUploadClusterBadgeIconRejectsInvalidFiles(t *testing.T) {
	setupClusterHandlerTestDB(t)
	router := iconRouter()
	cluster := createIconTestCluster(t, "primary")

	oversized := make([]byte, imageupload.MaxBytes+1)
	copy(oversized, encodeTestImage(t, "png", 8, 8))
	for i := range oversized[64:] {
		oversized[64+i] = byte(i % 251)
	}

	cases := []struct {
		name     string
		filename string
		data     []byte
		status   int
		code     string
	}{
		{
			name:     "plain text with an image extension",
			filename: "icon.png",
			data:     []byte("this is not an image at all"),
			status:   http.StatusBadRequest,
			code:     clusterIconCodeInvalidType,
		},
		{
			// SVG 是脚本载体，内联返回等于存储型 XSS，必须按类型拒掉。
			name:     "svg",
			filename: "icon.svg",
			data:     []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`),
			status:   http.StatusBadRequest,
			code:     clusterIconCodeInvalidType,
		},
		{
			name:     "gif",
			filename: "icon.gif",
			data:     []byte("GIF89a\x01\x00\x01\x00\x00\x00\x00;"),
			status:   http.StatusBadRequest,
			code:     clusterIconCodeInvalidType,
		},
		{
			// 头是 PNG，后面接垃圾：既能骗过嗅探，也必须被解码校验挡住。
			name:     "truncated png",
			filename: "icon.png",
			data:     append([]byte("\x89PNG\r\n\x1a\n"), []byte("garbage")...),
			status:   http.StatusBadRequest,
			code:     clusterIconCodeInvalidImage,
		},
		{
			name:     "dimensions above the limit",
			filename: "huge.png",
			data:     encodeTestImage(t, "png", imageupload.MaxDimension+1, 16),
			status:   http.StatusBadRequest,
			code:     clusterIconCodeDimensionsTooLarge,
		},
		{
			name:     "bytes above the limit",
			filename: "big.png",
			data:     oversized,
			status:   http.StatusRequestEntityTooLarge,
			code:     clusterIconCodeTooLarge,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			response := performIconUpload(router, cluster.ID, tc.filename, tc.data)
			if response.Code != tc.status {
				t.Fatalf("status = %d, want %d: %s", response.Code, tc.status, response.Body.String())
			}
			if code := decodeIconErrorCode(t, response); code != tc.code {
				t.Errorf("code = %q, want %q", code, tc.code)
			}
			if _, err := model.GetClusterBadgeIcon(cluster.ID); err == nil {
				t.Error("rejected upload was stored anyway")
			}
			if url := loadIconURL(t, cluster.ID); url != "" {
				t.Errorf("badge_icon_url = %q after a rejected upload, want it untouched", url)
			}
		})
	}
}

// TestUploadClusterBadgeIconKeepsPreviousIconOnRejection 锁住「拒绝不破坏现有配置」：
// 一次失败的替换不能把已经在用的图标弄没。
func TestUploadClusterBadgeIconKeepsPreviousIconOnRejection(t *testing.T) {
	setupClusterHandlerTestDB(t)
	router := iconRouter()
	cluster := createIconTestCluster(t, "primary")
	imageBytes := encodeTestImage(t, "png", 32, 32)

	if response := performIconUpload(router, cluster.ID, "icon.png", imageBytes); response.Code != http.StatusOK {
		t.Fatalf("upload status = %d: %s", response.Code, response.Body.String())
	}
	beforeURL := loadIconURL(t, cluster.ID)

	if response := performIconUpload(router, cluster.ID, "icon.svg", []byte(`<svg/>`)); response.Code != http.StatusBadRequest {
		t.Fatalf("svg status = %d, want %d", response.Code, http.StatusBadRequest)
	}

	icon, err := model.GetClusterBadgeIcon(cluster.ID)
	if err != nil {
		t.Fatalf("the previous icon was dropped by a rejected upload: %v", err)
	}
	if !bytes.Equal(icon.Data, imageBytes) {
		t.Error("the previous icon bytes were overwritten by a rejected upload")
	}
	if after := loadIconURL(t, cluster.ID); after != beforeURL {
		t.Errorf("badge_icon_url = %q after a rejected upload, want %q", after, beforeURL)
	}
}

// TestUploadAndDeleteClusterBadgeIconHonorManagedConfiguration 覆盖配置托管模式：
// 这两条路由都是写操作，必须和集群的其它写操作一样 fail-closed。
func TestUploadAndDeleteClusterBadgeIconHonorManagedConfiguration(t *testing.T) {
	setupClusterHandlerTestDB(t)
	// 托管开关只拦 handler，不能拦建集群本身，所以顺序是先声明托管再建集群。
	common.SetManagedSections(map[string]bool{"clusters": true})
	router := iconRouter()
	cluster := createIconTestCluster(t, "primary")

	if response := performIconUpload(router, cluster.ID, "icon.png", encodeTestImage(t, "png", 8, 8)); response.Code != http.StatusForbidden {
		t.Errorf("upload status = %d, want %d", response.Code, http.StatusForbidden)
	}

	request := httptest.NewRequest(http.MethodDelete, adminIconPath(cluster.ID), nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Errorf("delete status = %d, want %d", recorder.Code, http.StatusForbidden)
	}
	if _, err := model.GetClusterBadgeIcon(cluster.ID); err == nil {
		t.Error("a managed configuration still allowed the icon to be stored")
	}
}

// TestDeleteClusterBadgeIconClearsRowAndURL 覆盖「移除图标」：
// 字节行与 badge_icon_url 必须一起清掉，否则界面上会留下一个 404 的图标地址。
func TestDeleteClusterBadgeIconClearsRowAndURL(t *testing.T) {
	setupClusterHandlerTestDB(t)
	router := iconRouter()
	cluster := createIconTestCluster(t, "primary")

	if response := performIconUpload(router, cluster.ID, "icon.png", encodeTestImage(t, "png", 16, 16)); response.Code != http.StatusOK {
		t.Fatalf("upload status = %d: %s", response.Code, response.Body.String())
	}
	iconURL := loadIconURL(t, cluster.ID)

	request := httptest.NewRequest(http.MethodDelete, adminIconPath(cluster.ID), nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("delete status = %d, want %d: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	if _, err := model.GetClusterBadgeIcon(cluster.ID); err == nil {
		t.Error("icon row survived the delete")
	}
	if url := loadIconURL(t, cluster.ID); url != "" {
		t.Errorf("badge_icon_url = %q after delete, want it cleared", url)
	}

	// 地址已经不指向任何字节：取图必须 404，前端据此回落。
	request = httptest.NewRequest(http.MethodGet, iconURL, nil)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound {
		t.Errorf("get deleted icon status = %d, want %d", recorder.Code, http.StatusNotFound)
	}

	// 再删一次是无操作，不算错误。
	request = httptest.NewRequest(http.MethodDelete, adminIconPath(cluster.ID), nil)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Errorf("second delete status = %d, want %d", recorder.Code, http.StatusOK)
	}
}

// TestDeleteClusterRemovesBadgeIcon 覆盖孤儿清理：图标以 cluster_id 为主键单独成表，
// 集群行删掉后就再也取不到了，必须一起删。
func TestDeleteClusterRemovesBadgeIcon(t *testing.T) {
	setupClusterHandlerTestDB(t)
	router := iconRouter()
	cluster := createIconTestCluster(t, "doomed")

	if response := performIconUpload(router, cluster.ID, "icon.png", encodeTestImage(t, "png", 16, 16)); response.Code != http.StatusOK {
		t.Fatalf("upload status = %d: %s", response.Code, response.Body.String())
	}

	if err := model.DeleteCluster(cluster); err != nil {
		t.Fatalf("deleting cluster: %v", err)
	}
	if _, err := model.GetClusterBadgeIcon(cluster.ID); err == nil {
		t.Error("badge icon row outlived its cluster")
	}
}

// TestGetClusterBadgeIconWithoutUploadReturns404 覆盖「没上传过」与非法 id：
// 前端据此回落默认图标或图标文本，不能是 5xx。
func TestGetClusterBadgeIconWithoutUploadReturns404(t *testing.T) {
	setupClusterHandlerTestDB(t)
	router := iconRouter()
	cluster := createIconTestCluster(t, "primary")

	for _, path := range []string{
		fmt.Sprintf("/api/v1/clusters/%d/badge-icon", cluster.ID),
		fmt.Sprintf("/api/v1/clusters/%d/badge-icon?v=1", cluster.ID),
		"/api/v1/clusters/0/badge-icon",
		"/api/v1/clusters/not-a-number/badge-icon",
		"/api/v1/clusters/99999/badge-icon",
	} {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusNotFound {
			t.Errorf("GET %s = %d, want %d", path, recorder.Code, http.StatusNotFound)
		}
	}

	// 上传接口同样要挡住非法 id 与不存在的集群。
	for _, path := range []string{
		"/api/v1/admin/clusters/0/badge-icon",
		"/api/v1/admin/clusters/not-a-number/badge-icon",
		"/api/v1/admin/clusters/99999/badge-icon",
	} {
		body := &bytes.Buffer{}
		writer := multipart.NewWriter(body)
		part, err := writer.CreateFormFile("file", "icon.png")
		if err != nil {
			t.Fatalf("building multipart body: %v", err)
		}
		if _, err := part.Write(encodeTestImage(t, "png", 8, 8)); err != nil {
			t.Fatalf("writing multipart body: %v", err)
		}
		if err := writer.Close(); err != nil {
			t.Fatalf("closing multipart writer: %v", err)
		}

		request := httptest.NewRequest(http.MethodPost, path, body)
		request.Header.Set("Content-Type", writer.FormDataContentType())
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusBadRequest && recorder.Code != http.StatusNotFound {
			t.Errorf("POST %s = %d, want 400 or 404: %s", path, recorder.Code, recorder.Body.String())
		}
	}
}

// TestUploadClusterBadgeIconRequiresAFile 覆盖缺字段与空文件：
// 这两类都不该被当成成功，也不该落库。
func TestUploadClusterBadgeIconRequiresAFile(t *testing.T) {
	setupClusterHandlerTestDB(t)
	router := iconRouter()
	cluster := createIconTestCluster(t, "primary")

	// 完全没有 file 字段。
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	if err := writer.WriteField("other", "value"); err != nil {
		t.Fatalf("writing field: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("closing multipart writer: %v", err)
	}
	request := httptest.NewRequest(http.MethodPost, adminIconPath(cluster.ID), body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("missing file status = %d, want %d", recorder.Code, http.StatusBadRequest)
	}
	if code := decodeIconErrorCode(t, recorder); code != clusterIconCodeFileMissing {
		t.Errorf("code = %q, want %q", code, clusterIconCodeFileMissing)
	}

	// 空文件。
	response := performIconUpload(router, cluster.ID, "empty.png", nil)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("empty file status = %d, want %d", response.Code, http.StatusBadRequest)
	}
	if code := decodeIconErrorCode(t, response); code != clusterIconCodeFileMissing {
		t.Errorf("code = %q, want %q", code, clusterIconCodeFileMissing)
	}
	if _, err := model.GetClusterBadgeIcon(cluster.ID); err == nil {
		t.Error("an empty upload was stored anyway")
	}
}

// 删除徽章图标是一次子资源删除：审计里至少要能看出动的是哪个集群。
func TestDeleteClusterBadgeIconRecordsAuditDetail(t *testing.T) {
	setupClusterHandlerTestDB(t)
	cluster := createIconTestCluster(t, "primary")

	var detail common.AdminAuditDetail
	router := gin.New()
	router.DELETE("/api/v1/admin/clusters/:id/badge-icon", func(c *gin.Context) {
		DeleteClusterBadgeIcon(c)
		if value, ok := c.Get(common.AdminAuditDetailKey); ok {
			detail, _ = value.(common.AdminAuditDetail)
		}
	})

	request := httptest.NewRequest(http.MethodDelete, adminIconPath(cluster.ID), nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("delete status = %d, want %d: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	if detail.ResourceName != "primary" {
		t.Fatalf("audit resourceName = %q, want the cluster name", detail.ResourceName)
	}
}
