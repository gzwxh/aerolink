package audit

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"aerolink/pkg/model"
)

// 接管包级状态：队列与配置是全局的，测试里替换后必须还原，避免相互影响。
func useStdoutState(t *testing.T, queue chan model.AuditMessage, config model.StdoutSetting) {
	t.Helper()
	originalQueue := stdoutQueue
	originalConfig := stdoutConfig
	originalDropped := stdoutDropped.Load()

	stdoutQueue = queue
	stdoutConfigMu.Lock()
	stdoutConfig = config
	stdoutConfigMu.Unlock()

	t.Cleanup(func() {
		stdoutQueue = originalQueue
		stdoutConfigMu.Lock()
		stdoutConfig = originalConfig
		stdoutConfigMu.Unlock()
		stdoutDropped.Store(originalDropped)
	})
}

func sampleLoginMessage() model.AuditMessage {
	return model.AuditMessage{
		Kind:      model.AuditKindLogin,
		At:        time.Date(2026, 9, 20, 10, 30, 0, 0, time.UTC),
		ID:        42,
		UserID:    3,
		Username:  "alice",
		Provider:  "password",
		Result:    model.AuditResultSuccess,
		ClientIP:  "10.0.0.9",
		UserAgent: "curl/8.4.0",
	}
}

// json 输出必须能被采集侧无歧义地识别与解析：带 logger / event 标记，字段与 §5 schema 一致。
func TestFormatStdoutLineJSONInjectsMarkers(t *testing.T) {
	line := formatStdoutLineFor(
		model.StdoutSetting{Enabled: true, Format: model.LogFormatJSON},
		sampleLoginMessage(),
	)
	if !strings.HasSuffix(line, "\n") {
		t.Fatalf("json line should end with a newline: %q", line)
	}

	var parsed map[string]any
	if err := json.Unmarshal([]byte(line), &parsed); err != nil {
		t.Fatalf("stdout json line is not valid JSON: %v (%q)", err, line)
	}
	if parsed["logger"] != "audit" {
		t.Errorf("logger = %v, want audit (collectors route on this field)", parsed["logger"])
	}
	if parsed["event"] != ESKindLoginRecord || parsed["kind"] != ESKindLoginRecord {
		t.Errorf("event/kind = %v/%v, want %s", parsed["event"], parsed["kind"], ESKindLoginRecord)
	}
	// 登录 schema 里客户端地址的字段名是 ip（见 §5），与操作 / 访问日志的 client_ip 不同。
	if parsed["username"] != "alice" || parsed["ip"] != "10.0.0.9" {
		t.Errorf("business fields missing: %v", parsed)
	}
	if parsed["result"] != model.AuditResultSuccess {
		t.Errorf("result = %v, want success", parsed["result"])
	}
}

// 未知格式取值默认走 json：标准输出是给采集工具解析的，回落 text 会破坏结构化解析。
func TestFormatStdoutLineDefaultsToJSON(t *testing.T) {
	line := formatStdoutLineFor(model.StdoutSetting{Enabled: true}, sampleLoginMessage())
	if !strings.HasPrefix(line, "{") {
		t.Fatalf("unknown format should fall back to json, got %q", line)
	}
}

// text 模式与 syslog 正文同构，便于两种输出对照排查。
func TestFormatStdoutLineTextMatchesSyslogBody(t *testing.T) {
	message := sampleLoginMessage()
	want := formatSyslogLine(message) + "\n"
	got := formatStdoutLineFor(model.StdoutSetting{Enabled: true, Format: model.LogFormatText}, message)
	if got != want {
		t.Errorf("text stdout line =\n  %q\nwant\n  %q", got, want)
	}
}

// 未知分类不输出半条消息。
func TestFormatStdoutLineUnknownKindIsEmpty(t *testing.T) {
	if got := formatStdoutLineFor(model.StdoutSetting{Format: model.LogFormatJSON}, model.AuditMessage{Kind: "unknown"}); got != "" {
		t.Errorf("unknown kind = %q, want empty", got)
	}
}

// 访问日志不进这条通道：它已由 gin 访问日志中间件输出，再投一份就是同一件事写两遍。
func TestForwardToStdoutSkipsAccessLog(t *testing.T) {
	useStdoutState(t, make(chan model.AuditMessage, 8), model.StdoutSetting{Enabled: true, Format: model.LogFormatJSON})

	forwardToStdout(model.AuditMessage{Kind: model.AuditKindAccess})
	if got := len(stdoutQueue); got != 0 {
		t.Fatalf("queue length = %d, want 0 (access logs must not enter this channel)", got)
	}

	forwardToStdout(model.AuditMessage{Kind: model.AuditKindLogin})
	if got := len(stdoutQueue); got != 1 {
		t.Fatalf("queue length = %d, want 1", got)
	}
}

// 关闭时不投递；队列满时丢弃并计数，绝不阻塞调用方。
func TestForwardToStdoutRespectsEnabledAndCapacity(t *testing.T) {
	useStdoutState(t, make(chan model.AuditMessage, 1), model.StdoutSetting{Enabled: false, Format: model.LogFormatJSON})

	forwardToStdout(model.AuditMessage{Kind: model.AuditKindLogin})
	if got := len(stdoutQueue); got != 0 {
		t.Fatalf("disabled output enqueued %d message(s), want 0", got)
	}

	stdoutConfigMu.Lock()
	stdoutConfig = model.StdoutSetting{Enabled: true, Format: model.LogFormatJSON}
	stdoutConfigMu.Unlock()

	forwardToStdout(model.AuditMessage{Kind: model.AuditKindLogin})
	forwardToStdout(model.AuditMessage{Kind: model.AuditKindLogin})

	if got := len(stdoutQueue); got != 1 {
		t.Errorf("queue length = %d, want 1 (the second message must be dropped)", got)
	}
	if got := stdoutDropped.Load(); got != 1 {
		t.Errorf("dropped = %d, want 1", got)
	}
}

// 归档器尚未启动（队列为 nil）时投递必须安全返回，而不是 panic。
func TestForwardToStdoutBeforeStartIsNoop(t *testing.T) {
	useStdoutState(t, nil, model.StdoutSetting{Enabled: true, Format: model.LogFormatJSON})
	forwardToStdout(model.AuditMessage{Kind: model.AuditKindLogin})
}
