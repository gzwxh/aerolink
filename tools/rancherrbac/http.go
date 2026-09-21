package main

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// httpClient 是一个够用的 JSON 客户端：迁移工具只在两台服务之间搬数据，
// 不需要 SDK。它刻意不打印请求头——两个 token 都是长期有效的凭据，不能进日志。
type httpClient struct {
	base    string
	headers map[string]string
	client  *http.Client
	dumpDir string
	verbose bool
}

func newHTTPClient(base string, headers map[string]string, insecure bool, timeout time.Duration, verbose bool, dumpDir string) *httpClient {
	transport := &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: insecure}, //nolint:gosec // -insecure 是显式开关，服务于自签证书的内网 Rancher
	}
	return &httpClient{
		base:    strings.TrimRight(base, "/"),
		headers: headers,
		client:  &http.Client{Timeout: timeout, Transport: transport},
		dumpDir: dumpDir,
		verbose: verbose,
	}
}

type httpStatusError struct {
	Method string
	URL    string
	Status int
	Body   string
}

func (e *httpStatusError) Error() string {
	return fmt.Sprintf("%s %s: HTTP %d: %s", e.Method, e.URL, e.Status, truncate(e.Body, 400))
}

// do 发起请求并返回响应体；>=400 一律返回错误（带上状态码与响应片段）。
func (c *httpClient) do(method, path string, body any) ([]byte, error) {
	url := path
	if !strings.HasPrefix(path, "http://") && !strings.HasPrefix(path, "https://") {
		url = c.base + path
	}
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("encode request body: %w", err)
		}
		reader = strings.NewReader(string(encoded))
	}
	request, err := http.NewRequest(method, url, reader)
	if err != nil {
		return nil, err
	}
	for key, value := range c.headers {
		request.Header.Set(key, value)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	request.Header.Set("Accept", "application/json")

	if c.verbose {
		fmt.Printf("  → %s %s\n", method, url)
	}

	response, err := c.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("%s %s: %w", method, url, err)
	}
	defer func() { _ = response.Body.Close() }()
	payload, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, fmt.Errorf("read %s %s: %w", method, url, err)
	}
	if response.StatusCode >= 400 {
		return payload, &httpStatusError{
			Method: method,
			URL:    url,
			Status: response.StatusCode,
			Body:   string(payload),
		}
	}
	return payload, nil
}

func (c *httpClient) getJSON(path string, out any) error {
	payload, err := c.do(http.MethodGet, path, nil)
	if err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(payload, out); err != nil {
		return fmt.Errorf("decode %s: %w", path, err)
	}
	return nil
}

func truncate(text string, max int) string {
	runes := []rune(strings.TrimSpace(text))
	if len(runes) <= max {
		return string(runes)
	}
	return string(runes[:max]) + "…"
}

// jsonObject 是 Rancher 返回对象的最小表示。Rancher 的字段随版本变化（Norman 与
// Steve 两套 API 的字段名就不一致），因此这里按需取值而不是绑定结构体。
type jsonObject map[string]any

func (o jsonObject) str(keys ...string) string {
	for _, key := range keys {
		value, ok := o[key]
		if !ok {
			continue
		}
		if text, ok := value.(string); ok && strings.TrimSpace(text) != "" {
			return text
		}
	}
	return ""
}

func (o jsonObject) obj(key string) jsonObject {
	if nested, ok := o[key].(map[string]any); ok {
		return jsonObject(nested)
	}
	return nil
}

func (o jsonObject) strings(key string) []string {
	raw, ok := o[key].([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		if text, ok := item.(string); ok && strings.TrimSpace(text) != "" {
			out = append(out, text)
		}
	}
	return out
}
