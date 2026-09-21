package audit

import (
	"testing"
	"time"

	"github.com/zxh326/kite/pkg/model"
)

// swapLogForwardQueue 换掉外发链路的全局状态（队列 / 配置 / 丢弃计数）。
//
// 直接改包级变量而不是走 StartLogForwarder：那个入口有 sync.Once、还会注册外发回调并起
// 常驻 goroutine，单测里没必要。测试之间靠 t.Cleanup 还原（同包测试默认串行）。
func swapLogForwardQueue(t *testing.T, config model.LogForwardSetting, queueSize int) chan model.AuditMessage {
	t.Helper()

	originalQueue := logForwardQueue
	originalConfig := currentLogForwardConfig()

	logForwardMu.Lock()
	logForwardDropped = 0
	logForwardMu.Unlock()
	queue := make(chan model.AuditMessage, queueSize)
	logForwardQueue = queue
	logForwardConfigMu.Lock()
	logForwardConfig = config
	logForwardConfigMu.Unlock()

	t.Cleanup(func() {
		logForwardQueue = originalQueue
		logForwardConfigMu.Lock()
		logForwardConfig = originalConfig
		logForwardConfigMu.Unlock()
		logForwardMu.Lock()
		logForwardDropped = 0
		logForwardMu.Unlock()
	})

	return queue
}

func kafkaForwardConfig() model.LogForwardSetting {
	return model.LogForwardSetting{
		Enabled: true,
		Mode:    model.LogForwardModeKafka,
		Kafka: model.KafkaSetting{
			Brokers:       []string{"kafka:9092"},
			Topic:         "kite-audit",
			SASLMechanism: model.KafkaSASLNone,
			UseTLS:        true,
		},
	}
}

// 访问日志不进外发：量大，且它本来就走 stdout 采集（保持既有行为）。
func TestForwardToLogForwardSkipsAccessLogs(t *testing.T) {
	queue := swapLogForwardQueue(t, kafkaForwardConfig(), 4)

	forwardToLogForward(model.AuditMessage{Kind: model.AuditKindAccess})
	if got := len(queue); got != 0 {
		t.Errorf("访问日志不该进外发队列, queue depth = %d", got)
	}
	if dropped := LogForwardDroppedCount(); dropped != 0 {
		t.Errorf("dropped = %d, want 0", dropped)
	}
}

// 关闭外发时直接短路：不排队、不计数（关闭不是「丢弃」）。
func TestForwardToLogForwardSkipsWhenDisabled(t *testing.T) {
	config := kafkaForwardConfig()
	config.Enabled = false
	queue := swapLogForwardQueue(t, config, 4)

	forwardToLogForward(model.AuditMessage{Kind: model.AuditKindOperation})
	if got := len(queue); got != 0 {
		t.Errorf("关闭时不该排队, queue depth = %d", got)
	}
	if dropped := LogForwardDroppedCount(); dropped != 0 {
		t.Errorf("dropped = %d, want 0", dropped)
	}
}

// 队列满是**非阻塞丢弃**（绝不回压写库路径），并且要计数供 /metrics 观察。
func TestForwardToLogForwardDropsWhenQueueIsFull(t *testing.T) {
	queue := swapLogForwardQueue(t, kafkaForwardConfig(), 1)

	for range 4 {
		forwardToLogForward(model.AuditMessage{Kind: model.AuditKindLogin})
	}

	if got := len(queue); got != 1 {
		t.Errorf("queue depth = %d, want 1 (容量已满)", got)
	}
	if dropped := LogForwardDroppedCount(); dropped != 3 {
		t.Errorf("dropped = %d, want 3", dropped)
	}
}

// /metrics 上的标签随当前方式变化，运维才分得清是哪条链路在丢。
func TestLogForwardModeLabel(t *testing.T) {
	cases := []struct {
		mode string
		want string
	}{
		{model.LogForwardModeKafka, model.LogForwardModeKafka},
		{model.LogForwardModeSyslog, model.LogForwardModeSyslog},
		// 升级前的行没有 mode：按历史行为当 syslog（与 worker 的 default 分支一致）。
		{"", model.LogForwardModeSyslog},
	}
	for _, tc := range cases {
		swapLogForwardQueue(t, model.LogForwardSetting{Enabled: true, Mode: tc.mode}, 1)
		if got := logForwardModeLabel(); got != tc.want {
			t.Errorf("logForwardModeLabel(mode=%q) = %q, want %q", tc.mode, got, tc.want)
		}
	}
}

// worker 按当前方式分派：mode=kafka 时消息必须走到 Kafka 通道。
func TestLogForwardWorkerRoutesToKafka(t *testing.T) {
	fake := &fakeKafkaWriter{}
	swapKafkaWriterFactory(t, func(model.KafkaSetting) (kafkaWriter, error) { return fake, nil })

	queue := swapLogForwardQueue(t, kafkaForwardConfig(), 4)

	done := make(chan struct{})
	go func() {
		logForwardWorker()
		close(done)
	}()
	// LIFO：先关队列并等 worker 退出，再让 swapLogForwardQueue 还原全局状态。
	t.Cleanup(func() {
		close(queue)
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Error("worker 没有在队列关闭后退出")
		}
	})

	forwardToLogForward(model.AuditMessage{Kind: model.AuditKindPasswordChange, Username: "alice"})

	deadline := time.Now().Add(2 * time.Second)
	for len(fake.snapshot()) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}

	sent := fake.snapshot()
	if len(sent) != 1 {
		t.Fatalf("messages = %d, want 1", len(sent))
	}
	if string(sent[0].Key) != model.AuditKindPasswordChange {
		t.Errorf("message key = %q, want %q", sent[0].Key, model.AuditKindPasswordChange)
	}
}
