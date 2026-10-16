package cluster

import (
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/clusteragent"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
	"github.com/zxh326/kite/pkg/rbac"
	"gorm.io/gorm"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/klog/v2"
)

// clusterAgentServerURL 从请求上下文推导鸢联 AeroLink 服务端 URL，
// 使用 common.Host / X-Forwarded-Host / 请求 host 以及 common.Base。
func clusterAgentServerURL(c *gin.Context) string {
	scheme := "http"
	if c.Request.TLS != nil || strings.EqualFold(c.GetHeader("X-Forwarded-Proto"), "https") {
		scheme = "https"
	}
	host := strings.TrimSpace(common.Host)
	if host == "" {
		host = strings.TrimSpace(c.GetHeader("X-Forwarded-Host"))
		if host == "" {
			host = c.Request.Host
		}
	}
	if !strings.HasPrefix(host, "http://") && !strings.HasPrefix(host, "https://") {
		host = scheme + "://" + host
	}
	return fmt.Sprintf("%s%s", strings.TrimRight(host, "/"), common.Base)
}

func (cm *ClusterManager) GetClusters(c *gin.Context) {
	clusters, errors, defaultContext := cm.snapshotState()
	result := make([]common.ClusterInfo, 0, len(clusters))
	user := c.MustGet("user").(model.User)

	// 自定义展示信息（描述、徽章）保存在数据库中，而不是内存中的
	// 集群快照里。要能优雅容忍数据库缺失（单元测试）的情况。
	stored := map[string]*model.Cluster{}
	if model.DB != nil {
		if list, err := model.ListClusters(); err == nil {
			for _, sc := range list {
				stored[sc.Name] = sc
			}
		}
	}

	for name, cluster := range clusters {
		// 集群列表用于导航与切换：只靠权限绑定组授权的账号也必须能看到自己
		// 被授权所在的集群，否则切换器里没有任何可选项（数据仍逐项按命名空间过滤）。
		if !rbac.CanSeeNamespacesInCluster(user, name) {
			continue
		}
		info := common.ClusterInfo{
			Name:      name,
			Version:   cluster.Version,
			IsDefault: name == defaultContext,
		}
		applyStoredDisplayInfo(&info, stored[name])
		result = append(result, info)
	}
	for name, errMsg := range errors {
		if !rbac.CanSeeNamespacesInCluster(user, name) {
			continue
		}
		info := common.ClusterInfo{
			Name:  name,
			Error: errMsg,
		}
		applyStoredDisplayInfo(&info, stored[name])
		result = append(result, info)
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].Name < result[j].Name
	})
	c.JSON(http.StatusOK, result)
}

func (cm *ClusterManager) GetClusterList(c *gin.Context) {
	clusters, err := model.ListClusters()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	clusterState, errorState, _ := cm.snapshotState()
	result := make([]gin.H, 0, len(clusters))
	for _, cluster := range clusters {
		clusterSlug := ""
		if cluster.Slug != nil {
			clusterSlug = *cluster.Slug
		}
		clusterInfo := gin.H{
			"id":               cluster.ID,
			"name":             cluster.Name,
			"description":      cluster.Description,
			"slug":             clusterSlug,
			"enabled":          cluster.Enable,
			"inCluster":        cluster.InCluster,
			"clusterAgent":     cluster.ClusterAgent,
			"connected":        cluster.ClusterAgent && cm.clusterAgentManager.Connected(cluster.ID),
			"isDefault":        cluster.IsDefault,
			"prometheusURL":    cluster.PrometheusURL,
			"config":           "",
			"badgeEnabled":     cluster.BadgeEnabled,
			"badgeText":        cluster.BadgeText,
			"badgeColor":       cluster.BadgeColor,
			"badgeIconEnabled": cluster.BadgeIconEnabled,
			"badgeIconText":    cluster.BadgeIconText,
			"badgeIconUrl":     cluster.BadgeIconURL,
			// 写操作二次确认（见 model.Cluster 的 Confirm* 注释）：管理界面用它回填弹窗。
			"confirmCreate":          cluster.ConfirmCreate,
			"confirmUpdate":          cluster.ConfirmUpdate,
			"confirmDelete":          cluster.ConfirmDelete,
			"confirmRestart":         cluster.ConfirmRestart,
			"confirmNodeMaintenance": cluster.ConfirmNodeMaintenance,
		}
		if cluster.ClusterAgent {
			clusterInfo["clusterAgentVersion"] = cm.clusterAgentManager.Version(cluster.ID)
		}

		if clientSet, exists := clusterState[cluster.Name]; exists {
			clusterInfo["version"] = clientSet.Version
		}
		if errMsg, exists := errorState[cluster.Name]; exists {
			clusterInfo["error"] = errMsg
		}

		result = append(result, clusterInfo)
	}

	c.JSON(http.StatusOK, result)
}

