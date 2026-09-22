package users

import (
	"bytes"
	"encoding/json"
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
	"github.com/glebarez/sqlite"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// setupAvatarTestDB 准备一套只含头像相关表的测试库，并建一个本地用户。
func setupAvatarTestDB(t *testing.T) *model.User {
	t.Helper()
	originalDB := model.DB
	originalEncryptKey := common.EncryptKey
	originalJWTSecret := common.JwtSecret
	common.EncryptKey = "users-avatar-test-key"
	common.JwtSecret = "users-avatar-test-jwt-secret"

	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatalf("opening test database: %v", err)
	}
	// PasswordHistory 是 AddUser 的必写表；GeneralSetting 供 UpdateCurrentUser 读策略。
	if err := db.AutoMigrate(&model.User{}, &model.UserAvatar{}, &model.PasswordHistory{}, &model.GeneralSetting{}); err != nil {
		t.Fatalf("migrating test database: %v", err)
	}
	model.DB = db
	user := &model.User{Username: "alice", Password: "old-secret", Provider: model.AuthProviderPassword, Enabled: true}
	if err := model.AddUser(user); err != nil {
		t.Fatalf("creating user: %v", err)
	}
	gin.SetMode(gin.TestMode)

	t.Cleanup(func() {
		if sqlDB, err := db.DB(); err == nil {
			_ = sqlDB.Close()
		}
		model.DB = originalDB
		common.EncryptKey = originalEncryptKey
		common.JwtSecret = originalJWTSecret
	})
	return user
}

// avatarRouter 挂上头像的三条路由，并把「当前用户」注入上下文（等价于 RequireAuth 之后）。
func avatarRouter(t *testing.T, id uint64) *gin.Engine {
	t.Helper()
	router := gin.New()
	withUser := func(handler gin.HandlerFunc) gin.HandlerFunc {
		return func(c *gin.Context) {
			current, err := model.GetUserByID(id)
			if err != nil {
				c.Status(http.StatusInternalServerError)
				return
			}
			c.Set("user", *current)
			handler(c)
		}
	}
	// 前缀与 routes.go 的 registerUserRoutes 保持一致，
	// 这样 AvatarPath 写进 avatar_url 的地址在测试里就是可直接请求的路径。
	group := router.Group("/api/users")
	group.POST("/me/avatar", withUser(UploadCurrentUserAvatar))
	group.DELETE("/me/avatar", withUser(DeleteCurrentUserAvatar))
	group.GET("/:id/avatar", GetUserAvatar)
	group.PUT("/me", withUser(UpdateCurrentUser))
	return router
}

// performAvatarUpload 按 multipart/form-data 提交一个文件字段。
func performAvatarUpload(router *gin.Engine, filename string, data []byte) *httptest.ResponseRecorder {
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
	request := httptest.NewRequest(http.MethodPost, "/api/users/me/avatar", body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	router.ServeHTTP(recorder, request)
	return recorder
}

// encodeImage 生成一张指定尺寸的测试图片（色块，压缩后很小）。
func encodeImage(t *testing.T, format string, width, height int) []byte {
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

func decodeAvatarError(t *testing.T, recorder *httptest.ResponseRecorder) string {
	t.Helper()
	var payload struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decoding error response %q: %v", recorder.Body.String(), err)
	}
	return payload.Code
}

// TestUploadAvatarStoresBytesAndPointsAvatarURL 覆盖上传的主路径：
// 字节落库、users.avatar_url 指向取图接口、重复上传版本自增。
func TestUploadAvatarStoresBytesAndPointsAvatarURL(t *testing.T) {
	user := setupAvatarTestDB(t)
	router := avatarRouter(t, uint64(user.ID))
	imageBytes := encodeImage(t, "png", 64, 64)

	response := performAvatarUpload(router, "avatar.png", imageBytes)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusOK, response.Body.String())
	}

	avatar, err := model.GetUserAvatar(uint64(user.ID))
	if err != nil {
		t.Fatalf("loading stored avatar: %v", err)
	}
	if avatar.ContentType != "image/png" {
		t.Errorf("content type = %q, want image/png", avatar.ContentType)
	}
	if !bytes.Equal(avatar.Data, imageBytes) {
		t.Error("stored bytes differ from the uploaded file")
	}
	if avatar.ContentHash == "" {
		t.Error("content hash is empty")
	}

	stored, err := model.GetUserByID(uint64(user.ID))
	if err != nil {
		t.Fatalf("loading user: %v", err)
	}
	if want := AvatarPath(uint64(user.ID), avatar.ContentHash); stored.AvatarURL != want {
		t.Errorf("avatar_url = %q, want %q", stored.AvatarURL, want)
	}

	// 再传一张不同的图：URL 变（浏览器缓存因此失效），字节被替换。
	replaced := encodeImage(t, "jpeg", 32, 32)
	response = performAvatarUpload(router, "avatar.jpg", replaced)
	if response.Code != http.StatusOK {
		t.Fatalf("second upload status = %d, want %d: %s", response.Code, http.StatusOK, response.Body.String())
	}
	afterReplace, err := model.GetUserAvatar(uint64(user.ID))
	if err != nil {
		t.Fatalf("loading replaced avatar: %v", err)
	}
	if afterReplace.ContentHash == avatar.ContentHash {
		t.Error("content hash did not change after uploading different bytes")
	}
	if afterReplace.ContentType != "image/jpeg" || !bytes.Equal(afterReplace.Data, replaced) {
		t.Error("replaced avatar did not overwrite the stored bytes")
	}
}

