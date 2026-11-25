package audit

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"

	"aerolink/pkg/model"
	"github.com/segmentio/kafka-go"
	"github.com/segmentio/kafka-go/sasl"
	"github.com/segmentio/kafka-go/sasl/plain"
	"github.com/segmentio/kafka-go/sasl/scram"
	"k8s.io/klog/v2"
)

// —— Kafka 外发 ——
//
// 只做「把一条审计记录作为 JSON 消息投到 Kafka」这一件事：协议、连接池、分区选择都交给
// kafka-go，本包负责消息形状与失败处理。
//
// 两个刻意的取舍：
//   - **消息体与 syslog 的 json 格式、ES 文档同构**（同一个 auditDocumentJSON）：消费方只要
//     认识一次字段名，就能同时读这三处；
//   - **key = 记录分类**（operation / login / password_change）：Kafka 按 key 分区，同类记录
//     因此落在同一分区、顺序稳定，排查时不会因为分区跳变而错乱。
//
// 写失败只记日志与计数（尽力而为）：审计外发的可用性不该反过来影响审计本身。

// kafkaBatchTimeout 是单条消息在 writer 批次里等待的时间上限。
//
// 我们的 worker 是**串行**的（一次一条），而 kafka-go 的 Writer 是按批发送的：批次不满时会等到
// BatchTimeout 才发。默认 1 秒会让每条记录白等一秒（审计记录量很小，没必要攒批），所以调小。
const kafkaBatchTimeout = 100 * time.Millisecond

// kafkaWriteAttempts 是一次 produce 的尝试次数上限。
//
// 不设大值：worker 是串行的，broker 长时间不可达时无限重试会把队列堵死（后续记录只能在队列里
// 排队直到被丢弃）。宁可快速失败 + 计数，让 /metrics 上的失败数提醒运维。
const kafkaWriteAttempts = 3

// kafkaWriter 是「把消息投到 Kafka」的最小接口。
//
// 抽成接口只为可测：协议与连接池交给 kafka-go，单测注入假实现就能断言消息的 value/key、
// 失败计数与队列行为，不需要真 broker。
type kafkaWriter interface {
	WriteMessages(ctx context.Context, messages ...kafka.Message) error
	Close() error
}

// kafkaWriterFactory 造一个 writer。测试里替换成假实现。
var kafkaWriterFactory = newKafkaWriter

// kafkaHolder 持有当前生效的 writer。
//
// 配置一变（broker / topic / 认证 / TLS 任一）就重建：连接参数改了不能沿用旧的连接池，
// 否则界面上改完设置、日志却还发到旧集群去——这是最难排查的一类问题。
var kafkaHolder struct {
	mu        sync.Mutex
	writer    kafkaWriter
	fingerprt string
}

// sendKafka 把一条审计记录作为 JSON 消息投到 Kafka。
func sendKafka(config model.KafkaSetting, message model.AuditMessage) error {
	value, ok := auditDocumentJSON(message)
	if !ok {
		// 未知分类：不发送，避免往 topic 里灌一条空消息。
		return nil
	}

	writer, err := kafkaWriterFor(config)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), logForwardWriteTimeout)
	defer cancel()

	return writer.WriteMessages(ctx, kafka.Message{
		// key 用分类：同类记录落同一分区、顺序稳定（见文件头注释）。
		Key:   []byte(message.Kind),
		Value: value,
		Time:  time.Now(),
	})
}

// kafkaWriterFor 返回与当前配置匹配的 writer，配置变了就重建。
func kafkaWriterFor(config model.KafkaSetting) (kafkaWriter, error) {
	fingerprint := kafkaConfigFingerprint(config)

	kafkaHolder.mu.Lock()
	defer kafkaHolder.mu.Unlock()

	if kafkaHolder.writer != nil && kafkaHolder.fingerprt == fingerprint {
		return kafkaHolder.writer, nil
	}

	writer, err := kafkaWriterFactory(config)
	if err != nil {
		return nil, err
	}
	if kafkaHolder.writer != nil {
		// 旧 writer 的关闭失败只记日志：新连接已经建好，不该因为它连配置都用不了。
		if err := kafkaHolder.writer.Close(); err != nil {
			klog.Warningf("failed to close the previous kafka writer: %v", err)
		}
	}
	kafkaHolder.writer = writer
	kafkaHolder.fingerprt = fingerprint
	return writer, nil
}