// ListClusterNamespaces 返回某个集群的命名空间名称，
// 供 RBAC 编辑器提示已有命名空间（仅管理员）。
func (cm *ClusterManager) ListClusterNamespaces(c *gin.Context) {
	clusterName := strings.TrimSpace(c.Param("name"))
	if clusterName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cluster name is required"})
		return
	}
	cs, err := cm.GetClientSet(clusterName)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	ctx := c.Request.Context()
	nsList, err := cs.K8sClient.ClientSet.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("failed to list namespaces: %v", err)})
		return
	}
	names := make([]string, 0, len(nsList.Items))
	for _, ns := range nsList.Items {
		names = append(names, ns.Name)
	}
	sort.Strings(names)
	c.JSON(http.StatusOK, gin.H{"namespaces": names})
}

func (cm *ClusterManager) CreateCluster(c *gin.Context) {
	if common.IsSectionManaged("clusters") {
		c.JSON(http.StatusForbidden, gin.H{"error": common.ManagedSectionError})
		return
	}

	var req struct {
		Name          string `json:"name" binding:"required"`
		Description   string `json:"description"`
		Slug          string `json:"slug"`
		Config        string `json:"config"`
		PrometheusURL string `json:"prometheusURL"`
		InCluster     bool   `json:"inCluster"`
		ClusterAgent  bool   `json:"clusterAgent"`
		IsDefault     bool   `json:"isDefault"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.ClusterAgent {
		req.InCluster = false
		req.Config = ""
	}

	if _, err := model.GetClusterByName(req.Name); err == nil {
		c.JSON(http.StatusConflict, gin.H{"error": "cluster already exists"})
		return
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// URL 短名：留空走自动生成（重名自动加后缀）；手填值非法/冲突一律显式报错，
	// 不静默改写——值是人指定的，静默改写会让人以为生效的是别的值。
	clusterSlug := strings.TrimSpace(req.Slug)
	if clusterSlug != "" {
		if err := ValidateSlugFormat(clusterSlug); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if _, err := model.GetClusterBySlug(clusterSlug); err == nil {
			c.JSON(http.StatusConflict, gin.H{"error": "slug already exists"})
			return
		} else if !errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	} else {
		existing, err := model.ListClusters()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		taken := make(map[string]bool, len(existing))
		for _, ec := range existing {
			if ec.Slug != nil && *ec.Slug != "" {
				taken[*ec.Slug] = true
			}
		}
		clusterSlug = GenerateUniqueSlug(req.Name, taken)
	}

	if req.IsDefault {
		if err := model.ClearDefaultCluster(); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}

	var clusterAgentToken string
	var clusterAgentTokenHash string
	var clusterAgentPublicKey string
	var clusterAgentPrivateKey string
	var clusterAgentManifestGrant string
	if req.ClusterAgent {
		var err error
		clusterAgentToken, clusterAgentTokenHash, err = clusteragent.NewToken()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		clusterAgentPublicKey, clusterAgentPrivateKey, err = clusteragent.NewRegistrationKeyPair()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		clusterAgentManifestGrant, err = cm.clusterAgentManager.CreateManifestGrant(clusterAgentToken)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}

	cluster := &model.Cluster{
		Name:                   req.Name,
		Description:            req.Description,
		Slug:                   &clusterSlug,
		Config:                 model.SecretString(req.Config),
		PrometheusURL:          req.PrometheusURL,
		InCluster:              req.InCluster,
		ClusterAgent:           req.ClusterAgent,
		ClusterAgentTokenHash:  clusterAgentTokenHash,
		ClusterAgentPublicKey:  clusterAgentPublicKey,
		ClusterAgentPrivateKey: model.SecretString(clusterAgentPrivateKey),
		IsDefault:              req.IsDefault,
		Enable:                 true,
	}

	if err := model.AddCluster(cluster); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// 新建的集群要立刻有内置授权（超级管理员的超级权限绑定），否则管理员页签在
	// 下次重启前会一直提示缺少该组。
	ensureClusterAuthorizations(cluster.Name)

	TriggerClusterSync()

	result := gin.H{
		"id":      cluster.ID,
		"message": "cluster created successfully",
	}
	if req.ClusterAgent {
		serverURL := clusterAgentServerURL(c)
		result["clusterAgentServer"] = serverURL
		result["clusterAgentToken"] = clusterAgentToken
		result["clusterAgentPublicKey"] = clusterAgentPublicKey
		result["clusterAgentManifestURL"] = fmt.Sprintf("%s/api/v1/cluster-agent/manifest?grant=%s", strings.TrimRight(serverURL, "/"), clusterAgentManifestGrant)
	}
	c.JSON(http.StatusCreated, result)
}

// applyStoredDisplayInfo 把数据库里保存的展示信息（描述、徽章、图标）填进下发的
// 集群信息。stored 为 nil 表示库里没有这个集群（或数据库不可用），保持零值。
//
// 徽章只在启用时下发：这个接口是给切换器/顶栏取展示数据的，未启用的徽章
// 连文案和颜色都不该出现在响应里；管理员编辑用的集群列表接口会返回原始字段，
// 见 GetClusterList。
//
// 图标不跟着徽章开关走：只换图标、不显示说明的集群也要能拿到自己的图标，
// 否则在界面上设置了图标却看不到任何变化。
func applyStoredDisplayInfo(info *common.ClusterInfo, stored *model.Cluster) {
	if stored == nil {
		return
	}
	info.Description = stored.Description
	// Slug：前端导航靠它把 /_clusters/<slug> 对应到集群；迁移回填保证非空，
	// 但库里理论上还可能有未回填的旧数据（nil），不下发即回落到兜底重定向。
	if stored.Slug != nil {
		info.Slug = *stored.Slug
	}
	if stored.BadgeEnabled {
		info.BadgeEnabled = true
		info.BadgeText = stored.BadgeText
		info.BadgeColor = stored.BadgeColor
	}
	if stored.BadgeIconEnabled {
		info.BadgeIconEnabled = true
		info.BadgeIconText = stored.BadgeIconText
		info.BadgeIconURL = stored.BadgeIconURL
	}
	// 写操作二次确认开关：前端提交 k8s 写请求前要据此决定是否弹确认框，
	// 而它拿到的就是这份集群列表（见 ui/src/lib/current-cluster.ts）。
	info.ConfirmCreate = stored.ConfirmCreate
	info.ConfirmUpdate = stored.ConfirmUpdate
	info.ConfirmDelete = stored.ConfirmDelete
	info.ConfirmRestart = stored.ConfirmRestart
	info.ConfirmNodeMaintenance = stored.ConfirmNodeMaintenance
}

// badgeColorPattern 只放行严格的 #RRGGBB。徽章颜色会进前端的内联样式，
// 放宽成任意字符串等于把样式注入面交出去。
var badgeColorPattern = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

const (
	// maxBadgeTextRunes 是「自定义说明」的长度上限，按字符数计。收在 16 是因为界面上
	// 徽章按整段展示、不截断（见 ui/src/components/cluster-badge.tsx），再长就会把
	// 「当前集群」标签和集群管理列表的名称列撑变形。
	maxBadgeTextRunes = 16
	// maxBadgeIconTextRunes 是图标文本的长度上限，按字符数计。图标位只有十几像素高，
	// 再长就会挤垮旁边的集群名，所以按「最多 6 个汉字」收紧（列宽留余量，见 model.Cluster）。
	maxBadgeIconTextRunes = 6
)

// validateClusterBadge 校验徽章字段，超限一律报错而不是静默截断。
// 启用徽章时说明文案必填——只有颜色没有文本，渲染出来就是一个空色块。
func validateClusterBadge(badge model.Cluster) error {
	if badge.BadgeEnabled && badge.BadgeText == "" {
		return errors.New("badgeText is required when the badge is enabled")
	}
	if utf8.RuneCountInString(badge.BadgeText) > maxBadgeTextRunes {
		return fmt.Errorf("badgeText must be at most %d characters", maxBadgeTextRunes)
	}
	if badge.BadgeColor != "" && !badgeColorPattern.MatchString(badge.BadgeColor) {
		return errors.New("badgeColor must be a hex color such as #0011ff")
	}
	if utf8.RuneCountInString(badge.BadgeIconText) > maxBadgeIconTextRunes {
		return fmt.Errorf("badgeIconText must be at most %d characters", maxBadgeIconTextRunes)
	}
	return nil
}

// UpdateCluster 更新集群信息（徽章部分更新、字段校验与集群重载都在这里）。
//
// 为什么不做成多个小函数：那需要额外传递「哪些字段被显式设置」的中间状态，比集中在一处更难对照。
//
//nolint:gocyclo // 这是一条「逐字段判断哪些改了」的直线流程，拆成多个函数反而要额外传递
func (cm *ClusterManager) UpdateCluster(c *gin.Context) {
	if common.IsSectionManaged("clusters") {
		c.JSON(http.StatusForbidden, gin.H{"error": common.ManagedSectionError})
		return
	}

	idStr := c.Param("id")
	id, err := strconv.ParseUint(idStr, 10, 32)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid cluster id"})
		return
	}

	// 可选字段一律用指针：请求里没给的字段不能被当成「显式设为零值」。
	// 以前这里是非指针 bool，任何只改部分字段的请求（例如只改描述）都会把
	// in_cluster / is_default / enabled 按 false 写回——静默停用集群、清掉默认集群标记。
	//
	// 这里刻意不接收 badgeIconUrl：它只能由上传/删除图标的接口维护，否则会与
	// 「有字节行 ⇔ URL 指向它」的不变式脱钩（见 cluster_badge_icon.go）。
	var req struct {
		Name          *string `json:"name"`
		Description   *string `json:"description"`
		Config        *string `json:"config"`
		PrometheusURL *string `json:"prometheusURL"`
		InCluster     *bool   `json:"inCluster"`
		IsDefault     *bool   `json:"isDefault"`
		Enabled       *bool   `json:"enabled"`
		// 集群徽章，见 validateClusterBadge。
		BadgeEnabled     *bool   `json:"badgeEnabled"`
		BadgeText        *string `json:"badgeText"`
		BadgeColor       *string `json:"badgeColor"`
		BadgeIconEnabled *bool   `json:"badgeIconEnabled"`
		BadgeIconText    *string `json:"badgeIconText"`
		// 写操作二次确认开关，见 model.Cluster 的 Confirm* 注释。
		ConfirmCreate          *bool `json:"confirmCreate"`
		ConfirmUpdate          *bool `json:"confirmUpdate"`
		ConfirmDelete          *bool `json:"confirmDelete"`
		ConfirmRestart         *bool `json:"confirmRestart"`
		ConfirmNodeMaintenance *bool `json:"confirmNodeMaintenance"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	cluster, err := model.GetClusterByID(uint(id))
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "cluster not found"})
		} else {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		}
		return
	}

	if req.IsDefault != nil && *req.IsDefault && !cluster.IsDefault {
		if err := model.ClearDefaultCluster(); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}
	// 徽章按「本次请求之后的最终状态」校验：只改颜色或只打开开关的请求，
	// 也要拿库里的旧值补齐后再判断文本是否为空。
	nextBadge := model.Cluster{
		BadgeEnabled:     cluster.BadgeEnabled,
		BadgeText:        cluster.BadgeText,
		BadgeColor:       cluster.BadgeColor,
		BadgeIconEnabled: cluster.BadgeIconEnabled,
		BadgeIconText:    cluster.BadgeIconText,
	}
	if req.BadgeEnabled != nil {
		nextBadge.BadgeEnabled = *req.BadgeEnabled
	}
	if req.BadgeText != nil {
		nextBadge.BadgeText = strings.TrimSpace(*req.BadgeText)
	}
	if req.BadgeColor != nil {
		nextBadge.BadgeColor = strings.TrimSpace(*req.BadgeColor)
	}
	if req.BadgeIconEnabled != nil {
		nextBadge.BadgeIconEnabled = *req.BadgeIconEnabled
	}
	if req.BadgeIconText != nil {
		nextBadge.BadgeIconText = strings.TrimSpace(*req.BadgeIconText)
	}
	if err := validateClusterBadge(nextBadge); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	updates := map[string]interface{}{}
	if req.Description != nil {
		updates["description"] = *req.Description
	}
	if req.BadgeEnabled != nil {
		updates["badge_enabled"] = nextBadge.BadgeEnabled
	}
	if req.BadgeText != nil {
		updates["badge_text"] = nextBadge.BadgeText
	}
	if req.BadgeColor != nil {
		updates["badge_color"] = nextBadge.BadgeColor
	}
	if req.BadgeIconEnabled != nil {
		updates["badge_icon_enabled"] = nextBadge.BadgeIconEnabled
	}
	if req.BadgeIconText != nil {
		updates["badge_icon_text"] = nextBadge.BadgeIconText
	}
	if req.PrometheusURL != nil {
		updates["prometheus_url"] = *req.PrometheusURL
	}
	if req.InCluster != nil {
		updates["in_cluster"] = *req.InCluster
	}
	if req.IsDefault != nil {
		updates["is_default"] = *req.IsDefault
	}
	if req.Enabled != nil {
		updates["enable"] = *req.Enabled
	}
	if req.ConfirmCreate != nil {
		updates["confirm_create"] = *req.ConfirmCreate
	}
	if req.ConfirmUpdate != nil {
		updates["confirm_update"] = *req.ConfirmUpdate
	}
	if req.ConfirmDelete != nil {
		updates["confirm_delete"] = *req.ConfirmDelete
	}
	if req.ConfirmRestart != nil {
		updates["confirm_restart"] = *req.ConfirmRestart
	}
	if req.ConfirmNodeMaintenance != nil {
		updates["confirm_node_maintenance"] = *req.ConfirmNodeMaintenance
	}

	if req.Name != nil && *req.Name != "" && *req.Name != cluster.Name {
		updates["name"] = *req.Name
	}

	if req.Config != nil && *req.Config != "" {
		updates["config"] = model.SecretString(*req.Config)
	}

	// in-cluster 类型不可通过编辑改变：它依赖鸢联 AeroLink 自身 Pod 的服务账号
	// 连接，没有 kubeconfig，类型一旦丢失集群将永久无法连接。
	if cluster.InCluster {
		updates["in_cluster"] = true
		delete(updates, "config")
	}
	if cluster.ClusterAgent {
		updates["in_cluster"] = false
		delete(updates, "config")
	}

	if err := model.UpdateCluster(cluster, updates); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	TriggerClusterSync()

	c.JSON(http.StatusOK, gin.H{"message": "cluster updated successfully"})
}

