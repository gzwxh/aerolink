package utils

import (
	"net"
	"strings"
)

// rfc1918Blocks 是 RFC 1918 私有地址段（不含环回与链路本地）。
var rfc1918Blocks = []*net.IPNet{
	{IP: net.IPv4(10, 0, 0, 0), Mask: net.CIDRMask(8, 32)},
	{IP: net.IPv4(172, 16, 0, 0), Mask: net.CIDRMask(12, 32)},
	{IP: net.IPv4(192, 168, 0, 0), Mask: net.CIDRMask(16, 32)},
}

// IsPrivateIP 报告该 IP 是否为 RFC 1918 私有地址（不包含环回 127.0.0.0/8）。
func IsPrivateIP(ip string) bool {
	parsed := net.ParseIP(strings.TrimSpace(ip))
	if parsed == nil {
		return false
	}
	for _, block := range rfc1918Blocks {
		if block.Contains(parsed) {
			return true
		}
	}
	return false
}

// ParseXForwardedFor 将 X-Forwarded-For 头拆成去空白后的 IP 列表。
// 空值返回 nil slice。
func ParseXForwardedFor(xff string) []string {
	if strings.TrimSpace(xff) == "" {
		return nil
	}
	parts := strings.Split(xff, ",")
	ips := make([]string, 0, len(parts))
	for _, p := range parts {
		if ip := strings.TrimSpace(p); ip != "" {
			ips = append(ips, ip)
		}
	}
	return ips
}

// ExtractSourceIP 从 X-Forwarded-For 链中提取原始客户端 IP（最左边的非空 IP）。
//
// 标准 X-Forwarded-For 格式：client, proxy1, proxy2
// 最左边是原始发起请求的客户端 IP。当链为空时回退到 remoteAddr（去掉端口）。
//
// 与 ClientIP() 互补：ClientIP() 返回最近一跳的非代理 IP（通常是公网出口），
// ExtractSourceIP 返回原始客户端 IP（通常包含内网地址），两者配合实现
// 同时记录内外网两个维度。
func ExtractSourceIP(xForwardedFor, remoteAddr string) string {
	chain := ParseXForwardedFor(xForwardedFor)
	if len(chain) > 0 {
		return chain[0]
	}

	if host, _, err := net.SplitHostPort(remoteAddr); err == nil {
		return host
	}
	return remoteAddr
}
