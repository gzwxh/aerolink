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

	"github.com/zxh326/kite/pkg/model"
)

// ErrMailNotConfigured is returned when a mail is requested while the SMTP
// configuration is incomplete or mail notifications are switched off.
var ErrMailNotConfigured = errors.New("邮件通知未启用，或 SMTP 配置不完整")

const (
	// smtpDialTimeout bounds the TCP/TLS handshake; smtpTotalTimeout bounds
	// the whole SMTP conversation including message upload.
	smtpDialTimeout  = 10 * time.Second
	smtpTotalTimeout = 60 * time.Second
)

// smtpConfig is a resolved SMTP configuration ready to open a connection.
type smtpConfig struct {
	host       string
	port       int
	username   string
	password   string
	from       string
	senderName string
	// tlsMode is one of "none", "starttls" or "ssl".
	tlsMode    string
	skipVerify bool
}

// loadSMTPConfig reads the stored configuration and validates it.
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

// SendTestMail validates the configuration by delivering a test message.
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

// send delivers one plain text message to the given recipients.
func (config *smtpConfig) send(to []string, subject, body string) error {
	address := net.JoinHostPort(config.host, strconv.Itoa(config.port))
	tlsConfig := &tls.Config{
		ServerName:         config.host,
		InsecureSkipVerify: config.skipVerify,
		MinVersion:         tls.VersionTLS12,
	}

	// An unreachable SMTP server must never hang the caller (login paths run
	// through here) — bound both the dial and the whole conversation.
	dialer := &net.Dialer{Timeout: smtpDialTimeout}

	var client *smtp.Client
	if config.tlsMode == "ssl" {
		// Implicit TLS (usually port 465).
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

// message renders a UTF-8 safe plain text mail (base64 body, encoded subject).
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