// TestAvatarURLChangesAfterDeleteAndReupload 锁住缓存键的语义：
// 删除会删掉整行，若用自增版本号，重新上传会复现历史 URL，而那个 URL 带一年强缓存，
// 浏览器会继续显示旧图。内容哈希保证「内容不同 ⇒ URL 不同」。
func TestAvatarURLChangesAfterDeleteAndReupload(t *testing.T) {
	user := setupAvatarTestDB(t)
	router := avatarRouter(t, uint64(user.ID))
	first := encodeImage(t, "png", 24, 24)
	second := encodeImage(t, "png", 32, 32)

	if response := performAvatarUpload(router, "a.png", first); response.Code != http.StatusOK {
		t.Fatalf("upload status = %d: %s", response.Code, response.Body.String())
	}
	firstURL := loadAvatarURL(t, uint64(user.ID))

	request := httptest.NewRequest(http.MethodDelete, "/api/users/me/avatar", nil)
	router.ServeHTTP(httptest.NewRecorder(), request)

	if response := performAvatarUpload(router, "b.png", second); response.Code != http.StatusOK {
		t.Fatalf("re-upload status = %d: %s", response.Code, response.Body.String())
	}
	if secondURL := loadAvatarURL(t, uint64(user.ID)); secondURL == firstURL {
		t.Errorf("avatar URL %q was reused after delete + re-upload of different bytes", secondURL)
	}

	// 同样的字节再传一次：URL 不变，缓存复用是正确行为。
	replayURL := loadAvatarURL(t, uint64(user.ID))
	if response := performAvatarUpload(router, "b2.png", second); response.Code != http.StatusOK {
		t.Fatalf("replay status = %d: %s", response.Code, response.Body.String())
	}
	if replay := loadAvatarURL(t, uint64(user.ID)); replay != replayURL {
		t.Errorf("URL changed for identical bytes: %q -> %q", replayURL, replay)
	}
}

func loadAvatarURL(t *testing.T, userID uint64) string {
	t.Helper()
	stored, err := model.GetUserByID(userID)
	if err != nil {
		t.Fatalf("loading user %d: %v", userID, err)
	}
	return stored.AvatarURL
}