// GetClusterKubeconfig 返回某个集群已存储、解密后的 kubeconfig，
// 便于管理员查看连接信息。它位于
// MFA 二次验证关卡之后：安全策略开启时，已注册 MFA 的管理员
// 必须重新验证一次验证码才能取出凭据。
//
// 路由：GET /api/v1/admin/clusters/:id/kubeconfig。
func (cm *ClusterManager) GetClusterKubeconfig(c *gin.Context) {
	if common.IsSectionManaged("clusters") {
		c.JSON(http.StatusForbidden, gin.H{"error": common.ManagedSectionError})
		return
	}

	// 路由参数为集群名（GET 路由树中已有 /:name/... 通配，gin 不允许同一
	// 位置出现不同参数名），因此这里按 name 查询而不是 id。
	name := c.Param("name")
	if strings.TrimSpace(name) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid cluster name"})
		return
	}

	cluster, err := model.GetClusterByName(name)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "cluster not found"})
		} else {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		}
		return
	}

	switch {
	case cluster.InCluster:
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "the in-cluster connection uses the pod service account and has no stored kubeconfig",
		})
		return
	case cluster.ClusterAgent:
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "agent-managed clusters connect through the cluster agent and have no stored kubeconfig",
		})
		return
	}

	// cluster.Config 读出来时已经由 SecretString.Scan 解开，这里直接用字符串即可。
	// 原来调的是 Value()——那是**加密**方法（写库时才用），会把明文再加密一次返回，
	// 于是「查看当前配置」永远只给出一串 base64；而错误信息写的是 "failed to decrypt"，
	// 可见是加密/解密用反了。
	plain := string(cluster.Config)
	if strings.TrimSpace(plain) == "" {
		c.JSON(http.StatusNotFound, gin.H{"error": "no kubeconfig stored for this cluster"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"config": plain})
}

