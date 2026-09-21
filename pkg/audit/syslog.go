package audit

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net"
	"strconv"
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
	syslogQueue    chan model.AuditMessage
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
		syslogQueue = make(chan model.AuditMessage, syslogQueueSize)
		// 模型层只负责把结构化记录交出来；渲染（key=value）与发送都在这里完成，
		// 避免 model → audit 循环，也避免序列化逻辑散落在两层。
		model.AddAuditForwarder(forwardToSyslog)
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
func forwardToSyslog(message model.AuditMessage) {
	if syslogQueue == nil {
		return
	}
	// 访问日志不进 syslog：量大，且它本来走 stdout 采集。保持不变以免改变既有行为。
	if message.Kind == model.AuditKindAccess {
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

// sendSyslog 把一条结构化审计记录渲染成 RFC5424 消息并发送。
func sendSyslog(config model.SyslogSetting, message model.AuditMessage) error {
	line := formatSyslogLineFor(config, message)
	if line == "" {
		// 未知分类：不发送，避免往日志服务器灌一条空消息。
		return nil
	}

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
	_, err = conn.Write([]byte(formatSyslogMessage(config, line)))
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

// formatSyslogLineFor 按配置选择正文格式：text（RFC5424 + key=value，默认）或 json。
func formatSyslogLineFor(config model.SyslogSetting, message model.AuditMessage) string {
	if model.NormalizeLogFormat(config.Format) == model.LogFormatJSON {
		return formatSyslogLineJSON(message)
	}

	line := formatSyslogLine(message)
	if line == "" {
		return ""
	}
	// text 正文在末尾补 request_id，且**仅在存在时**追加：为空时输出与改造前逐字节一致，
	// 既有 syslog 消费者的解析不受影响（见 syslog_test.go 的字节级回归断言）。
	if message.RequestID != "" {
		line += " request_id=" + orDash(message.RequestID)
	}
	return line
}

// formatSyslogLineJSON 输出结构化正文：字段集与 §5 schema 一致，复用 ES 文档的映射，
// 两侧字段名不会各自漂移。json 模式下不再带 "FAIL " 前缀，失败信息在 success/result 字段里。
func formatSyslogLineJSON(message model.AuditMessage) string {
	doc := esDocumentFromMessage(message)
	if doc.Kind == "" {
		return ""
	}
	// kind 在写入 ES 时才注入 _source，这里显式带上，保证 json 正文与 ES 文档同构。
	fields := make(map[string]any, len(doc.Fields)+1)
	for key, value := range doc.Fields {
		fields[key] = value
	}
	fields[esFieldKind] = doc.Kind

	data, err := json.Marshal(fields)
	if err != nil {
		return ""
	}
	return string(data)
}

// formatSyslogLine 把结构化审计消息渲染成 syslog 正文（key=value）。
//
// 这是既有 syslog 输出的**字节级契约**：渲染逻辑原先在 model 层，上移到 audit 层后
// 相同的记录必须产出完全一致的字符串（见 syslog_test.go 的回归断言）。
func formatSyslogLine(message model.AuditMessage) string {
	switch message.Kind {
	case model.AuditKindOperation:
		return formatOperationSyslogLine(message)
	case model.AuditKindLogin:
		return formatLoginSyslogLine(message)
	case model.AuditKindPasswordChange:
		return formatPasswordChangeSyslogLine(message)
	case model.AuditKindAccess:
		return formatAccessSyslogLine(message)
	default:
		return ""
	}
}

func formatOperationSyslogLine(message model.AuditMessage) string {
	result := "success"
	if !message.Success {
		result = "failure"
	}
	target := message.ResourceType
	if message.ResourceName != "" {
		target += "/" + message.ResourceName
	}

	fields := []string{
		"event=audit",
		"op=" + message.OperationType,
		"result=" + result,
		"resource=" + target,
		"operator=" + orDash(message.OperatorName),
		"cluster=" + orDash(message.ClusterName),
		"namespace=" + orDash(message.Namespace),
		"source=" + orDash(message.OperationSource),
		"client=" + orDash(message.ClientIP),
	}
	return strings.Join(fields, " ")
}

func formatLoginSyslogLine(message model.AuditMessage) string {
	if message.Result == model.AuditResultSuccess {
		return strings.Join([]string{
			"event=login",
			"result=success",
			"user=" + orDash(message.Username),
			"provider=" + orDash(message.Provider),
			"client=" + orDash(message.ClientIP),
		}, " ")
	}
	// "FAIL " 前缀让 syslog 侧把严重级别提到 warning（见 formatSyslogMessage）。
	return "FAIL " + strings.Join([]string{
		"event=login",
		"result=failure",
		"reason=" + orDash(message.Result),
		"user=" + orDash(message.Username),
		"provider=" + orDash(message.Provider),
		"client=" + orDash(message.ClientIP),
	}, " ")
}

// formatPasswordChangeSyslogLine 是**新增**的外发内容（改造前改密不外发），
// 沿用与操作 / 登录一致的 key=value 风格。
func formatPasswordChangeSyslogLine(message model.AuditMessage) string {
	return strings.Join([]string{
		"event=password",
		"user=" + orDash(message.Username),
		"operator=" + orDash(message.Operator),
		"source=" + orDash(message.Source),
	}, " ")
}

// formatAccessSyslogLine 渲染访问日志。访问日志默认不进 syslog（见 text/json 格式配置），
// 这里统一渲染以便配置开启时行为一致。
func formatAccessSyslogLine(message model.AuditMessage) string {
	return strings.Join([]string{
		"event=access",
		"method=" + orDash(message.Method),
		"path=" + orDash(message.Path),
		"status=" + strconv.Itoa(message.StatusCode),
		"latency_ms=" + strconv.FormatInt(message.LatencyMs, 10),
		"cluster=" + orDash(message.ClusterName),
		"user=" + orDash(message.Username),
		"client=" + orDash(message.ClientIP),
	}, " ")
}

// orDash 做 syslog 行协议的清洗：空值用 "-"；换行会把一条记录拆成两条，必须替换掉。
func orDash(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "-"
	}
	return strings.NewReplacer("\n", " ", "\r", " ").Replace(value)
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
