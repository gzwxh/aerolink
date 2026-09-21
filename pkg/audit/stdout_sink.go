package audit

import (
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"sync/atomic"

	"github.com/zxh326/kite/pkg/model"
	"k8s.io/klog/v2"
)

// stdoutQueueSize 是「审计事件 → 标准输出」的队列长度。与 syslog 同量级：审计事件的产生
// 速率很低（人为操作 / 系统事件），这个容量足以吸收突发。
const stdoutQueueSize = 1024

var (
	stdoutOnce     sync.Once
	stdoutQueue    chan model.AuditMessage
	stdoutConfigMu sync.RWMutex
	stdoutConfig   model.StdoutSetting

	stdoutDropped atomic.Int64
	stdoutWritten atomic.Int64
)

// StartAuditStdout 启动「审计事件 → 标准输出」的通道。
//
// 目的：让只采集 stdout / stderr 的日志平台也能回答「什么时间、谁、从哪个 IP、做了什么」，
// 不必再去翻数据库。实现方式与 syslog 完全一致——注册一个 model.AuditForwarder，
// 审计记录落库后非阻塞投递；失败或队列满都只丢弃并计数，绝不影响落库与请求。
//
// 只输出操作 / 登录 / 改密三类：访问日志已由 gin 访问日志中间件输出，再投一份就是重复。
func StartAuditStdout() {
	stdoutOnce.Do(func() {
		stdoutQueue = make(chan model.AuditMessage, stdoutQueueSize)
		model.AddAuditForwarder(forwardToStdout)
		reloadStdoutConfig()
		go stdoutWorker()
	})
}

// reloadStdoutConfig 重新读取输出配置（启动时与保存审计设置后调用）。
func reloadStdoutConfig() {
	setting, err := model.GetAuditSetting()
	if err != nil {
		klog.Errorf("audit stdout output disabled: failed to load audit setting: %v", err)
		return
	}
	stdoutConfigMu.Lock()
	stdoutConfig = setting.Stdout
	stdoutConfigMu.Unlock()
}

// forwardToStdout 把一条审计记录投递到输出队列。非阻塞：队列满时丢弃并计数。
func forwardToStdout(message model.AuditMessage) {
	if stdoutQueue == nil {
		return
	}
	// 访问日志不进这条通道：它已经由 gin 的访问日志中间件输出（text/json 可选），
	// 再投一份就是同一件事写两遍。
	if message.Kind == model.AuditKindAccess {
		return
	}

	stdoutConfigMu.RLock()
	enabled := stdoutConfig.Enabled
	stdoutConfigMu.RUnlock()
	if !enabled {
		return
	}

	select {
	case stdoutQueue <- message:
	default:
		dropped := stdoutDropped.Add(1)
		// 与 syslog / parquet 一致：按 100 条打点，避免刷屏。
		if dropped%100 == 1 {
			klog.Warningf("audit stdout queue is full, dropped %d audit message(s)", dropped)
		}
	}
}

// stdoutWorker 串行地把队列里的审计记录写到标准输出。
//
// 单 goroutine 写是为了让每行都由一次 Write 完成：与 gin 的访问日志共用 stdout 时，
// 这才不会把两条日志的字节交错在一起。
func stdoutWorker() {
	for message := range stdoutQueue {
		stdoutConfigMu.RLock()
		config := stdoutConfig
		stdoutConfigMu.RUnlock()
		if !config.Enabled {
			continue
		}

		line := formatStdoutLineFor(config, message)
		if line == "" {
			// 未知分类：不输出半条消息。
			continue
		}
		if _, err := fmt.Fprint(os.Stdout, line); err != nil {
			klog.Warningf("failed to write audit record to stdout: %v", err)
			continue
		}
		stdoutWritten.Add(1)
	}
}

// formatStdoutLineFor 渲染一行审计事件（含结尾换行）。
//
// json（默认）：复用 ES 文档的字段映射，额外注入 `logger` 与 `event` 两个标记，
// 采集侧可以按 `logger: audit` 分流到独立索引，不必靠正则猜。
// text：沿用 syslog 的 key=value 正文，与 syslog 输出同构。
func formatStdoutLineFor(config model.StdoutSetting, message model.AuditMessage) string {
	doc := esDocumentFromMessage(message)
	if doc.Kind == "" {
		return ""
	}

	if model.NormalizeLogFormatWithDefault(config.Format, model.LogFormatJSON) == model.LogFormatText {
		line := formatSyslogLine(message)
		if line == "" {
			return ""
		}
		return line + "\n"
	}

	fields := make(map[string]any, len(doc.Fields)+2)
	for key, value := range doc.Fields {
		fields[key] = value
	}
	fields[esFieldKind] = doc.Kind
	fields["logger"] = "audit"
	fields["event"] = doc.Kind

	data, err := json.Marshal(fields)
	if err != nil {
		return ""
	}
	return string(data) + "\n"
}

// StdoutStats 返回标准输出通道的丢弃与已写出条数（供指标与排障使用）。
func StdoutStats() (dropped, written int64) {
	return stdoutDropped.Load(), stdoutWritten.Load()
}