func (cm *ClusterManager) DeleteCluster(c *gin.Context) {
	if common.IsSectionManaged("clusters") {
		c.JSON(http.StatusForbidden, gin.H{"error": common.ManagedSectionError})
		return
	}

	idStr := c.Param("id")
	id, err := strconv.ParseUint(idStr, 10, 32)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid cluster id"})
		return
	}

	cluster, err := model.GetClusterByID(uint(id))
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "cluster not found"})
		} else {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		}
		return
	}

	if cluster.IsDefault {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cannot delete default cluster"})
		return
	}

	// 集群名与它的配置快照（kubeconfig 是凭据，见 clusterAuditSnapshot）。
	c.Set(common.AdminAuditDetailKey, common.AdminAuditDetail{
		ResourceName: cluster.Name,
		PreviousYAML: clusterAuditSnapshot(*cluster),
	})

	// 集群是权限隔离的第一层：删除集群时权限绑定组必须显式选择处理方式。
	// ?bindingGroups=delete 连同权限绑定组一起删除；默认保留（detached），
	// 保留的权限绑定组不再参与授权，集群重新导入后可在权限管理页重新绑定。
	deleteBindingGroups := strings.EqualFold(c.Query("bindingGroups"), "delete")

	bindingGroupTotal, err := model.CountBindingGroupsByCluster(cluster.Name)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	if err := model.DeleteCluster(cluster); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if cluster.ClusterAgent {
		cm.clusterAgentManager.Disconnect(cluster.ID)
	}

	bindingGroupsDeleted := int64(0)
	bindingGroupsRetained := int64(0)
	if bindingGroupTotal > 0 {
		if deleteBindingGroups {
			bindingGroupsDeleted, err = model.DeleteBindingGroupsByCluster(cluster.Name)
		} else {
			bindingGroupsRetained, err = model.RetainBindingGroupsByCluster(cluster.Name)
		}
		if err != nil {
			klog.Errorf("cluster %s deleted but failed to handle binding groups: %v",
				cluster.Name, err)
		}
		rbac.TriggerSync()
	}

	TriggerClusterSync()

	c.JSON(http.StatusOK, gin.H{
		"message":               "cluster deleted successfully",
		"bindingGroupTotal":     bindingGroupTotal,
		"bindingGroupsDeleted":  bindingGroupsDeleted,
		"bindingGroupsRetained": bindingGroupsRetained,
	})
}