// TestGetAvatarServesStoredBytes 覆盖取图接口：类型、缓存头、ETag 与 304。
func TestGetAvatarServesStoredBytes(t *testing.T) {
	user := setupAvatarTestDB(t)
	router := avatarRouter(t, uint64(user.ID))
	imageBytes := encodeImage(t, "png", 48, 48)

	if response := performAvatarUpload(router, "avatar.png", imageBytes); response.Code != http.StatusOK {
		t.Fatalf("upload status = %d: %s", response.Code, response.Body.String())
	}

	path := loadAvatarURL(t, uint64(user.ID))
	request := httptest.NewRequest(http.MethodGet, path, nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
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
	request = httptest.NewRequest(http.MethodGet, path, nil)
	request.Header.Set("If-None-Match", etag)
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotModified {
		t.Errorf("status with If-None-Match = %d, want %d", recorder.Code, http.StatusNotModified)
	}
}

// TestGetAvatarWithoutUploadReturns404 覆盖「没上传过」与非法 id：
// 前端据此回落首字母占位，不能是 5xx。
func TestGetAvatarWithoutUploadReturns404(t *testing.T) {
	user := setupAvatarTestDB(t)
	router := avatarRouter(t, uint64(user.ID))

	for _, path := range []string{
		"/api/users/1/avatar",
		"/api/users/1/avatar?v=1",
		"/api/users/0/avatar",
		"/api/users/not-a-number/avatar",
		"/api/users/99999/avatar",
	} {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusNotFound {
			t.Errorf("GET %s = %d, want %d", path, recorder.Code, http.StatusNotFound)
		}
	}
}

// TestUploadAvatarRejectsInvalidFiles 覆盖三类拒绝：非图片（含 SVG / GIF）、
// 声明成 PNG 但内容损坏、尺寸超限。全部不得落库。
func TestUploadAvatarRejectsInvalidFiles(t *testing.T) {
	user := setupAvatarTestDB(t)
	router := avatarRouter(t, uint64(user.ID))

	cases := []struct {
		name     string
		filename string
		data     []byte
		status   int
		code     string
	}{
		{
			name:     "plain text with an image extension",
			filename: "avatar.png",
			data:     []byte("this is not an image at all"),
			status:   http.StatusBadRequest,
			code:     avatarCodeInvalidType,
		},
		{
			// SVG 是脚本载体，内联返回等于存储型 XSS，必须按类型拒掉。
			name:     "svg",
			filename: "avatar.svg",
			data:     []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`),
			status:   http.StatusBadRequest,
			code:     avatarCodeInvalidType,
		},
		{
			name:     "gif",
			filename: "avatar.gif",
			data:     []byte("GIF89a\x01\x00\x01\x00\x00\x00\x00;"),
			status:   http.StatusBadRequest,
			code:     avatarCodeInvalidType,
		},
		{
			// 头是 PNG，后面接垃圾：既能骗过嗅探，也必须被解码校验挡住。
			name:     "truncated png",
			filename: "avatar.png",
			data:     append([]byte("\x89PNG\r\n\x1a\n"), []byte("garbage")...),
			status:   http.StatusBadRequest,
			code:     avatarCodeInvalidImage,
		},
		{
			name:     "dimensions above the limit",
			filename: "huge.png",
			data:     encodeImage(t, "png", maxAvatarDimension+1, 16),
			status:   http.StatusBadRequest,
			code:     avatarCodeDimensionsTooLarge,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			response := performAvatarUpload(router, tc.filename, tc.data)
			if response.Code != tc.status {
				t.Fatalf("status = %d, want %d: %s", response.Code, tc.status, response.Body.String())
			}
			if code := decodeAvatarError(t, response); code != tc.code {
				t.Errorf("code = %q, want %q", code, tc.code)
			}
			if _, err := model.GetUserAvatar(uint64(user.ID)); err == nil {
				t.Error("rejected upload was stored anyway")
			}
		})
	}
}

// TestUploadAvatarRejectsOversizedFile 覆盖大小上限：超过 1 MiB 返回 413，
// 且不落库。用随机噪声构造，避免图片压缩把体积压小。
func TestUploadAvatarRejectsOversizedFile(t *testing.T) {
	user := setupAvatarTestDB(t)
	router := avatarRouter(t, uint64(user.ID))

	oversized := make([]byte, maxAvatarBytes+1)
	copy(oversized, encodeImage(t, "png", 8, 8))
	for i := range oversized[64:] {
		oversized[64+i] = byte(i % 251)
	}

	response := performAvatarUpload(router, "big.png", oversized)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusRequestEntityTooLarge, response.Body.String())
	}
	if code := decodeAvatarError(t, response); code != avatarCodeTooLarge {
		t.Errorf("code = %q, want %q", code, avatarCodeTooLarge)
	}
	if _, err := model.GetUserAvatar(uint64(user.ID)); err == nil {
		t.Error("oversized upload was stored anyway")
	}
}

// TestDeleteCurrentUserAvatarClearsEverything 覆盖「恢复默认」：
// 字节行与 avatar_url 都要清掉，否则界面会继续显示旧图。
func TestDeleteCurrentUserAvatarClearsEverything(t *testing.T) {
	user := setupAvatarTestDB(t)
	router := avatarRouter(t, uint64(user.ID))

	if response := performAvatarUpload(router, "avatar.png", encodeImage(t, "png", 16, 16)); response.Code != http.StatusOK {
		t.Fatalf("upload status = %d: %s", response.Code, response.Body.String())
	}

	request := httptest.NewRequest(http.MethodDelete, "/api/users/me/avatar", nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("delete status = %d, want %d: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	if _, err := model.GetUserAvatar(uint64(user.ID)); err == nil {
		t.Error("avatar row survived the delete")
	}
	stored, err := model.GetUserByID(uint64(user.ID))
	if err != nil {
		t.Fatalf("loading user: %v", err)
	}
	if stored.AvatarURL != "" {
		t.Errorf("avatar_url = %q after delete, want it cleared", stored.AvatarURL)
	}
}

// TestProfileUpdateMaintainsAvatarInvariant 覆盖不变式：avatar_url 一旦不再指向
// 上传的头像（换成外链或清空），字节行必须一起删除，不留孤儿 blob；
// 而原样提交上传路径时不能误删。
func TestProfileUpdateMaintainsAvatarInvariant(t *testing.T) {
	user := setupAvatarTestDB(t)
	router := avatarRouter(t, uint64(user.ID))

	if response := performAvatarUpload(router, "avatar.png", encodeImage(t, "png", 16, 16)); response.Code != http.StatusOK {
		t.Fatalf("upload status = %d: %s", response.Code, response.Body.String())
	}
	uploadedPath := loadAvatarURL(t, uint64(user.ID))

	// 原样提交（前端把当前值回传）不能删掉字节行。
	response := performUserRequest(router, http.MethodPut, "/api/users/me", `{"avatar_url":"`+uploadedPath+`"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusOK, response.Body.String())
	}
	if _, err := model.GetUserAvatar(uint64(user.ID)); err != nil {
		t.Fatalf("avatar row was deleted while avatar_url still points at it: %v", err)
	}

	// 换成外链：字节行删除（界面上已经看不到它了）。
	response = performUserRequest(router, http.MethodPut, "/api/users/me", `{"avatar_url":"https://example.com/a.png"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusOK, response.Body.String())
	}
	if _, err := model.GetUserAvatar(uint64(user.ID)); err == nil {
		t.Error("avatar row survived switching to an external URL")
	}

	// 清空同样要清理。
	if response := performAvatarUpload(router, "avatar.png", encodeImage(t, "png", 16, 16)); response.Code != http.StatusOK {
		t.Fatalf("upload status = %d: %s", response.Code, response.Body.String())
	}
	response = performUserRequest(router, http.MethodPut, "/api/users/me", `{"avatar_url":""}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusOK, response.Body.String())
	}
	if _, err := model.GetUserAvatar(uint64(user.ID)); err == nil {
		t.Error("avatar row survived clearing avatar_url")
	}
}

// TestAvatarPathIsNotConfusedWithOtherUsers 覆盖不变式的边界：
// 指向别人头像的路径不算「自己的上传头像」，同样要清理自己的字节行。
func TestAvatarPathIsNotConfusedWithOtherUsers(t *testing.T) {
	user := setupAvatarTestDB(t)

	if isUploadedAvatarPath(uint64(user.ID), AvatarPath(uint64(user.ID)+1, "deadbeef")) {
		t.Error("another user's avatar path was treated as this user's upload")
	}
	if !isUploadedAvatarPath(uint64(user.ID), AvatarPath(uint64(user.ID), "cafebabe")) {
		t.Error("this user's avatar path was not recognised")
	}
	if isUploadedAvatarPath(uint64(user.ID), "") {
		t.Error("empty avatar_url must not be treated as an upload")
	}
	if isUploadedAvatarPath(uint64(user.ID), "https://example.com/api/users/1/avatar") {
		t.Error("an external URL that merely looks similar must not be treated as an upload")
	}
}
