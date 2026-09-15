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

// allowPrivateRegistries lets deployments whose registry lives on a private
// address (internal Harbor, company mirror) keep working. When it is off, the
// lookup refuses loopback/private/link-local targets so an authenticated user
// cannot use the server as an SSRF probe into the cluster or the cloud
// metadata service.
func allowPrivateRegistries() bool {
	return strings.EqualFold(strings.TrimSpace(os.Getenv("KITE_ALLOW_PRIVATE_REGISTRIES")), "true")
}

// blockedRegistryHost reports whether the host targets the local network.
func blockedRegistryHost(host string) bool {
	if allowPrivateRegistries() {
		return false
	}
	h := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(host)), ".")
	if h == "" {
		return true
	}
	// Registries are commonly referenced with an explicit port.
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

// registryHTTPClient bounds registry lookups so a hostile or unreachable host
// cannot pin a server goroutine indefinitely. The dialer resolves the host
// itself and re-checks every resolved IP against the blocklist at connect
// time, closing the DNS-rebinding window between the SSRF pre-check and the
// actual connection. TLS still validates against the original hostname.
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
			// Skip digest tags
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
	// The lookup runs server side against a caller supplied host, so it needs
	// the same cluster level authorisation as the other cluster wide reads.
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
