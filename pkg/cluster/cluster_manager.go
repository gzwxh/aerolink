package cluster

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/zxh326/kite/pkg/clusteragent"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/kube"
	"github.com/zxh326/kite/pkg/model"
	"github.com/zxh326/kite/pkg/prometheus"
	"gorm.io/gorm"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
	"k8s.io/klog/v2"
)

type ClientSet struct {
	Name       string
	Version    string // Kubernetes version
	K8sClient  *kube.K8sClient
	PromClient *prometheus.Client

	DiscoveredPrometheusURL string
	config                  string
	prometheusURL           string
	clusterAgentGeneration  uint64

	// 集群 DNS 域缓存（见 DNSDomain）：coredns 配置极少变动，按 TTL 缓存，
	// 不给 /clusters 列表接口增加常态 apiserver 压力。
	dnsMu       sync.Mutex
	dnsDomain   string
	dnsDomainAt time.Time
}

// DefaultClusterDNSDomain 是 kubelet 的默认集群 DNS 服务域。
const DefaultClusterDNSDomain = "cluster.local"

// dnsDomainCacheTTL 是集群 DNS 域的缓存时长：coredns 配置极少变动。
const dnsDomainCacheTTL = 10 * time.Minute

// dnsDomainConfigMapCandidates 是 coredns 配置可能所在的 ConfigMap
// （kubeadm / k3s 用 coredns，RKE2 用 rke2-coredns）。
var dnsDomainConfigMapCandidates = []types.NamespacedName{
	{Namespace: "kube-system", Name: "coredns"},
	{Namespace: "kube-system", Name: "rke2-coredns"},
}

// DNSDomain 返回该集群的 DNS 服务域。
//
// 域名从 coredns 的 Corefile 解析（kubernetes 插件的第一个正向 zone）；读不到
// 配置（非标准发行版、coredns 未装）时回落 cluster.local，与旧行为一致。
// 结果按 TTL 缓存：/clusters 列表每次都带这个字段，不能每次都访问 apiserver。
func (cs *ClientSet) DNSDomain(ctx context.Context) string {
	if cs == nil {
		return DefaultClusterDNSDomain
	}
	cs.dnsMu.Lock()
	defer cs.dnsMu.Unlock()
	if cs.dnsDomain != "" && time.Since(cs.dnsDomainAt) < dnsDomainCacheTTL {
		return cs.dnsDomain
	}

	domain := cs.readDNSDomain(ctx)
	cs.dnsDomain = domain
	cs.dnsDomainAt = time.Now()
	return domain
}

// readDNSDomain 逐个尝试候选 ConfigMap；读不到或解析不出时回落默认域。
func (cs *ClientSet) readDNSDomain(ctx context.Context) string {
	if cs.K8sClient == nil {
		return DefaultClusterDNSDomain
	}
	// 直连客户端：informer 缓存会按需启动 informer，为读一次配置而 watch 全量
	// ConfigMap 得不偿失；直连一次 Get 即可。
	readClient := cs.K8sClient.DirectClient
	if readClient == nil {
		readClient = cs.K8sClient.Client
	}
	for _, key := range dnsDomainConfigMapCandidates {
		var configMap corev1.ConfigMap
		if err := readClient.Get(ctx, key, &configMap); err != nil {
			continue
		}
		if domain := dnsDomainFromCorefile(configMap.Data["Corefile"]); domain != "" {
			return domain
		}
	}
	return DefaultClusterDNSDomain
}

// dnsDomainFromCorefile 从 Corefile 解析 kubernetes 插件的第一个正向 zone。
//
// 典型插件行：`    kubernetes cluster.local in-addr.arpa ip6.arpa {` —— 取插件名
// 后第一个非反向域参数。解析不出返回空串，由调用方回落默认值。
func dnsDomainFromCorefile(corefile string) string {
	for _, line := range strings.Split(corefile, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 || fields[0] != "kubernetes" {
			continue
		}
		for _, token := range fields[1:] {
			if token == "{" || strings.HasSuffix(token, ".arpa") {
				continue
			}
			return strings.TrimSuffix(token, ".")
		}
	}
	return ""
}

type ClusterManager struct {
	mu                  sync.RWMutex
	syncMu              sync.Mutex
	clusters            map[string]*ClientSet
	errors              map[string]string
	defaultContext      string
	clusterAgentManager *clusteragent.Manager
}

