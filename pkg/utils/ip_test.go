package utils

import (
	"testing"
)

func TestIsPrivateIP(t *testing.T) {
	tests := []struct {
		ip   string
		want bool
	}{
		{"10.0.0.1", true},
		{"10.255.255.255", true},
		{"172.16.0.1", true},
		{"172.31.255.255", true},
		{"192.168.0.1", true},
		{"192.168.255.255", true},
		{"127.0.0.1", false}, // 环回不算 RFC 1918
		{"8.8.8.8", false},
		{"203.0.113.50", false},
		{"198.51.100.10", false},
		{"218.201.197.186", false},
		{"", false},
		{"not-an-ip", false},
	}
	for _, tt := range tests {
		if got := IsPrivateIP(tt.ip); got != tt.want {
			t.Errorf("IsPrivateIP(%q) = %v, want %v", tt.ip, got, tt.want)
		}
	}
}

func TestParseXForwardedFor(t *testing.T) {
	tests := []struct {
		xff  string
		want []string
	}{
		{"", nil},
		{"  ", nil},
		{"10.1.2.100", []string{"10.1.2.100"}},
		{"10.1.2.100, 203.0.113.50", []string{"10.1.2.100", "203.0.113.50"}},
		{"10.1.2.100,203.0.113.50,218.201.197.186", []string{"10.1.2.100", "203.0.113.50", "218.201.197.186"}},
		{" 10.1.2.100 , 203.0.113.50 ", []string{"10.1.2.100", "203.0.113.50"}},
	}
	for _, tt := range tests {
		got := ParseXForwardedFor(tt.xff)
		if len(got) != len(tt.want) {
			t.Errorf("ParseXForwardedFor(%q) len = %d, want %d", tt.xff, len(got), len(tt.want))
			continue
		}
		for i := range got {
			if got[i] != tt.want[i] {
				t.Errorf("ParseXForwardedFor(%q)[%d] = %q, want %q", tt.xff, i, got[i], tt.want[i])
			}
		}
	}
}

func TestExtractSourceIP(t *testing.T) {
	tests := []struct {
		name          string
		xForwardedFor string
		remoteAddr    string
		want          string
	}{
		{
			name:          "内网客户端+公网出口(SLB追加)",
			xForwardedFor: "10.1.2.100, 218.201.197.186",
			remoteAddr:    "127.0.0.1:8080",
			want:          "10.1.2.100",
		},
		{
			name:          "多级NAT：内网→公司出口NAT→SLB",
			xForwardedFor: "10.1.2.100, 203.0.113.50, 218.201.197.186",
			remoteAddr:    "127.0.0.1:8080",
			want:          "10.1.2.100",
		},
		{
			name:          "公网直连",
			xForwardedFor: "198.51.100.10",
			remoteAddr:    "198.51.100.10:12345",
			want:          "198.51.100.10",
		},
		{
			name:          "纯内网环境",
			xForwardedFor: "10.1.2.100, 10.0.0.1",
			remoteAddr:    "10.0.0.1:8080",
			want:          "10.1.2.100",
		},
		{
			name:          "空链回退RemoteAddr",
			xForwardedFor: "",
			remoteAddr:    "192.168.1.1:8080",
			want:          "192.168.1.1",
		},
		{
			name:          "RemoteAddr无端口",
			xForwardedFor: "",
			remoteAddr:    "203.0.113.50",
			want:          "203.0.113.50",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ExtractSourceIP(tt.xForwardedFor, tt.remoteAddr); got != tt.want {
				t.Errorf("ExtractSourceIP() = %q, want %q", got, tt.want)
			}
		})
	}
}
