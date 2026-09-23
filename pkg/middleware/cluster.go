package middleware

import (
	"net/http"
	"net/url"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/cluster"
)

const (
	ClusterNameHeader = "x-cluster-name"
	ClusterNameKey    = "cluster-name"
	K8sClientKey      = "k8s-client"
	PromClientKey     = "prom-client"
)

type clusterClientSetProvider interface {
	GetClientSet(string) (*cluster.ClientSet, error)
}

// DecodeClusterName 还原被 URL 编码的集群名。
//
// 前端把集群名 encodeURIComponent 后放进 x-cluster-name（HTTP 头只能带 ASCII），所以
// 任何「拿这个头去用」的地方都必须先解码：选集群（ClusterMiddleware）与写审计记录
// （pkg/middleware/audit.go）各一处。漏解一次，落库的就是 %E7%94%9F%E4%BA%A7%E7%8E%AF%E5%A2%83
// 这样的编码串——界面显示乱码，按集群名筛选也永远匹配不上。
//
// 用 PathUnescape 而不是 QueryUnescape：前者不会把集群名里的 `+` 当成空格。
// 解不开（非法转义）时原样返回，不让一条脏数据把请求拦下来。
func DecodeClusterName(value string) string {
	if value == "" {
		return ""
	}
	if decoded, err := url.PathUnescape(value); err == nil {
		return decoded
	}
	return value
}

// ClusterMiddleware 从路径、请求头或查询参数中选择集群，并把它的客户端注入上下文。
func ClusterMiddleware(cm clusterClientSetProvider) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterName := c.Param("cluster")
		if clusterName == "" {
			clusterName = c.GetHeader(ClusterNameHeader)
			if clusterName != "" {
				clusterName = DecodeClusterName(clusterName)
			} else {
				if v, ok := c.GetQuery(ClusterNameHeader); ok {
					clusterName = v
				}
			}
		}
		cluster, err := cm.GetClientSet(clusterName)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			c.Abort()
			return
		}
		c.Set("cluster", cluster)
		c.Set(ClusterNameKey, cluster.Name)
		c.Next()
	}
}