// Health 返回该集群的 API 可用性记录（客户端尚未建好时返回 nil）。
func (cs *ClientSet) Health() *kube.Health {
	if cs == nil || cs.K8sClient == nil {
		return nil
	}
	return cs.K8sClient.Health()
}

// SnapshotHealth 返回该集群在 now 时刻的健康快照；客户端尚未建好时返回「陈旧」，
// 因为此时平台根本拿不到它的数据。
func (cs *ClientSet) SnapshotHealth(now time.Time) kube.ClusterHealth {
	if h := cs.Health(); h != nil {
		return h.Snapshot(now, clusterStaleAfter())
	}
	return kube.ClusterHealth{Stale: true, Reason: kube.StaleReasonUnreachable}
}

const clusterStartupSyncTimeout = 10 * time.Second

// 集群 API 探活默认参数：每 15 秒探一轮，距最后一次成功访问超过 45 秒即判「数据可能陈旧」
// （3× 间隔，容忍两轮探活抖动）。分别由 AEROLINK_CLUSTER_PROBE_INTERVAL /
// AEROLINK_CLUSTER_STALE_AFTER 覆盖，设为 0 表示关闭该判定。
const (
	defaultClusterProbeInterval = 15 * time.Second
	defaultClusterStaleAfter    = 45 * time.Second
	clusterProbeTimeout         = 3 * time.Second
)

func envSeconds(name string, fallback time.Duration) time.Duration {
	v := common.Getenv(name)
	if v == "" {
		return fallback
	}
	secs, err := strconv.Atoi(v)
	if err != nil || secs < 0 {
		klog.Warningf("invalid %s%s=%q, using default %s", common.EnvPrefix, name, v, fallback)
		return fallback
	}
	return time.Duration(secs) * time.Second
}

// ClusterProbeInterval 返回主动探活间隔；0 表示关闭探活。
func ClusterProbeInterval() time.Duration {
	return envSeconds("CLUSTER_PROBE_INTERVAL", defaultClusterProbeInterval)
}

// clusterStaleAfter 返回陈旧判定阈值；0 表示关闭基于时间的判定。
func clusterStaleAfter() time.Duration {
	return envSeconds("CLUSTER_STALE_AFTER", defaultClusterStaleAfter)
}

func createClientSetInCluster(name, prometheusURL string) (*ClientSet, error) {
	config, err := rest.InClusterConfig()
	if err != nil {
		return nil, err
	}

	return newClientSet(name, config, prometheusURL)
}

func createClientSetFromConfig(name, content, prometheusURL string) (*ClientSet, error) {
	restConfig, err := clientcmd.RESTConfigFromKubeConfig([]byte(content))
	if err != nil {
		klog.Warningf("Failed to create REST config for cluster %s: %v", name, err)
		return nil, err
	}
	cs, err := newClientSet(name, restConfig, prometheusURL)
	if err != nil {
		return nil, err
	}
	cs.config = content

	return cs, nil
}

func newClientSet(name string, k8sConfig *rest.Config, prometheusURL string) (*ClientSet, error) {
	cs := &ClientSet{
		Name:          name,
		prometheusURL: prometheusURL,
	}
	var err error
	cs.K8sClient, err = kube.NewClient(k8sConfig)
	if err != nil {
		klog.Warningf("Failed to create k8s client for cluster %s: %v", name, err)
		return nil, err
	}
	if prometheusURL == "" {
		prometheusURL = discoveryPrometheusURL(cs.K8sClient)
		if prometheusURL != "" {
			cs.DiscoveredPrometheusURL = prometheusURL
			klog.Infof("Discovered Prometheus URL for cluster %s: %s", name, cs.DiscoveredPrometheusURL)
		}
	}
	if prometheusURL != "" {
		var rt = http.DefaultTransport
		var err error
		if isClusterLocalURL(prometheusURL) {
			rt, err = createK8sProxyTransport(k8sConfig, prometheusURL)
			if err != nil {
				klog.Warningf("Failed to create k8s proxy transport for cluster %s: %v, using direct connection", name, err)
			} else {
				klog.Infof("Using k8s API proxy for Prometheus in cluster %s", name)
			}
		} else if k8sConfig.Dial != nil {
			transport := http.DefaultTransport.(*http.Transport).Clone()
			transport.Proxy = nil
			transport.DialContext = k8sConfig.Dial
			rt = transport
			klog.Infof("Using cluster agent TCP proxy for Prometheus in cluster %s", name)
		}
		cs.PromClient, err = prometheus.NewClientWithRoundTripper(prometheusURL, rt)
		if err != nil {
			klog.Warningf("Failed to create Prometheus client for cluster %s, some features may not work as expected, err: %v", name, err)
		}
	}
	v, err := cs.K8sClient.ClientSet.Discovery().ServerVersion()
	if err != nil {
		klog.Warningf("Failed to get server version for cluster %s: %v", name, err)
		cs.K8sClient.Health().RecordProbeError(err)
	} else {
		cs.Version = v.String()
		// 建客户端时已经打通过 apiserver（缓存模式还通过了缓存同步），
		// 把它记成一次成功探活，免得新建的集群在首轮探活前被误判陈旧。
		cs.K8sClient.Health().RecordProbeOK(time.Now())
	}
	klog.Infof("Loaded K8s client for cluster: %s, version: %s", name, cs.Version)
	return cs, nil
}

