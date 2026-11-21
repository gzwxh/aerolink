package resources

import (
	"net/http"

	"github.com/gin-gonic/gin"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
)

// writeFailure 把 apiserver 的写失败翻译成**语义正确的状态码 + 机器可读码**。
//
// 之前 create / update / patch 只要失败就一律 500，于是 apiserver 明确给出的
// 「字段非法」「不可变」「已不存在」「没有权限」全被说成服务端故障（第 13 轮 D-91：
// PDB 的 minAvailable="abc"、PVC 改容量、StorageClass 改 reclaimPolicy 三条都是 500）。
// 状态码错了不只是难看：调用方（前端的重试策略、脚本、告警）没法区分
// 「重试可能有用」和「重试永远没用」。
//
// 未知错误仍然返回 500 —— 那确实是我们没预料到的服务端故障，不该伪装成 4xx。
func writeFailure(err error) (status int, code string) {
	switch {
	case apierrors.IsConflict(err):
		// 乐观并发冲突：客户端那份对象已经过期，界面据此提示「刷新后重试」。
		return http.StatusConflict, resourceVersionConflictCode
	case apierrors.IsNotFound(err):
		return http.StatusNotFound, ""
	case apierrors.IsInvalid(err):
		// 422：对象能解析，但字段值或不可变性被拒（`field is immutable`、非法枚举等）。
		return http.StatusUnprocessableEntity, ""
	case apierrors.IsBadRequest(err):
		return http.StatusBadRequest, ""
	case apierrors.IsForbidden(err):
		return http.StatusForbidden, ""
	default:
		return http.StatusInternalServerError, ""
	}
}

// respondWriteFailure 上报一次写失败：状态码与 code 由 writeFailure 决定，
// error 文本仍保留 apiserver 原文 —— K8s 的校验消息无法本地化，而运维恰恰需要原文。
func respondWriteFailure(c *gin.Context, err error) {
	status, code := writeFailure(err)
	body := gin.H{"error": err.Error()}
	if code != "" {
		body["code"] = code
	}
	c.JSON(status, body)
}
