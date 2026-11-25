package notification

import (
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"mime"
	"net"
	"net/smtp"
	"strconv"
	"strings"
	"time"

	"github.com/gzwxh/aerolink/pkg/model"
)

// ErrMailNotConfigured 在 SMTP 配置不完整或邮件通知已关闭时
// 仍请求发送邮件的情况下返回。
var ErrMailNotConfigured = errors.New("邮件通知未启用，或 SMTP 配置不完整")

const (
	// smtpDialTimeout 限制 TCP/TLS 握手；smtpTotalTimeout 限制
	// 整个 SMTP 会话，包括消息上传。
	smtpDialTimeout  = 10 * time.Second
	smtpTotalTimeout = 60 * time.Second
)

// smtpConfig 是一个已解析、可直接建立连接的 SMTP 配置。
type smtpConfig struct {
	host       string
	port       int
	username   string
	password   string
	from       string
	senderName string
	// tlsMode 取值为 "none"、"starttls" 或 "ssl"。
	tlsMode    string
	skipVerify bool
}

// loadSMTPConfig 读取已保存的配置并校验它。
func loadSMTPConfig() (*smtpConfig, error) {
	setting, err := model.GetNotificationSetting()
	if err != nil {
		return nil, err
	}
	if !setting.EmailEnabled {
		return nil, ErrMailNotConfigured
	}
	host := strings.TrimSpace(setting.SMTPHost)
	from := strings.TrimSpace(setting.SMTPFrom)
	if host == "" || from == "" {
		return nil, ErrMailNotConfigured
	}
	password, err := model.GetNotificationSMTPPassword()
	if err != nil {
		return nil, err
	}
	return &smtpConfig{
		host:       host,
		port:       setting.SMTPPort,
		username:   strings.TrimSpace(setting.SMTPUsername),
		password:   password,
		from:       from,
		senderName: strings.TrimSpace(setting.SMTPSenderName),
		tlsMode:    setting.SMTPTLS,
		skipVerify: setting.SMTPSkipVerify,
	}, nil
}

// SendTestMail 通过投递一封测试邮件来校验配置。
func SendTestMail(to string, subject, body string) error {
	to = strings.TrimSpace(to)
	if to == "" {
		return errors.New("收件人不能为空")
	}
	config, err := loadSMTPConfig()
	if err != nil {
		return err
	}
	return config.send([]string{to}, subject, body)
}

// send 向给定收件人投递一封纯文本邮件。
func (config *smtpConfig) send(to []string, subject, body string) error {
	address := net.JoinHostPort(config.host, strconv.Itoa(config.port))
	tlsConfig := &tls.Config{
		ServerName:         config.host,
		InsecureSkipVerify: config.skipVerify,
		MinVersion:         tls.VersionTLS12,
	}

	// SMTP 服务器不可达时绝不能让调用方一直挂住（登录路径也会经过这里）——
	// 因此对建连与整个会话都设置上限。
	dialer := &net.Dialer{Timeout: smtpDialTimeout}

	var client *smtp.Client
	if config.tlsMode == "ssl" {
		// 隐式 TLS（通常是 465 端口）。
		connection, err := tls.DialWithDialer(dialer, "tcp", address, tlsConfig)
		if err != nil {
			return fmt.Errorf("无法连接 SMTP 服务器 %s: %w", address, err)
		}
		_ = connection.SetDeadline(time.Now().Add(smtpTotalTimeout))
		client, err = smtp.NewClient(connection, config.host)
		if err != nil {
			_ = connection.Close()
			return err
		}
	} else {
		var err error
		conn, err := dialer.Dial("tcp", address)
		if err != nil {
			return fmt.Errorf("无法连接 SMTP 服务器 %s: %w", address, err)
		}
		_ = conn.SetDeadline(time.Now().Add(smtpTotalTimeout))
		client, err = smtp.NewClient(conn, config.host)
		if err != nil {
			_ = conn.Close()
			return fmt.Errorf("无法连接 SMTP 服务器 %s: %w", address, err)
		}
		if config.tlsMode == "starttls" {
			if err := client.StartTLS(tlsConfig); err != nil {
				_ = client.Close()
				return fmt.Errorf("STARTTLS 失败: %w", err)
			}
		}
	}
	defer func() { _ = client.Close() }()

	if config.username != "" {
		if err := client.Auth(smtp.PlainAuth("", config.username, config.password, config.host)); err != nil {
			return fmt.Errorf("SMTP 认证失败: %w", err)
		}
	}
	if err := client.Mail(config.from); err != nil {
		return err
	}
	for _, recipient := range to {
		if err := client.Rcpt(recipient); err != nil {
			return err
		}
	}
	writer, err := client.Data()
	if err != nil {
		return err
	}
	if _, err := writer.Write(config.message(to, subject, body)); err != nil {
		_ = writer.Close()
		return err
	}
	if err := writer.Close(); err != nil {
		return err
	}
	return client.Quit()
}

// message 渲染一封 UTF-8 安全的纯文本邮件（正文 base64、标题编码）。
func (config *smtpConfig) message(to []string, subject, body string) []byte {
	from := config.from
	if config.senderName != "" {
		from = fmt.Sprintf("%s <%s>", mime.QEncoding.Encode("UTF-8", config.senderName), config.from)
	}

	var builder strings.Builder
	builder.WriteString("From: " + from + "\r\n")
	builder.WriteString("To: " + strings.Join(to, ", ") + "\r\n")
	builder.WriteString("Subject: " + mime.QEncoding.Encode("UTF-8", subject) + "\r\n")
	builder.WriteString("Date: " + time.Now().Format(time.RFC1123Z) + "\r\n")
	builder.WriteString("MIME-Version: 1.0\r\n")
	builder.WriteString("Content-Type: text/plain; charset=UTF-8\r\n")
	builder.WriteString("Content-Transfer-Encoding: base64\r\n\r\n")

	normalized := strings.ReplaceAll(strings.ReplaceAll(body, "\r\n", "\n"), "\n", "\r\n")
	encoded := base64.StdEncoding.EncodeToString([]byte(normalized))
	for len(encoded) > 76 {
		builder.WriteString(encoded[:76] + "\r\n")
		encoded = encoded[76:]
	}
	builder.WriteString(encoded + "\r\n")
	return []byte(builder.String())
}