func isClusterLocalURL(urlStr string) bool {
	return strings.Contains(urlStr, ".svc.cluster.local") || strings.Contains(urlStr, ".svc:")
}

func createK8sProxyTransport(k8sConfig *rest.Config, prometheusURL string) (*k8sProxyTransport, error) {
	parsedURL, err := url.Parse(prometheusURL)
	if err != nil {
		return nil, err
	}

	parts := strings.Split(parsedURL.Host, ".")
	if len(parts) < 2 {
		return nil, fmt.Errorf("invalid cluster local URL format")
	}
	svcName := parts[0]
	namespace := parts[1]

	transport, err := rest.TransportFor(k8sConfig)
	if err != nil {
		return nil, err
	}

	transportWrapper := &k8sProxyTransport{
		transport:    transport,
		apiServerURL: k8sConfig.Host,
		namespace:    namespace,
		svcName:      svcName,
		scheme:       parsedURL.Scheme,
	}
	transportWrapper.port = parsedURL.Port()
	if transportWrapper.port == "" {
		if parsedURL.Scheme == "https" {
			transportWrapper.port = "443"
		} else {
			transportWrapper.port = "80"
		}
	}

	return transportWrapper, nil
}

type k8sProxyTransport struct {
	transport    http.RoundTripper
	apiServerURL string
	namespace    string
	svcName      string
	scheme       string
	port         string
}

func (t *k8sProxyTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	proxyURL, err := url.Parse(t.apiServerURL)
	if err != nil {
		return nil, err
	}
	req.URL.Scheme = proxyURL.Scheme
	req.URL.Host = proxyURL.Host

	servicePath := fmt.Sprintf("/api/v1/namespaces/%s/services/%s:%s/proxy", t.namespace, t.svcName, t.port)
	req.URL.Path = servicePath + req.URL.Path

	return t.transport.RoundTrip(req)
}

func (cm *ClusterManager) GetClientSet(clusterName string) (*ClientSet, error) {
	cm.mu.RLock()
	defer cm.mu.RUnlock()

	if len(cm.clusters) == 0 {
		return nil, fmt.Errorf("no clusters available")
	}
	if clusterName == "" {
		clusterName = cm.defaultContext
		if clusterName == "" {
			// 如果未设置默认 context，则返回第一个可用的集群
			for _, cs := range cm.clusters {
				return cs, nil
			}
		}
	}
	if cluster, ok := cm.clusters[clusterName]; ok {
		return cluster, nil
	}
	return nil, fmt.Errorf("cluster not found: %s", clusterName)
}

