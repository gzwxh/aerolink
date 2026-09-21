package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/cookiejar"
	"strings"
	"time"
)

// client 是对着跑起来的实例发请求的最小客户端：会话靠 cookie（服务端登录后种
// auth_token），所以只需要一个带 cookie jar 的 http.Client。
type client struct {
	baseURL string
	http    *http.Client
}

func newClient(baseURL string, timeout time.Duration) (*client, error) {
	jar, err := cookiejar.New(nil)
	if err != nil {
		return nil, err
	}
	return &client{
		baseURL: strings.TrimRight(baseURL, "/"),
		http:    &http.Client{Jar: jar, Timeout: timeout},
	}, nil
}

// request 发一次 JSON 请求。body 为 nil 时不带请求体。
// 返回状态码与响应体；HTTP 错误码不算 error，交给调用方判断。
func (c *client) request(method, path string, body any) (int, []byte, error) {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, c.baseURL+path, reader)
	if err != nil {
		return 0, nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return resp.StatusCode, nil, err
	}
	return resp.StatusCode, raw, nil
}

// uploadFile 以 multipart 提交一个文件（容器文件上传接口要求）。
func (c *client) uploadFile(path, filename string, content []byte) (int, []byte, error) {
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	part, err := writer.CreateFormFile("file", filename)
	if err != nil {
		return 0, nil, err
	}
	if _, err := part.Write(content); err != nil {
		return 0, nil, err
	}
	if err := writer.Close(); err != nil {
		return 0, nil, err
	}

	req, err := http.NewRequest(http.MethodPut, c.baseURL+path, &buf)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return resp.StatusCode, nil, err
	}
	return resp.StatusCode, raw, nil
}

// readAllLimited 读取完整请求体，带上限，避免假服务被超大请求打爆。
func readAllLimited(reader io.Reader) ([]byte, error) {
	return io.ReadAll(io.LimitReader(reader, maxResponseBytes))
}

// listItems 从列表响应里取出条目。服务端在不同接口上用过裸数组、items、
// users/apiKeys 之类的包装，这里统一兜住，避免脚本因为包装层变化而误报。
func listItems(body []byte) ([]map[string]any, error) {
	var decoded any
	if err := json.Unmarshal(body, &decoded); err != nil {
		return nil, fmt.Errorf("响应不是合法 JSON: %w", err)
	}
	switch value := decoded.(type) {
	case []any:
		return toMapSlice(value), nil
	case map[string]any:
		for _, key := range []string{"items", "data", "list", "results", "users", "apiKeys", "subscriptions"} {
			if items, ok := value[key].([]any); ok {
				return toMapSlice(items), nil
			}
		}
		for _, item := range value {
			if items, ok := item.([]any); ok {
				return toMapSlice(items), nil
			}
		}
	}
	return nil, nil
}

func toMapSlice(values []any) []map[string]any {
	out := make([]map[string]any, 0, len(values))
	for _, value := range values {
		if m, ok := value.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

// objectName 取条目名：多数接口把 name 平铺在顶层，原始对象则在 metadata.name。
func objectName(item map[string]any) string {
	if name, ok := item["name"].(string); ok && name != "" {
		return name
	}
	if meta, ok := item["metadata"].(map[string]any); ok {
		if name, ok := meta["name"].(string); ok {
			return name
		}
	}
	return ""
}

// fieldString 取顶层字符串字段，缺失时返回空串。
func fieldString(item map[string]any, key string) string {
	if value, ok := item[key].(string); ok {
		return value
	}
	return ""
}

// nestedString 取 a.b 这样的嵌套字符串字段（客户端把容器/端口等放在 spec 里）。
func nestedString(item map[string]any, keys ...string) string {
	var current any = item
	for _, key := range keys {
		m, ok := current.(map[string]any)
		if !ok {
			return ""
		}
		current = m[key]
	}
	value, _ := current.(string)
	return value
}
