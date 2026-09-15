package cluster

import (
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/clusteragent"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
	"github.com/zxh326/kite/pkg/rbac"
	"gorm.io/gorm"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/tools/clientcmd"
)

// clusterAgentServerURL derives the Kite server URL from the request context,
// using common.Host / X-Forwarded-Host / request host and common.Base.
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

	// Custom display info (description) lives in the DB, not in the in-memory
	// cluster snapshot. Tolerate a missing DB (unit tests) gracefully.
	descriptions := map[string]string{}
	if model.DB != nil {
		if stored, err := model.ListClusters(); err == nil {
			for _, sc := range stored {
				descriptions[sc.Name] = sc.Description
			}
		}
	}

	for name, cluster := range clusters {
		if !rbac.CanAccessCluster(user, name) {
			continue
		}
		result = append(result, common.ClusterInfo{
			Name:        name,
			Description: descriptions[name],
			Version:     cluster.Version,
			IsDefault:   name == defaultContext,
		})
	}
	for name, errMsg := range errors {
		if !rbac.CanAccessCluster(user, name) {
			continue
		}
		result = append(result, common.ClusterInfo{
			Name:        name,
			Description: descriptions[name],
			Version:     "",
			IsDefault:   false,
			Error:       errMsg,
		})
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
		clusterInfo := gin.H{
			"id":            cluster.ID,
			"name":          cluster.Name,
			"description":   cluster.Description,
			"enabled":       cluster.Enable,
			"inCluster":     cluster.InCluster,
			"clusterAgent":  cluster.ClusterAgent,
			"connected":     cluster.ClusterAgent && cm.clusterAgentManager.Connected(cluster.ID),
			"isDefault":     cluster.IsDefault,
			"prometheusURL": cluster.PrometheusURL,
			"config":        "",
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

// ListClusterNamespaces returns the namespace names of one cluster, used by the
// RBAC editor to suggest existing namespaces (admin only).
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

	var req struct {
		Name          string `json:"name"`
		Description   string `json:"description"`
		Config        string `json:"config"`
		PrometheusURL string `json:"prometheusURL"`
		InCluster     bool   `json:"inCluster"`
		IsDefault     bool   `json:"isDefault"`
		Enabled       bool   `json:"enabled"`
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

	if req.IsDefault && !cluster.IsDefault {
		if err := model.ClearDefaultCluster(); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}
	// in-cluster 类型不可通过编辑改变：它依赖 Kite 自身 Pod 的服务账号
	// 连接，没有 kubeconfig，类型一旦丢失集群将永久无法连接。
	if cluster.InCluster {
		req.InCluster = true
		req.Config = ""
	}
	if cluster.ClusterAgent {
		req.InCluster = false
		req.Config = ""
	}

	updates := map[string]interface{}{
		"description":    req.Description,
		"prometheus_url": req.PrometheusURL,
		"in_cluster":     req.InCluster,
		"is_default":     req.IsDefault,
		"enable":         req.Enabled,
	}

	if req.Name != "" && req.Name != cluster.Name {
		updates["name"] = req.Name
	}

	if req.Config != "" {
		updates["config"] = model.SecretString(req.Config)
	}

	if err := model.UpdateCluster(cluster, updates); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	TriggerClusterSync()

	c.JSON(http.StatusOK, gin.H{"message": "cluster updated successfully"})
}

// GetClusterKubeconfig returns the decrypted kubeconfig stored for a cluster
// so an administrator can review the connection details. It sits behind the
// MFA step-up gate: with the security policy on, an MFA-enrolled admin must
// re-verify a code before the credentials are released.
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

	raw, err := cluster.Config.Value()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": "failed to decrypt the stored kubeconfig: " + err.Error(),
		})
		return
	}
	plain, ok := raw.(string)
	if !ok {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "stored kubeconfig has an unexpected format"})
		return
	}
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

	if err := model.DeleteCluster(cluster); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if cluster.ClusterAgent {
		cm.clusterAgentManager.Disconnect(cluster.ID)
	}

	TriggerClusterSync()

	c.JSON(http.StatusOK, gin.H{"message": "cluster deleted successfully"})
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
	c.Header("Content-Disposition", `attachment; filename="kite-cluster-agent.yaml"`)
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
		// In-cluster config
		cluster := &model.Cluster{
			Name:        "in-cluster",
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
		// wait for sync to complete
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

	importedCount := ImportClustersFromKubeconfig(kubeconfig, cc == 0)
	TriggerClusterSync()
	// wait for sync to complete
	time.Sleep(1 * time.Second)
	c.JSON(http.StatusCreated, gin.H{
		"message":       fmt.Sprintf("imported %d clusters successfully", importedCount),
		"importedCount": importedCount,
	})
}
