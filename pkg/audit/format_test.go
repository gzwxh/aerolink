package audit

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/gzwxh/aerolink/pkg/model"
)

func TestCurrentAccessLogFormatDefaultsToText(t *testing.T) {
	SetAccessLogFormat("")
	if got := CurrentAccessLogFormat(); got != model.LogFormatText {
		t.Fatalf("CurrentAccessLogFormat() = %q, want %q (text keeps the legacy output)", got, model.LogFormatText)
	}

	SetAccessLogFormat(model.LogFormatJSON)
	t.Cleanup(func() { SetAccessLogFormat(model.LogFormatText) })
	if got := CurrentAccessLogFormat(); got != model.LogFormatJSON {
		t.Fatalf("CurrentAccessLogFormat() = %q, want %q", got, model.LogFormatJSON)
	}
}

func TestFormatAccessLogJSON(t *testing.T) {
	entry := AccessLogEntry{
		At:         time.Date(2026, 9, 20, 10, 30, 0, 0, time.UTC),
		ClientIP:   "10.0.0.1",
		Method:     "GET",
		Path:       "/api/v1/clusters",
		StatusCode: 200,
		LatencyMs:  12,
		Cluster:    "prod",
		User:       "alice",
	}

	line := FormatAccessLogJSON(entry)
	if !strings.HasSuffix(line, "\n") {
		t.Errorf("json line should end with a newline: %q", line)
	}

	var parsed map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(line)), &parsed); err != nil {
		t.Fatalf("json line is not valid JSON: %v (%q)", err, line)
	}
	want := map[string]any{
		"client_ip":   "10.0.0.1",
		"method":      "GET",
		"path":        "/api/v1/clusters",
		"status_code": float64(200),
		"latency_ms":  float64(12),
		"cluster":     "prod",
		"user":        "alice",
	}
	for key, expected := range want {
		if parsed[key] != expected {
			t.Errorf("field %q = %v, want %v", key, parsed[key], expected)
		}
	}
	if _, ok := parsed["ts"]; !ok {
		t.Error("json line is missing the ts field")
	}
}

func TestFormatSyslogLineForSwitchesFormat(t *testing.T) {
	message := model.AuditMessage{
		Kind:     model.AuditKindLogin,
		At:       time.Date(2026, 9, 20, 10, 30, 0, 0, time.UTC),
		ID:       3,
		Username: "alice",
		Provider: "password",
		Result:   model.AuditResultSuccess,
	}

	textLine := formatSyslogLineFor(model.LogForwardSetting{Format: model.LogFormatText}, message)
	if !strings.HasPrefix(textLine, "event=login result=success") {
		t.Errorf("text syslog line = %q", textLine)
	}

	jsonLine := formatSyslogLineFor(model.LogForwardSetting{Format: model.LogFormatJSON}, message)
	var parsed map[string]any
	if err := json.Unmarshal([]byte(jsonLine), &parsed); err != nil {
		t.Fatalf("json syslog line is not valid JSON: %v (%q)", err, jsonLine)
	}
	if parsed["result"] != model.AuditResultSuccess || parsed["username"] != "alice" {
		t.Errorf("json syslog fields = %v", parsed)
	}
	if parsed["kind"] != ESKindLoginRecord {
		t.Errorf("json syslog kind = %v, want %v", parsed["kind"], ESKindLoginRecord)
	}
}

func TestFormatSyslogLineJSONEmptyForUnknownKind(t *testing.T) {
	got := formatSyslogLineFor(model.LogForwardSetting{Format: model.LogFormatJSON}, model.AuditMessage{Kind: "unknown"})
	if got != "" {
		t.Errorf("json line for unknown kind = %q, want empty", got)
	}
}