// ImportClustersFromKubeconfig 把 kubeconfig 的每个 context 导入为集群。
// slugs（key = context name）承载逐行手填的 URL 短名；未指定的 context 自动生成。
// 校验 fail-closed：任一短名非法/批内重复/与既有集群冲突时整批不写、返回错误。
// 已存在的集群只更新 config，slug 一律不动（slug 创建时固化）。
func ImportClustersFromKubeconfig(kubeconfig *clientcmdapi.Config, setDefault bool, slugs map[string]string) (int64, error) {
	if len(kubeconfig.Contexts) == 0 {
		return 0, nil
	}

	existingClusters, err := model.ListClusters()
	if err != nil {
		return 0, err
	}
	if err := ValidateImportSlugs(slugs, existingClusters); err != nil {
		return 0, err
	}

	takenSlugs := make(map[string]bool, len(existingClusters)+len(slugs))
	for _, c := range existingClusters {
		if c.Slug != nil && *c.Slug != "" {
			takenSlugs[*c.Slug] = true
		}
	}

	importedCount := 0
	for contextName, context := range kubeconfig.Contexts {
		config := clientcmdapi.NewConfig()
		config.Contexts = map[string]*clientcmdapi.Context{
			contextName: context,
		}
		config.CurrentContext = contextName
		config.Clusters = map[string]*clientcmdapi.Cluster{
			context.Cluster: kubeconfig.Clusters[context.Cluster],
		}
		config.AuthInfos = map[string]*clientcmdapi.AuthInfo{
			context.AuthInfo: kubeconfig.AuthInfos[context.AuthInfo],
		}
		configStr, err := clientcmd.Write(*config)
		if err != nil {
			continue
		}
		cluster := model.Cluster{
			Name:      contextName,
			Config:    model.SecretString(configStr),
			IsDefault: setDefault && contextName == kubeconfig.CurrentContext,
		}
		if slug, ok := slugs[contextName]; ok && slug != "" {
			cluster.Slug = &slug
			takenSlugs[slug] = true
		} else {
			slug := GenerateUniqueSlug(contextName, takenSlugs)
			cluster.Slug = &slug
			takenSlugs[slug] = true
		}
		existingCluster, err := model.GetClusterByName(contextName)
		if err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				if err := model.AddCluster(&cluster); err != nil {
					continue
				}
				importedCount++
				klog.Infof("Imported cluster success: %s", contextName)
				ensureClusterAuthorizations(contextName)
			}
			continue
		}
		if existingCluster.ClusterAgent {
			continue
		}
		if err := model.UpdateCluster(existingCluster, map[string]interface{}{
			"config": model.SecretString(configStr),
		}, false); err != nil {
			continue
		}
		importedCount++
		klog.Infof("Updated cluster config success: %s", contextName)
		ensureClusterAuthorizations(contextName)
	}
	return int64(importedCount), nil
}

// ensureClusterAuthorizations 给新导入或重新导入的集群补齐内置授权：
// 超级管理员的全局作用域「超级权限绑定」。幂等，且不要求集群当前可达。
//
// 内置授权原本只在服务启动时为「当时已存在」的集群创建，导入路径不会触发，
// 于是新导入的集群在下次重启前都没有这个组，管理员页签会一直提示缺少它。
func ensureClusterAuthorizations(clusterName string) {
	if err := model.EnsureSuperAdminProvisioningForCluster(clusterName); err != nil {
		klog.Warningf("failed to provision default authorizations for cluster %s: %v", clusterName, err)
	}
}

var (
	syncNow = make(chan struct{}, 1)
)

func TriggerClusterSync() {
	select {
	case syncNow <- struct{}{}:
	default:
	}
}

