package middleware

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/gzwxh/aerolink/pkg/cluster"
	"github.com/gzwxh/aerolink/pkg/common"
	"github.com/gzwxh/aerolink/pkg/model"
	"github.com/gzwxh/aerolink/pkg/rbac"
)

func RBACMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		user := c.MustGet("user").(model.User)
		cs := c.MustGet("cluster").(*cluster.ClientSet)

		verbs := method2verb(c.Request.Method)
		path := c.Request.URL.EscapedPath()
		ns, resource := url2namespaceresource(path)
		if ns == "" || resource == "" {
			c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "Invalid resource URL"})
			return
		}
		if verbs == string(common.VerbGet) && resource == string(common.Events) &&
			strings.HasSuffix(c.FullPath(), "/events/resources") {
			ns = c.Query("namespace")
			if ns == "" {
				ns = common.AllNamespaces
			}
			targetResource := c.Query("resource")
			targetMeta := common.LookupResource(targetResource)
			if targetMeta != nil && targetMeta.ClusterScoped {
				ns = common.AllNamespaces
			}
			if targetMeta == nil && rbac.HasResourcePermission(user, resource, verbs, cs.Name) {
				c.Next()
				return
			}
			if rbac.CanAccess(user, resource, verbs, cs.Name, ns) {
				c.Next()
				return
			}
			c.AbortWithStatusJSON(http.StatusForbidden,
				gin.H{"error": rbac.NoAccess(user.Key(), verbs, resource, ns, cs.Name)})
			return
		}
		if resource == string(common.Namespaces) && verbs == "get" {
			name := c.Param("name")
			if name == "" && rbac.CanSeeNamespacesInCluster(user, cs.Name) {
				// 如果用户能看到该集群的任一命名空间（通过直接角色获得集群访问权限，
				// 或作为某个权限绑定组的成员），就允许访问
				// 命名空间列表这一资源
				// 这里不必担心安全问题，我们会在 list namespaces 的处理器里过滤命名空间
				// 目的只是让用户能列出自己有权访问的命名空间
				c.Next()
				return
			}
			if name != "" && rbac.CanAccessNamespace(user, cs.Name, name) {
				c.Next()
				return
			}
		}

		// 跨命名空间的 LIST / WATCH 放行。
		//
		// 当用户选择多个命名空间时，前端会把选择折叠成
		// 单个 "_all" 请求（见 use-resource-table-state）。
		// "所有命名空间"视图同样如此。按下面的 RBAC 校验，
		// 这类请求会被拒绝，除非用户某个角色带有
		// 显式的 "_all" / "*" 命名空间授权——而限定命名空间范围的
		// 角色并没有，于是即使用户被允许访问其中每个
		// 单独的命名空间，多命名空间列表（以及 SSE pod
		// watch）仍然返回 403。
		//
		// list 处理器与 pod watch 处理器会过滤每个返回 /
		// 流式推送的条目，因此只要满足以下条件，把请求放行到处理器是安全的：
		//   - 它是真正的 LIST，或者是 pods 的 /_all/watch SSE 子路由（其它
		//     子路由，例如 /:name、/describe、/history、/logs、
		//     /files、/related，仍然需要显式的 _all/* 授权）；
		//   - 已知资源是命名空间级的；动态 CR 的 LIST 请求会把范围检查
		//     交给 CR 处理器（已知的集群级资源在 rbac.CanAccess 中会跳过
		//     命名空间范围检查，因此它们
		//     会通过下面的常规校验）；
		//   - 用户在此集群中至少持有一个对该资源授予 verb 的角色
		//     （零权限用户仍会被拒绝）。
		//
		if verbs == "get" && ns == common.AllNamespaces {
			isList := isCrossNamespaceList(path)
			isWatch := resource == string(common.Pods) && isCrossNamespaceWatch(path)
			if meta := common.LookupResource(resource); (isList || isWatch) && (meta == nil || !meta.ClusterScoped) {
				if rbac.HasResourcePermission(user, resource, verbs, cs.Name) {
					c.Next()
					return
				}
			}
		}

		canAccess := rbac.CanAccess(user, resource, verbs, cs.Name, ns)
		if canAccess {
			c.Next()
		} else {
			c.AbortWithStatusJSON(http.StatusForbidden,
				gin.H{"error": rbac.NoAccess(user.Key(), verbs, resource, ns, cs.Name)})
		}
	}
}

