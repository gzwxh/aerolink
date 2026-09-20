package version

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestGetVersion(t *testing.T) {
	gin.SetMode(gin.TestMode)

	origVersion := Version
	origBuildDate := BuildDate
	origCommitID := CommitID
	t.Cleanup(func() {
		Version = origVersion
		BuildDate = origBuildDate
		CommitID = origCommitID
	})

	Version = "1.2.3"
	BuildDate = "2026-03-27"
	CommitID = "abc123"

	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest("GET", "/version", nil)

	GetVersion(c)

	if recorder.Code != 200 {
		t.Fatalf("unexpected status code: %d", recorder.Code)
	}

	var got VersionInfo
	if err := json.Unmarshal(recorder.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if got.Version != "1.2.3" || got.BuildDate != "2026-03-27" || got.CommitID != "abc123" {
		t.Fatalf("unexpected version info: %#v", got)
	}

	// 响应里不该再有「是否有新版本」这类字段：本分支不查询上游发布。
	if body := recorder.Body.String(); strings.Contains(body, "hasNewVersion") || strings.Contains(body, "releaseUrl") {
		t.Fatalf("response must not expose update fields: %s", body)
	}
}