func syncClusters(cm *ClusterManager, readyCh chan<- struct{}) error {
	if readyCh != nil {
		defer func() {
			select {
			case readyCh <- struct{}{}:
			default:
			}
		}()
	}

	clusters, err := model.ListClusters()
	if err != nil {
		klog.Warningf("list cluster err: %v", err)
		time.Sleep(5 * time.Second)
		return err
	}
	dbClusterMap := make(map[string]interface{})
	type buildResult struct {
		cluster   *model.Cluster
		clientSet *ClientSet
		err       error
	}
	buildQueue := make([]*model.Cluster, 0)
	for _, cluster := range clusters {
		dbClusterMap[cluster.Name] = cluster
		if cluster.IsDefault {
			cm.mu.Lock()
			cm.defaultContext = cluster.Name
			cm.mu.Unlock()
		}
		cm.mu.RLock()
		current, currentExist := cm.clusters[cluster.Name]
		cm.mu.RUnlock()
		if cluster.ClusterAgent && !cluster.Enable {
			cm.clusterAgentManager.Disconnect(cluster.ID)
		}
		if cluster.ClusterAgent && !cm.clusterAgentManager.Connected(cluster.ID) {
			if currentExist {
				cm.mu.Lock()
				delete(cm.clusters, cluster.Name)
				cm.mu.Unlock()
				current.K8sClient.Stop(cluster.Name)
			}
			cm.mu.Lock()
			if cluster.Enable {
				cm.errors[cluster.Name] = "waiting for cluster agent connection"
			} else {
				delete(cm.errors, cluster.Name)
			}
			cm.mu.Unlock()
			continue
		}
		clusterAgentConfigChanged := cluster.ClusterAgent && currentExist && current.clusterAgentGeneration != cm.clusterAgentManager.Generation(cluster.ID)
		if clusterAgentConfigChanged {
			klog.Infof("Cluster Agent transport configuration changed for cluster %s, updating", cluster.Name)
		}
		if clusterAgentConfigChanged || shouldUpdateCluster(current, cluster) {
			if currentExist {
				cm.mu.Lock()
				delete(cm.clusters, cluster.Name)
				cm.mu.Unlock()
				current.K8sClient.Stop(cluster.Name)
			}
			if cluster.Enable {
				buildQueue = append(buildQueue, cluster)
			} else {
				cm.mu.Lock()
				delete(cm.errors, cluster.Name)
				cm.mu.Unlock()
			}
		}
	}
	results := make(chan buildResult, len(buildQueue))
	var wg sync.WaitGroup
	for _, cluster := range buildQueue {
		wg.Add(1)
		go func(cluster *model.Cluster) {
			defer wg.Done()
			clientSet, err := cm.buildClientSet(cluster)
			results <- buildResult{
				cluster:   cluster,
				clientSet: clientSet,
				err:       err,
			}
		}(cluster)
	}
	go func() {
		wg.Wait()
		close(results)
	}()
	for result := range results {
		if result.err != nil {
			klog.Errorf("Failed to build k8s client for cluster %s, in cluster: %t, err: %v", result.cluster.Name, result.cluster.InCluster, result.err)
			cm.mu.Lock()
			cm.errors[result.cluster.Name] = result.err.Error()
			cm.mu.Unlock()
			continue
		}
		cm.mu.Lock()
		delete(cm.errors, result.cluster.Name)
		cm.clusters[result.cluster.Name] = result.clientSet
		cm.mu.Unlock()
	}
	cm.mu.Lock()
	for name, clientSet := range cm.clusters {
		if _, ok := dbClusterMap[name]; !ok {
			delete(cm.clusters, name)
			clientSet.K8sClient.Stop(name)
		}
	}
	for name := range cm.errors {
		if _, ok := dbClusterMap[name]; !ok {
			delete(cm.errors, name)
		}
	}
	cm.mu.Unlock()

	return nil
}

// shouldUpdateCluster 依据数据库中的期望状态判断
// 缓存的 ClientSet 是否需要更新。
func shouldUpdateCluster(cs *ClientSet, cluster *model.Cluster) bool {
	// 启用/停用开关
	if (cs == nil && cluster.Enable) || (cs != nil && !cluster.Enable) {
		klog.Infof("Cluster %s status changed, updating, enabled -> %v", cluster.Name, cluster.Enable)
		return true
	}
	if cs == nil && !cluster.Enable {
		return false
	}

	if cs == nil || cs.K8sClient == nil || cs.K8sClient.ClientSet == nil {
		return true
	}

	// kubeconfig 变更
	if cs.config != string(cluster.Config) {
		klog.Infof("Kubeconfig changed for cluster %s, updating", cluster.Name)
		return true
	}

	// prometheus URL 变更
	if cs.prometheusURL != cluster.PrometheusURL {
		klog.Infof("Prometheus URL changed for cluster %s, updating", cluster.Name)
		return true
	}

	// k8s 版本变更
	// TODO: 用一个精简的 DiscoveryInterface 替换直接调用 ClientSet.Discovery()。
	// 当前代码依赖 *kubernetes.Clientset，在测试中很难 mock。
	version, err := cs.K8sClient.ClientSet.Discovery().ServerVersion()
	if err != nil {
		klog.Warningf("Failed to get server version for cluster %s: %v", cluster.Name, err)
		cs.K8sClient.Health().RecordProbeError(err)
	} else {
		// 这里对 /version 的访问既是版本比对、也是一次探活，复用它的结果，
		// 不再为同一轮同步额外发一次请求。
		cs.K8sClient.Health().RecordProbeOK(time.Now())
		if version.String() != cs.Version {
			klog.Infof("Server version changed for cluster %s, updating, old: %s, new: %s", cluster.Name, cs.Version, version.String())
			return true
		}
	}

	return false
}