// kafkaConfigFingerprint 取配置指纹，用于判断「是否需要重建连接」。
//
// 包含密码（哈希后比较）：密码改了也必须换连接，否则认证失败的连接会被一直复用。
// 只保留哈希，避免把明文长期留在一个额外的字符串里。
func kafkaConfigFingerprint(config model.KafkaSetting) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%v|%s|%s|%s|%s|%t|%t",
		config.Brokers, config.Topic, config.SASLMechanism, config.Username,
		config.Password, config.UseTLS, config.InsecureSkipVerify)))
	return hex.EncodeToString(sum[:16])
}

// newKafkaWriter 按配置构造 kafka-go 的 writer。
func newKafkaWriter(config model.KafkaSetting) (kafkaWriter, error) {
	if len(config.Brokers) == 0 {
		return nil, errors.New("kafka brokers are required")
	}
	if config.Topic == "" {
		return nil, errors.New("kafka topic is required")
	}

	transport := &kafka.Transport{DialTimeout: logForwardWriteTimeout}
	if config.UseTLS {
		transport.TLS = kafkaTLSConfig(config)
	}
	if config.SASLMechanism != "" && config.SASLMechanism != model.KafkaSASLNone {
		mechanism, err := kafkaSASLMechanism(config)
		if err != nil {
			return nil, err
		}
		transport.SASL = mechanism
	}

	return &kafka.Writer{
		Addr:         kafka.TCP(config.Brokers...),
		Topic:        config.Topic,
		Balancer:     &kafka.Hash{},
		RequiredAcks: kafka.RequireOne,
		Transport:    transport,
		MaxAttempts:  kafkaWriteAttempts,
		BatchTimeout: kafkaBatchTimeout,
		WriteTimeout: logForwardWriteTimeout,
		ReadTimeout:  logForwardWriteTimeout,
	}, nil
}

// probeKafkaTarget 在保存后连一次 broker，把「这份配置到底能不能用」当场告诉管理员。
//
// 只连端口不够：认证 / 授权 / 主题不存在都要在 metadata 这一步才暴露。与归档侧一致，
// 探测失败**不阻止保存**（网络抖动、broker 临时维护都可能），只作为 warning 返回。
func probeKafkaTarget(ctx context.Context, config model.KafkaSetting) error {
	if len(config.Brokers) == 0 {
		return errors.New("kafka brokers are required")
	}

	dialer := &kafka.Dialer{Timeout: logForwardWriteTimeout}
	if config.UseTLS {
		dialer.TLS = kafkaTLSConfig(config)
	}
	if config.SASLMechanism != "" && config.SASLMechanism != model.KafkaSASLNone {
		mechanism, err := kafkaSASLMechanism(config)
		if err != nil {
			return err
		}
		dialer.SASLMechanism = mechanism
	}

	// 只探第一个 broker：后面的是故障切换选项，探到一个能用就说明配置本身没问题。
	conn, err := dialer.DialContext(ctx, "tcp", config.Brokers[0])
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close() }()

	if _, err := conn.Brokers(); err != nil {
		return fmt.Errorf("cannot read the cluster metadata: %w", err)
	}
	if config.Topic != "" {
		if _, err := conn.ReadPartitions(config.Topic); err != nil {
			return fmt.Errorf("cannot read the metadata of topic %q: %w", config.Topic, err)
		}
	}
	return nil
}

// kafkaTLSConfig 返回 Kafka 连接的 TLS 配置。
func kafkaTLSConfig(config model.KafkaSetting) *tls.Config {
	return &tls.Config{
		// #nosec G402 -- 自签证书场景由管理员显式开启（与 syslog / ES / 外部日志存储同级）。
		InsecureSkipVerify: config.InsecureSkipVerify,
		MinVersion:         tls.VersionTLS12,
	}
}

// kafkaSASLMechanism 按配置构造 SASL 机制。
func kafkaSASLMechanism(config model.KafkaSetting) (sasl.Mechanism, error) {
	username := config.Username
	password := string(config.Password)
	switch config.SASLMechanism {
	case model.KafkaSASLPlain:
		return plain.Mechanism{Username: username, Password: password}, nil
	case model.KafkaSASLScramSHA256:
		mechanism, err := scram.Mechanism(scram.SHA256, username, password)
		if err != nil {
			return nil, fmt.Errorf("failed to build the kafka scram-sha-256 mechanism: %w", err)
		}
		return mechanism, nil
	case model.KafkaSASLScramSHA512:
		mechanism, err := scram.Mechanism(scram.SHA512, username, password)
		if err != nil {
			return nil, fmt.Errorf("failed to build the kafka scram-sha-512 mechanism: %w", err)
		}
		return mechanism, nil
	default:
		return nil, fmt.Errorf("unsupported kafka sasl mechanism %q", config.SASLMechanism)
	}
}
