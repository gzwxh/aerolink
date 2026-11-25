package audit

import (
	"sync"
	"time"

	"aerolink/pkg/model"
	"k8s.io/klog/v2"
)

// —— 日志外发（syslog / kafka 二选一）的公共链路 ——
//
// 这一层只做三件事：把审计记录非阻塞地塞进队列、按当前方式把消息发出去、把丢弃数记下来。
// 具体协议（RFC5424 / Kafka JSON）在 syslog.go 与 kafka_sink.go 里。
//
// 外发是**尽力而为**：连接失败、目标不可达、队列满都只记日志与计数，绝不影响审计记录落库，
// 也不回压请求（与归档链路同一原则）。

// logForwardQueueSize 是外发队列长度。审计记录的产生速率很低（人为操作 / 系统事件），
// 这个容量足以吸收突发；队列满时丢弃并记日志，绝不在写库路径上阻塞。
const logForwardQueueSize = 1024

// logForwardWriteTimeout 单条外发的写超时（syslog 的连接与写入、Kafka 的一次 produce）。
const logForwardWriteTimeout = 5 * time.Second

var (
	logForwardOnce     sync.Once
	logForwardQueue    chan model.AuditMessage
	logForwardConfigMu sync.RWMutex
	logForwardConfig   model.LogForwardSetting
	logForwardDropped  int64
	logForwardMu       sync.Mutex
)

// StartLogForwarder 启动审计记录的日志外发（syslog 或 Kafka，二选一）。
//
// 默认关闭，由审计管理员在「日志审计 → 审计设置 → 日志外发」里开启。
func StartLogForwarder() {
	logForwardOnce.Do(func() {
		logForwardQueue = make(chan model.AuditMessage, logForwardQueueSize)
		// 模型层只负责把结构化记录交出来；渲染（RFC5424 / JSON）与发送都在这里完成，
		// 避免 model → audit 循环，也避免序列化逻辑散落在两层。
		model.AddAuditForwarder(forwardToLogForward)
		reloadLogForwardConfig()
		go logForwardWorker()
	})
}

// reloadLogForwardConfig 重新读取外发配置（启动时与保存设置后调用）。
func reloadLogForwardConfig() {
	setting, err := model.GetAuditSetting()
	if err != nil {
		klog.Errorf("log forwarding disabled: failed to load audit setting: %v", err)
		return
	}
	logForwardConfigMu.Lock()
	logForwardConfig = setting.Forward
	logForwardConfigMu.Unlock()
}

// currentLogForwardConfig 返回当前生效的外发配置。
func currentLogForwardConfig() model.LogForwardSetting {
	logForwardConfigMu.RLock()
	defer logForwardConfigMu.RUnlock()
	return logForwardConfig
}

// forwardToLogForward 把一条审计记录投递到外发队列。非阻塞：队列满时丢弃并计数。
func forwardToLogForward(message model.AuditMessage) {
	if logForwardQueue == nil {
		return
	}
	// 访问日志不进外发：量大，且它本来走 stdout 采集。保持不变以免改变既有行为。
	if message.Kind == model.AuditKindAccess {
		return
	}
	if !currentLogForwardConfig().Enabled {
		return
	}

	select {
	case logForwardQueue <- message:
	default:
		logForwardMu.Lock()
		logForwardDropped++
		dropped := logForwardDropped
		logForwardMu.Unlock()
		// 每丢一条都记一行太吵，按 100 条打点。
		if dropped%100 == 1 {
			klog.Warningf("log forwarding queue is full, dropped %d audit message(s)", dropped)
		}
	}
}

// logForwardWorker 按当前方式把队列里的记录发出去。
func logForwardWorker() {
	for message := range logForwardQueue {
		config := currentLogForwardConfig()
		if !config.Enabled {
			continue
		}

		var err error
		switch config.Mode {
		case model.LogForwardModeKafka:
			err = sendKafka(config.Kafka, message)
		default:
			err = sendSyslog(config, message)
		}
		if err != nil {
			klog.Warningf("failed to forward audit record via %s: %v", logForwardModeLabel(), err)
		}
	}
}

// applyAuditSettingChanges 按库里最新的设置重载各外发/归档链路。
//
// 多副本下每个副本都要收敛到同一份设置（谁保存的不重要），见 setting_watcher.go。
func applyAuditSettingChanges() {
	reloadLogForwardConfig()
	reloadStdoutConfig()
	reloadArchiveConfig()
}

// LogForwardDroppedCount 返回被丢弃的外发消息数（供 /metrics 与排障查看）。
func LogForwardDroppedCount() int64 {
	logForwardMu.Lock()
	defer logForwardMu.Unlock()
	return logForwardDropped
}

// logForwardModeLabel 返回当前外发方式的标签值（/metrics 上区分 syslog 与 kafka）。
func logForwardModeLabel() string {
	mode := currentLogForwardConfig().Mode
	if mode == "" {
		return model.LogForwardModeSyslog
	}
	return mode
}
