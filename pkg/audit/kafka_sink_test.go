package audit

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"

	"aerolink/pkg/model"
	"github.com/segmentio/kafka-go"
)

// fakeKafkaWriter 记录投递的消息，供断言 value/key；错误可注入。
//
// 生产路径用的是 kafka-go 的 *kafka.Writer（协议与连接池都交给它），这里替换掉它，
// 让单测不需要真 broker 也能钉住「发出去的消息长什么样、失败怎么算」。
type fakeKafkaWriter struct {
	mu       sync.Mutex
	messages []kafka.Message
	err      error
	closed   bool
}

func (f *fakeKafkaWriter) WriteMessages(_ context.Context, messages ...kafka.Message) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return f.err
	}
	f.messages = append(f.messages, messages...)
	return nil
}

func (f *fakeKafkaWriter) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closed = true
	return nil
}

func (f *fakeKafkaWriter) snapshot() []kafka.Message {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]kafka.Message(nil), f.messages...)
}

// swapKafkaWriterFactory 替换 writer 工厂并清空 holder 里可能残留的 writer。
func swapKafkaWriterFactory(t *testing.T, factory func(model.KafkaSetting) (kafkaWriter, error)) {
	t.Helper()

	originalFactory := kafkaWriterFactory
	kafkaHolder.mu.Lock()
	originalWriter, originalFingerprint := kafkaHolder.writer, kafkaHolder.fingerprt
	kafkaHolder.writer, kafkaHolder.fingerprt = nil, ""
	kafkaHolder.mu.Unlock()

	kafkaWriterFactory = factory
	t.Cleanup(func() {
		kafkaWriterFactory = originalFactory
		kafkaHolder.mu.Lock()
		kafkaHolder.writer, kafkaHolder.fingerprt = originalWriter, originalFingerprint
		kafkaHolder.mu.Unlock()
	})
}

func testKafkaSetting() model.KafkaSetting {
	return model.KafkaSetting{
		Brokers:       []string{"kafka-1:9092", "kafka-2:9092"},
		Topic:         "aerolink-audit",
		SASLMechanism: model.KafkaSASLNone,
		UseTLS:        true,
	}
}

// 消息体必须与 ES / parquet / syslog 的 json 同构，key 用记录分类（同类落同一分区）。
func TestSendKafkaPublishesAuditDocument(t *testing.T) {
	fake := &fakeKafkaWriter{}
	swapKafkaWriterFactory(t, func(model.KafkaSetting) (kafkaWriter, error) { return fake, nil })

	message := model.AuditMessage{
		Kind:          model.AuditKindOperation,
		ResourceType:  "deployment",
		ResourceName:  "nginx",
		OperationType: "update",
		Success:       true,
		OperatorName:  "alice",
		ClientIP:      "10.0.0.1",
	}
	if err := sendKafka(testKafkaSetting(), message); err != nil {
		t.Fatalf("sendKafka() error = %v", err)
	}

	sent := fake.snapshot()
	if len(sent) != 1 {
		t.Fatalf("messages = %d, want 1", len(sent))
	}
	if string(sent[0].Key) != model.AuditKindOperation {
		t.Errorf("message key = %q, want %q", sent[0].Key, model.AuditKindOperation)
	}

	var parsed map[string]any
	if err := json.Unmarshal(sent[0].Value, &parsed); err != nil {
		t.Fatalf("message value is not valid JSON: %v (%q)", err, sent[0].Value)
	}
	if parsed["kind"] != ESKindAuditHistory {
		t.Errorf("kind = %v, want %v", parsed["kind"], ESKindAuditHistory)
	}
	if parsed["resource_name"] != "nginx" || parsed["operator_name"] != "alice" {
		t.Errorf("document fields = %v", parsed)
	}
}

// 未知分类不投递：往 topic 里灌一条空消息只会让消费侧多一条脏数据。
func TestSendKafkaSkipsUnknownKind(t *testing.T) {
	fake := &fakeKafkaWriter{}
	swapKafkaWriterFactory(t, func(model.KafkaSetting) (kafkaWriter, error) { return fake, nil })

	if err := sendKafka(testKafkaSetting(), model.AuditMessage{Kind: "unknown"}); err != nil {
		t.Fatalf("sendKafka() error = %v", err)
	}
	if got := len(fake.snapshot()); got != 0 {
		t.Errorf("messages = %d, want 0", got)
	}
}

// 写失败要向调用方暴露（worker 据此记日志 + 计数），不能被吞掉。
func TestSendKafkaReturnsWriterError(t *testing.T) {
	fake := &fakeKafkaWriter{err: errors.New("broker is down")}
	swapKafkaWriterFactory(t, func(model.KafkaSetting) (kafkaWriter, error) { return fake, nil })

	if err := sendKafka(testKafkaSetting(), model.AuditMessage{Kind: model.AuditKindLogin}); err == nil {
		t.Fatal("sendKafka() returned nil, want the writer error")
	}
}

// 连接参数变了必须重建 writer（沿用旧连接池会把日志发到旧集群去），配置没变则复用。
func TestKafkaWriterIsRebuiltOnlyWhenConfigChanges(t *testing.T) {
	var built int
	fake := &fakeKafkaWriter{}
	swapKafkaWriterFactory(t, func(model.KafkaSetting) (kafkaWriter, error) {
		built++
		return fake, nil
	})

	config := testKafkaSetting()
	message := model.AuditMessage{Kind: model.AuditKindLogin}

	for range 3 {
		if err := sendKafka(config, message); err != nil {
			t.Fatalf("sendKafka() error = %v", err)
		}
	}
	if built != 1 {
		t.Fatalf("writer built %d times, want 1 (同一份配置应复用同一个 writer)", built)
	}

	// 换密码也必须换连接：否则认证失败的连接会被一直复用。
	moved := config
	moved.Password = model.SecretString("new-password")
	if err := sendKafka(moved, message); err != nil {
		t.Fatalf("sendKafka() error = %v", err)
	}
	if built != 2 {
		t.Fatalf("writer built %d times, want 2 (配置变了必须重建)", built)
	}
	if !fake.closed {
		t.Error("旧 writer 在重建时应当被关闭")
	}
}

// SASL 机制只接受 none / plain / scram-sha-256 / scram-sha-512（取值由模型层校验，这里钉住映射）。
func TestKafkaSASLMechanismMapping(t *testing.T) {
	cases := []struct {
		mechanism string
		wantErr   bool
	}{
		{model.KafkaSASLPlain, false},
		{model.KafkaSASLScramSHA256, false},
		{model.KafkaSASLScramSHA512, false},
		{model.KafkaSASLNone, true},
		{"oauthbearer", true},
	}
	for _, tc := range cases {
		t.Run(tc.mechanism, func(t *testing.T) {
			config := testKafkaSetting()
			config.SASLMechanism = tc.mechanism
			config.Username = "aerolink"
			config.Password = model.SecretString("secret")

			_, err := kafkaSASLMechanism(config)
			if tc.wantErr && err == nil {
				t.Fatalf("kafkaSASLMechanism(%q) returned nil, want error", tc.mechanism)
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("kafkaSASLMechanism(%q) error = %v", tc.mechanism, err)
			}
		})
	}
}