func method2verb(method string) string {
	switch method {
	case http.MethodPost:
		return string(common.VerbCreate)
	case http.MethodPut, http.MethodPatch:
		return string(common.VerbUpdate)
	default:
		return strings.ToLower(method)
	}
}

// url2namespaceresource 把 URL 路径转换为资源类型。
// 例如：
//
// - /api/v1/pods/default/pods => default, pods
// - /api/v1/pvs/_all/some-pv => _all, some-pv
// - /api/v1/pods/default => default, pods
// - /api/v1/pods => "", pods
func url2namespaceresource(path string) (namespace string, resource string) {
	if common.Base != "" {
		path = strings.TrimPrefix(path, common.Base)
	}
	// 把 URL 拆分成各个组成部分
	parts := strings.Split(path, "/")
	resourceIndex := 3
	if len(parts) > resourceIndex && parts[resourceIndex] == "_clusters" {
		resourceIndex += 2
	}
	if len(parts) <= resourceIndex {
		return
	}
	resource, err := url.PathUnescape(parts[resourceIndex])
	if err != nil {
		return "", ""
	}
	if len(parts) > resourceIndex+1 {
		namespace, err = url.PathUnescape(parts[resourceIndex+1])
		if err != nil {
			return "", ""
		}
	} else {
		namespace = common.AllNamespaces // All namespaces
	}
	return
}

// isCrossNamespaceList 报告该 URL 是否表示一次真正的跨命名空间
// LIST 请求（即没有 :name，也没有 /describe、/history、
// /logs、/files、/related 之类的子路由）。它与
// url2namespaceresource 中的路径解析保持一致，因此调用方必须先确认 ns == common.AllNamespaces。
//
// 可接受的形式（去掉 common.Base 之后）：
//
//	/<group>/<ver>/<res>
//	/<group>/<ver>/<res>/_all
//	/<group>/<ver>/_clusters/<cluster>/<res>
//	/<group>/<ver>/_clusters/<cluster>/<res>/_all
//
// 更长的路径就是单个资源的 GET 或子路由（除 /watch 之外，
// 后者由 isCrossNamespaceWatch 处理），不算列表。
func isCrossNamespaceList(path string) bool {
	if common.Base != "" {
		path = strings.TrimPrefix(path, common.Base)
	}
	parts := strings.Split(path, "/")
	resourceIndex := 3
	if len(parts) > resourceIndex && parts[resourceIndex] == "_clusters" {
		resourceIndex += 2
	}
	if len(parts) == resourceIndex+1 {
		return true
	}
	return len(parts) == resourceIndex+2 && parts[resourceIndex+1] == common.AllNamespaces
}

// isCrossNamespaceWatch 报告该 URL 是否表示跨命名空间的
// SSE watch 子路由。目前只有 pods 资源注册了 watch
// 处理器（见 PodHandler.registerCustomRoutes）；调用方必须把
// 放行范围限制在该资源上。
//
// 可接受的形式（去掉 common.Base 之后）：
//
//	/<group>/<ver>/<res>/_all/watch
//	/<group>/<ver>/_clusters/<cluster>/<res>/_all/watch
//
// 重要：这条路由匹配到的任何 watch 处理器都必须在 ns == _all 时
// 通过完整的 rbac.CanAccess 校验过滤每一个流式事件。中间件
// 只检查用户在该资源上是否有 get 权限；逐对象过滤
// 由处理器负责（见 PodHandler.Watch）。
func isCrossNamespaceWatch(path string) bool {
	if common.Base != "" {
		path = strings.TrimPrefix(path, common.Base)
	}
	parts := strings.Split(path, "/")
	resourceIndex := 3
	if len(parts) > resourceIndex && parts[resourceIndex] == "_clusters" {
		resourceIndex += 2
	}
	return len(parts) == resourceIndex+3 &&
		parts[resourceIndex+1] == common.AllNamespaces &&
		parts[resourceIndex+2] == "watch"
}
