package resources

import (
	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/bindinggroups"
	"github.com/zxh326/kite/pkg/cluster"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/klog/v2"
)

// NamespaceHandler 在通用处理器之上补了「新建命名空间自动归属创建者的权限」：
// 普通用户在权限范围内新建命名空间后，默认把它纳入自己已有的授权（优先归属其权限
// 绑定组，否则追加到其直接持有的受限角色），避免出现「建完自己看不见」；管理员创建的
// 命名空间不自动归属，留给管理员在权限绑定里分配。
//
// 开关：系统设置 → 通用设置 → 命名空间自动归属（general_setting.auto_bind_user_namespace）。
type NamespaceHandler struct {
	*GenericResourceHandler[*corev1.Namespace, *corev1.NamespaceList]
}

func NewNamespaceHandler() *NamespaceHandler {
	handler := &NamespaceHandler{
		GenericResourceHandler: NewGenericResourceHandler[*corev1.Namespace, *corev1.NamespaceList](common.Namespaces),
	}
	handler.afterCreate = handler.assignToCreator
	return handler
}

// assignToCreator 把刚创建的命名空间纳入创建者的授权范围，并把结论合并进创建响应
// （字段 namespaceBinding）。自动归属失败不影响创建结果：命名空间已经在集群里了，
// 界面按返回的 reason 提示「未自动归属，请联系管理员分配」。
func (h *NamespaceHandler) assignToCreator(c *gin.Context, namespace *corev1.Namespace) map[string]any {
	user, ok := c.Get("user")
	if !ok {
		return nil
	}
	userModel, ok := user.(model.User)
	if !ok {
		return nil
	}
	cs, ok := c.Get("cluster")
	if !ok {
		return nil
	}
	clientSet, ok := cs.(*cluster.ClientSet)
	if !ok {
		return nil
	}
	return autoBindCreatedNamespace(userModel, clientSet.Name, namespace.GetName())
}

// autoBindCreatedNamespace 在开关开启时执行自动归属，并给出要合并进响应的附加字段。
// 命名空间有两条创建路径（资源创建接口与 YAML apply），两边共用这段逻辑。
func autoBindCreatedNamespace(user model.User, clusterName, namespace string) map[string]any {
	setting, err := model.GetGeneralSetting()
	if err != nil {
		klog.Errorf("failed to load general setting before binding namespace %s/%s: %v",
			clusterName, namespace, err)
		return nil
	}
	if setting == nil || !setting.AutoBindUserNamespace {
		return nil
	}
	outcome := bindinggroups.AutoBindCreatedNamespace(user, clusterName, namespace)
	return map[string]any{"namespaceBinding": outcome}
}
