package audit

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/zxh326/kite/pkg/model"
)

// syslogAppName 是 RFC5424 的 APP-NAME。
const syslogAppName = "aerolink"

// sendSyslog 把一条结构化审计记录渲染成 RFC5424 消息并发送。
func sendSyslog(config model.LogForwardSetting, message model.AuditMessage) error {
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

	if err := conn.SetWriteDeadline(time.Now().Add(logForwardWriteTimeout)); err != nil {
		return err
	}
	_, err = conn.Write([]byte(formatSyslogMessage(config, line)))
	return err
}

func dialSyslog(config model.LogForwardSetting, address string) (net.Conn, error) {
	switch config.Network {
	case model.SyslogNetworkTCP:
		return net.DialTimeout("tcp", address, logForwardWriteTimeout)
	case model.SyslogNetworkTLS:
		host, _, err := net.SplitHostPort(address)
		if err != nil {
			host = address
		}
		return tls.DialWithDialer(
			&net.Dialer{Timeout: logForwardWriteTimeout},
			"tcp",
			address,
			&tls.Config{
				ServerName: host,
				// #nosec G402 -- 自签证书场景由管理员显式开启（与 ES / 外部日志存储同级）。
				InsecureSkipVerify: config.InsecureSkipVerify,
				MinVersion:         tls.VersionTLS12,
			},
		)
	default:
		return net.DialTimeout("udp", address, logForwardWriteTimeout)
	}
}

// formatSyslogLineFor 按配置选择正文格式：text（RFC5424 + key=value，默认）或 json。
func formatSyslogLineFor(config model.LogForwardSetting, message model.AuditMessage) string {
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

// auditDocumentJSON 把一条审计记录渲染成结构化 JSON。
//
// syslog 的 json 格式与 Kafka 的消息体都用它：字段集与 ES 文档同构（复用
// esDocumentFromMessage 的字段映射），两处不会各自漂移。
// 第二个返回值为 false 表示分类未知——调用方应跳过，不要发一条空消息。
func auditDocumentJSON(message model.AuditMessage) ([]byte, bool) {
	doc := esDocumentFromMessage(message)
	if doc.Kind == "" {
		return nil, false
	}
	// kind 在写入 ES 时才注入 _source，这里显式带上，保证 JSON 文档与 ES 文档同构。
	fields := make(map[string]any, len(doc.Fields)+1)
	for key, value := range doc.Fields {
		fields[key] = value
	}
	fields[esFieldKind] = doc.Kind

	data, err := json.Marshal(fields)
	if err != nil {
		return nil, false
	}
	return data, true
}

// formatSyslogLineJSON 输出结构化正文（json 模式下不再带 "FAIL " 前缀，失败信息在
// success/result 字段里）。
func formatSyslogLineJSON(message model.AuditMessage) string {
	data, ok := auditDocumentJSON(message)
	if !ok {
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
//	<PRI>1 TIMESTAMP HOSTNAME APP-NAME PROCID MSGID [aerolink@32473 ...] MSG
//
// PRI = facility*8 + severity（失败记录用 warning，其余用 informational）。
func formatSyslogMessage(config model.LogForwardSetting, message string) string {
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