// clusterAuditSnapshot 返回集群的审计快照。Config 是 kubeconfig（凭据），必须排除；
// 其余字段（名称、描述、Prometheus 地址、徽章、集群代理开关）正是排查「谁删了哪个集群」
// 时要看的信息。集群代理的密钥字段带 `json:"-"`，不会进快照。
func clusterAuditSnapshot(cluster model.Cluster) string {
	cluster.Config = ""
	return common.AdminAuditSnapshot(cluster)
}

func (cm *ClusterManager) ConnectClusterAgent(c *gin.Context) {
	cm.clusterAgentManager.ServeHTTP(c.Writer, c.Request)
}

func (cm *ClusterManager) RegisterClusterAgent(c *gin.Context) {
	cm.clusterAgentManager.Register(c.Writer, c.Request)
}

func (cm *ClusterManager) GetClusterAgentManifest(c *gin.Context) {
	grant := strings.TrimSpace(c.Query("grant"))
	token, err := cm.clusterAgentManager.ResolveManifestGrant(grant)
	if errors.Is(err, clusteragent.ErrInvalidManifestGrant) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid or expired manifest grant"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to validate manifest grant"})
		return
	}
	if token == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid or expired manifest grant"})
		return
	}
	publicKey, err := cm.clusterAgentManager.RegistrationPublicKey(token)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load cluster agent registration key"})
		return
	}
	if publicKey == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid or expired manifest grant"})
		return
	}
	serverURL := clusterAgentServerURL(c)
	image := model.DefaultGeneralClusterAgentImageValue()
	if setting, err := model.GetGeneralSetting(); err == nil && setting != nil && setting.ClusterAgentImage != "" {
		image = setting.ClusterAgentImage
	}
	manifest := clusteragent.GenerateManifest(serverURL, token, publicKey, image)
	c.Header("Cache-Control", "no-store")
	c.Header("Content-Disposition", `attachment; filename="aerolink-cluster-agent.yaml"`)
	c.Data(http.StatusOK, "text/yaml; charset=utf-8", []byte(manifest))
}

