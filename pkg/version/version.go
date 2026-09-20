package version

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

var (
	Version   = "dev"
	BuildDate = "unknown"
	CommitID  = "unknown"
)

// VersionInfo 只暴露本地构建信息。这里刻意不含「是否有新版本」：本分支不访问
// api.github.com，也不上报任何数据。
type VersionInfo struct {
	Version   string `json:"version"`
	BuildDate string `json:"buildDate"`
	CommitID  string `json:"commitId"`
}

func GetVersion(c *gin.Context) {
	c.JSON(http.StatusOK, VersionInfo{
		Version:   Version,
		BuildDate: BuildDate,
		CommitID:  CommitID,
	})
}
