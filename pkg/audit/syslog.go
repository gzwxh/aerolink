package audit

import (
	"crypto/tls"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/zxh326/kite/pkg/model"
	"k8s.io/klog/v2"
)

// syslogQueueSize 是外发队列长度。审计记录的产生速率很低（人为操作 / 系统事件），
// 这个容量足以吸收突发；队列满时丢弃并记日志，绝不在写库路径上阻塞。
const syslogQueueSize = 1024

// syslogWriteTimeout 单条外发的写超时。
const syslogWriteTimeout = 5 * time.Second

// syslogAppName 是 RFC5424 的 APP-NAME。
const syslogAppName = "kite"

var (
	syslogOnce     sync.Once
	syslogQueue    chan string
	syslogConfigMu sync.RWMutex
	syslogConfig   model.SyslogSetting
	syslogDropped  int64
	syslogMu       sync.Mutex
)

// StartSyslogForwarder 启动审计记录的 syslog 外发（P2-4）。
//
// 外发是**尽力而为**：连接失败、队列满、目标不可达都不会影响审计记录在本地落库，
// 也不会让调用方失败。默认关闭，由审计管理员在「日志审计 → 审计设置」里开启。
func StartSyslogForwarder() {
	syslogOnce.Do(func() {
		syslogQueue = make(chan string, syslogQueueSize)
		// 模型层只负责把记录交给回调，格式化与发送都在这里（避免 model → audit 循环）。
		model.SetAuditForwarder(forwardToSyslog)
		reloadSyslogConfig()
		go syslogWorker()
	})
}

// reloadSyslogConfig 重新读取外发配置（启动时与保存设置后调用）。
func reloadSyslogConfig() {
	setting, err := model.GetAuditSetting()
	if err != nil {
		klog.Errorf("syslog forwarding disabled: failed to load audit setting: %v", err)
		return
	}
	syslogConfigMu.Lock()
	syslogConfig = setting.Syslog
	syslogConfigMu.Unlock()
}

// forwardToSyslog 把一条审计记录投递到外发队列。非阻塞：队列满时丢弃并计数。
func forwardToSyslog(message string) {
	if syslogQueue == nil {
		return
	}
	syslogConfigMu.RLock()
	enabled := syslogConfig.Enabled
	syslogConfigMu.RUnlock()
	if !enabled {
		return
	}

	select {
	case syslogQueue <- message:
	default:
		syslogMu.Lock()
		syslogDropped++
		dropped := syslogDropped
		syslogMu.Unlock()
		// 每丢一条都记一行太吵，按 100 条打点。
		if dropped%100 == 1 {
			klog.Warningf("syslog forwarding queue is full, dropped %d audit message(s)", dropped)
		}
	}
}

func syslogWorker() {
	for message := range syslogQueue {
		syslogConfigMu.RLock()
		config := syslogConfig
		syslogConfigMu.RUnlock()
		if !config.Enabled {
			continue
		}
		if err := sendSyslog(config, message); err != nil {
			klog.Warningf("failed to forward audit record to syslog %s/%s: %v", config.Network, config.Address, err)
		}
	}
}

// sendSyslog 发送一条 RFC5424 消息。
func sendSyslog(config model.SyslogSetting, message string) error {
	address := config.Address
	if _, _, err := net.SplitHostPort(address); err != nil {
		// 允许只写主机名，按通用 syslog 端口 514 补全。
		address = net.JoinHostPort(address, "514")
	}

	conn, err := dialSyslog(config, address)
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close() }()

	if err := conn.SetWriteDeadline(time.Now().Add(syslogWriteTimeout)); err != nil {
		return err
	}
	_, err = conn.Write([]byte(formatSyslogMessage(config, message)))
	return err
}

func dialSyslog(config model.SyslogSetting, address string) (net.Conn, error) {
	switch config.Network {
	case model.SyslogNetworkTCP:
		return net.DialTimeout("tcp", address, syslogWriteTimeout)
	case model.SyslogNetworkTLS:
		host, _, err := net.SplitHostPort(address)
		if err != nil {
			host = address
		}
		return tls.DialWithDialer(
			&net.Dialer{Timeout: syslogWriteTimeout},
			"tcp",
			address,
			&tls.Config{
				ServerName:         host,
				InsecureSkipVerify: config.InsecureSkipVerify,
				MinVersion:         tls.VersionTLS12,
			},
		)
	default:
		return net.DialTimeout("udp", address, syslogWriteTimeout)
	}
}

// formatSyslogMessage 组装 RFC5424 消息：
//
//	<PRI>1 TIMESTAMP HOSTNAME APP-NAME PROCID MSGID [kite@32473 ...] MSG
//
// PRI = facility*8 + severity（失败记录用 warning，其余用 informational）。
func formatSyslogMessage(config model.SyslogSetting, message string) string {
	facility := config.Facility
	if facility < 0 || facility > 23 {
		facility = model.DefaultSyslogFacility
	}
	severity := 6 // informational
	if strings.HasPrefix(message, "FAIL ") {
		severity = 4 // warning
		message = strings.TrimPrefix(message, "FAIL ")
	}
	priority := facility*8 + severity

	appName := config.Tag
	if appName == "" {
		appName = syslogAppName
	}
	host, err := hostname()
	if err != nil {
		host = "-"
	}
	return fmt.Sprintf("<%d>1 %s %s %s - - - %s",
		priority, time.Now().Format(time.RFC3339), host, appName, message)
}

var hostnameCache string

func hostname() (string, error) {
	if hostnameCache != "" {
		return hostnameCache, nil
	}
	name, err := net.LookupCNAME("")
	if err != nil || name == "" {
		return "", err
	}
	hostnameCache = strings.TrimSuffix(name, ".")
	return hostnameCache, nil
}

// SyslogDroppedCount 返回被丢弃的外发消息数（供排障查看）。
func SyslogDroppedCount() int64 {
	syslogMu.Lock()
	defer syslogMu.Unlock()
	return syslogDropped
}