func (cm *ClusterManager) ImportClustersFromKubeconfig(c *gin.Context) {
	if common.IsSectionManaged("clusters") {
		c.JSON(http.StatusForbidden, gin.H{"error": common.ManagedSectionError})
		return
	}

	var clusterReq common.ImportClustersRequest
	if err := c.ShouldBindJSON(&clusterReq); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if !clusterReq.InCluster && clusterReq.Config == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "config is required when inCluster is false"})
		return
	}

	cc, err := model.CountClusters()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if clusterReq.InCluster && cc > 0 {
		c.JSON(http.StatusForbidden, gin.H{"error": "in-cluster import not allowed when clusters exist"})
		return
	}

	if clusterReq.InCluster {
		// 集群内配置
		inClusterSlug := common.SlugifyClusterName("in-cluster")
		cluster := &model.Cluster{
			Name:        "in-cluster",
			Slug:        &inClusterSlug,
			InCluster:   true,
			Description: "Kubernetes in-cluster config",
			IsDefault:   true,
			Enable:      true,
		}
		if err := model.AddCluster(cluster); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		TriggerClusterSync()
		// 等待同步完成
		time.Sleep(1 * time.Second)
		c.JSON(http.StatusCreated, gin.H{
			"message":       fmt.Sprintf("imported %d clusters successfully", 1),
			"importedCount": 1,
		})
		return
	}

	kubeconfig, err := clientcmd.Load([]byte(clusterReq.Config))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	importedCount, err := ImportClustersFromKubeconfig(kubeconfig, cc == 0, clusterReq.Slugs)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	TriggerClusterSync()
	// 等待同步完成
	time.Sleep(1 * time.Second)
	c.JSON(http.StatusCreated, gin.H{
		"message":       fmt.Sprintf("imported %d clusters successfully", importedCount),
		"importedCount": importedCount,
	})
}