func buildClientSet(cluster *model.Cluster) (*ClientSet, error) {
	if cluster.InCluster {
		return createClientSetInCluster(cluster.Name, cluster.PrometheusURL)
	}
	return createClientSetFromConfig(cluster.Name, string(cluster.Config), cluster.PrometheusURL)
}

func (cm *ClusterManager) buildClientSet(cluster *model.Cluster) (*ClientSet, error) {
	if !cluster.ClusterAgent {
		return buildClientSet(cluster)
	}
	config, generation, err := cm.clusterAgentManager.RESTConfig(cluster.ID)
	if err != nil {
		return nil, err
	}
	clientSet, err := newClientSet(cluster.Name, config, cluster.PrometheusURL)
	if err != nil {
		return nil, err
	}
	clientSet.clusterAgentGeneration = generation
	return clientSet, nil
}

func (cm *ClusterManager) syncClusters() error {
	cm.syncMu.Lock()
	defer cm.syncMu.Unlock()

	return syncClusters(cm, nil)
}

func (cm *ClusterManager) syncClustersUntilReady(readyCh chan<- struct{}) error {
	cm.syncMu.Lock()
	defer cm.syncMu.Unlock()

	return syncClusters(cm, readyCh)
}

func (cm *ClusterManager) snapshotState() (map[string]*ClientSet, map[string]string, string) {
	cm.mu.RLock()
	defer cm.mu.RUnlock()

	clusters := make(map[string]*ClientSet, len(cm.clusters))
	maps.Copy(clusters, cm.clusters)

	errors := make(map[string]string, len(cm.errors))
	maps.Copy(errors, cm.errors)

	return clusters, errors, cm.defaultContext
}

func NewClusterManager() (*ClusterManager, error) {
	cm := new(ClusterManager)
	cm.clusters = make(map[string]*ClientSet)
	cm.errors = make(map[string]string)
	cm.clusterAgentManager = clusteragent.NewManager(TriggerClusterSync)

	initialReady := make(chan struct{}, 1)
	go func() {
		if err := cm.syncClustersUntilReady(initialReady); err != nil {
			klog.Warningf("Failed to sync clusters: %v", err)
		}
	}()

	go func() {
		ticker := time.NewTicker(1 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
			case <-syncNow:
			}
			if err := cm.syncClusters(); err != nil {
				klog.Warningf("Failed to sync clusters: %v", err)
			}
		}
	}()

	go cm.probeLoop()

	timer := time.NewTimer(clusterStartupSyncTimeout)
	defer timer.Stop()

	select {
	case <-initialReady:
	case <-timer.C:
		klog.Warningf("Timed out waiting for cluster readiness after %s, continuing startup", clusterStartupSyncTimeout)
	}
	return cm, nil
}

// probeLoop 周期性主动探活所有已建好的集群。
//
// 这是唯一的「恢复」判据：informer 的 watch 错误回调只在出错时触发
// （client-go 没有恢复回调），不主动探一次就无法把集群从「可能陈旧」拉回正常。
func (cm *ClusterManager) probeLoop() {
	interval := ClusterProbeInterval()
	if interval <= 0 {
		klog.Infof("cluster API probing is disabled (AEROLINK_CLUSTER_PROBE_INTERVAL=0)")
		return
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for range ticker.C {
		cm.probeAllClusters()
	}
}

// probeAllClusters 并发探活一轮；单集群超时不影响其它集群。
func (cm *ClusterManager) probeAllClusters() {
	clusters, _, _ := cm.snapshotState()
	var wg sync.WaitGroup
	for _, cs := range clusters {
		if cs == nil || cs.K8sClient == nil || cs.K8sClient.ClientSet == nil {
			continue
		}
		wg.Add(1)
		go func(cs *ClientSet) {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), clusterProbeTimeout)
			defer cancel()
			if err := kube.ProbeServerVersion(ctx, cs.K8sClient.ClientSet); err != nil {
				cs.K8sClient.Health().RecordProbeError(err)
				return
			}
			cs.K8sClient.Health().RecordProbeOK(time.Now())
		}(cs)
	}
	wg.Wait()
}
