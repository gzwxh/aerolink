package resources

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"k8s.io/apimachinery/pkg/api/meta"
)

// resourceTypeUnavailableCode 表示「这个集群不提供该资源类型」（CRD 未安装、
// APIService 在该版本不存在等），而不是服务端出了故障。
const resourceTypeUnavailableCode = "resource_type_unavailable"

// readFailure 把读路径的失败翻译成**语义正确的状态码 + 机器可读码**。
//
// 之前未安装的 API 类型一律回 HTTP 500（验收台账 D-114）：界面上是「服务器错误」，
// 监控里会算成平台故障，而前端只能靠正则匹配那句英文
// （`no matches for kind "X" in version "Y"`）才知道真实原因是没装。
// 与写路径的 writeFailure（D-91）同一套做法：状态码表达语义，另给机器可读码，
// **错误文本原样保留**，让旧前端与旧正则都还能工作。
func readFailure(err error) (status int, code string) {
	if meta.IsNoMatchError(err) {
		return http.StatusNotFound, resourceTypeUnavailableCode
	}
	return http.StatusInternalServerError, ""
}

// respondReadFailure 是各 handler 的收尾封装。
func respondReadFailure(c *gin.Context, err error) {
	status, code := readFailure(err)
	payload := gin.H{"error": err.Error()}
	if code != "" {
		payload["code"] = code
	}
	c.JSON(status, payload)
}
