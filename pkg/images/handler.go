package images

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/cluster"
	"github.com/zxh326/kite/pkg/model"
	"github.com/zxh326/kite/pkg/rbac"
	"github.com/zxh326/kite/pkg/utils"
	"k8s.io/klog/v2"
)

// allowPrivateRegistries 让仓库位于私有地址的部署
// （内部 Harbor、公司镜像站）继续可用。关闭时，
// 查询会拒绝回环/私有/链路本地目标，这样已认证用户
// 就无法把服务端当作 SSRF 探针，去打集群内部或者云
// 元数据服务。
func allowPrivateRegistries() bool {
	return strings.EqualFold(strings.TrimSpace(os.Getenv("KITE_ALLOW_PRIVATE_REGISTRIES")), "true")
}

// blockedRegistryHost 报告该 host 是否指向本地网络。
func blockedRegistryHost(host string) bool {
	if allowPrivateRegistries() {
		return false
	}
	h := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(host)), ".")
	if h == "" {
		return true
	}
	// 仓库通常会用显式端口来引用。
	if hostOnly, _, err := net.SplitHostPort(h); err == nil {
		h = hostOnly
	}
	for _, suffix := range []string{"localhost", ".localhost", ".local", ".internal", ".cluster.local"} {
		if h == strings.TrimPrefix(suffix, ".") || strings.HasSuffix(h, suffix) {
			return true
		}
	}
	if ip := net.ParseIP(h); ip != nil {
		return isBlockedIP(ip)
	}
	ips, err := net.LookupIP(h)
	if err != nil {
		return false // unresolvable hosts simply fail to dial
	}
	for _, ip := range ips {
		if isBlockedIP(ip) {
			return true
		}
	}
	return false
}

func isBlockedIP(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast()
}

type ImageTagInfo struct {
	Name      string     `json:"name"`
	Timestamp *time.Time `json:"timestamp,omitempty"`
}

type registry interface {
	GetTags(ctx context.Context) ([]ImageTagInfo, error)
}

type dockerRegistry struct {
	repo string
}

type containerRegistryV2 struct {
	baseURL string
	repo    string
}

// registryHTTPClient 为仓库查询设置上限，避免恶意或不可达的 host
// 永久占住一个服务端 goroutine。该 dialer 自己解析 host，
// 并在建连时对解析出的每个 IP 重新对照黑名单，
// 从而关闭 SSRF 预检查与实际连接之间的 DNS 重绑定窗口。
// TLS 仍按原始主机名校验。
var registryHTTPClient = &http.Client{
	Timeout: 10 * time.Second,
	Transport: &http.Transport{
		Proxy:       http.ProxyFromEnvironment,
		DialContext: checkedRegistryDialContext,
	},
}

func checkedRegistryDialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	if allowPrivateRegistries() {
		return dialer.DialContext(ctx, network, addr)
	}
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	var dialIPs []net.IP
	for _, ip := range ips {
		if isBlockedIP(ip.IP) {
			return nil, fmt.Errorf("registry host %s resolves to a blocked address", host)
		}
		dialIPs = append(dialIPs, ip.IP)
	}
	if len(dialIPs) == 0 {
		return nil, fmt.Errorf("registry host %s did not resolve", host)
	}
	var lastErr error
	for _, ip := range dialIPs {
		conn, dialErr := dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
		if dialErr == nil {
			return conn, nil
		}
		lastErr = dialErr
	}
	return nil, lastErr
}

func (d dockerRegistry) GetTags(ctx context.Context) ([]ImageTagInfo, error) {
	url := fmt.Sprintf("https://hub.docker.com/v2/repositories/%s/tags?page_size=10&ordering=last_updated", d.repo)
	klog.V(1).Infof("fetching tags from Docker Hub: %s", url)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, nil
	}
	resp, err := registryHTTPClient.Do(req)
	if err != nil {
		klog.Errorf("failed to get tags from Docker Hub: %v", err)
		return nil, nil
	}
	defer func() {
		_ = resp.Body.Close()
	}()
	if resp.StatusCode != 200 {
		klog.Errorf("docker hub api error: %s, status: %s", d.repo, resp.Status)
		return nil, nil
	}
	var data struct {
		Results []struct {
			Name        string    `json:"name"`
			LastUpdated time.Time `json:"last_updated"`
		}
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return nil, nil
	}
	tags := make([]ImageTagInfo, 0, len(data.Results))
	for _, t := range data.Results {
		tags = append(tags, ImageTagInfo{Name: t.Name, Timestamp: &t.LastUpdated})
	}
	return tags, nil
}

func (d containerRegistryV2) GetTags(ctx context.Context) ([]ImageTagInfo, error) {
	url := fmt.Sprintf("https://%s/v2/%s/tags/list", d.baseURL, d.repo)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, nil
	}
	resp, err := registryHTTPClient.Do(req)
	if err != nil {
		klog.Errorf("failed to get tags from registry %s: %v", d.baseURL, err)
		return nil, nil
	}
	defer func() {
		_ = resp.Body.Close()
	}()
	if resp.StatusCode != 200 {
		klog.Errorf("registry v2 api error: %s, status: %s", d.baseURL, resp.Status)
		return nil, nil
	}
	var data struct {
		Tags []string `json:"tags"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return nil, nil
	}
	tags := make([]ImageTagInfo, 0, len(data.Tags))
	for _, t := range data.Tags {
		if strings.HasPrefix(t, "sha256") {
			// 跳过 digest 形式的 tag
			continue
		}
		tags = append(tags, ImageTagInfo{Name: t})
	}
	return tags, nil
}

func getRegistry(image string) registry {
	r, repo := utils.GetImageRegistryAndRepo(image)
	if r == "" || r == "docker.io" {
		return dockerRegistry{repo}
	}
	return containerRegistryV2{baseURL: r, repo: repo}
}

func GetImageTags(c *gin.Context) {
	// 该查询在服务端针对调用方提供的 host 执行，因此需要
	// 与其它集群级读操作相同的集群级授权。
	user := c.MustGet("user").(model.User)
	cs := c.MustGet("cluster").(*cluster.ClientSet)
	if !rbac.CanAccessCluster(user, cs.Name) {
		c.JSON(http.StatusForbidden, gin.H{"error": "Access denied"})
		return
	}

	image := c.Query("image")
	if image == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "image param required"})
		return
	}
	host, _ := utils.GetImageRegistryAndRepo(image)
	if blockedRegistryHost(host) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "registry host is not allowed"})
		return
	}
	reg := getRegistry(image)
	tags, err := reg.GetTags(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, tags)
}
