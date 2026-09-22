package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"time"
)

// smtpSink 是一个极简的 SMTP 收信服务，用来验证「邮件投递」这条链路真的走通了
// （连接、EHLO、MAIL/RCPT/DATA 全部按真实协议来一遍）。只在 -smtp 时启动。
type smtpSink struct {
	listener net.Listener
	mu       sync.Mutex
	messages []string
}

func newSMTPSink() (*smtpSink, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	sink := &smtpSink{listener: listener}
	go sink.serve()
	return sink, nil
}

func (s *smtpSink) port() int { return s.listener.Addr().(*net.TCPAddr).Port }

func (s *smtpSink) received() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.messages...)
}

func (s *smtpSink) close() { _ = s.listener.Close() }

func (s *smtpSink) serve() {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			return
		}
		go s.handle(conn)
	}
}

func (s *smtpSink) handle(conn net.Conn) {
	defer func() { _ = conn.Close() }()
	reader := bufio.NewReader(conn)
	write := func(line string) { _, _ = conn.Write([]byte(line + "\r\n")) }
	write("220 smtp-sink ready")

	var message bytes.Buffer
	inData := false
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return
		}
		trimmed := strings.TrimRight(line, "\r\n")
		if inData {
			if trimmed == "." {
				inData = false
				s.mu.Lock()
				s.messages = append(s.messages, message.String())
				s.mu.Unlock()
				message.Reset()
				write("250 OK queued")
				continue
			}
			message.WriteString(line)
			continue
		}
		switch strings.ToUpper(strings.SplitN(trimmed, " ", 2)[0]) {
		case "EHLO", "HELO":
			write("250-smtp-sink")
			write("250 HELP")
		case "DATA":
			inData = true
			write("354 Start mail input; end with <CRLF>.<CRLF>")
		case "QUIT":
			write("221 Bye")
			return
		default:
			write("250 OK")
		}
	}
}

// settingsPropagationDelay 是等「设置改动传播到所有副本」的时间。
//
// 多副本部署下设置读的是每个副本自己的缓存（TTL 10 秒），而请求经负载均衡可能落到
// 另一个副本上：改完设置立刻发请求，有概率读到旧值。留 12 秒余量。单副本时这段等待
// 只是稍慢，不会误判。
const settingsPropagationDelay = 12 * time.Second

// smtpChecks 把通知配置临时指向本地 sink，发一封测试邮件，确认真的收到了，再复原设置。
func (r *runner) smtpChecks() {
	fmt.Println("--- 通知投递（本地假 SMTP）---")
	sink, err := newSMTPSink()
	if err != nil {
		r.check("启动假 SMTP", false, err.Error())
		return
	}
	defer sink.close()

	original := r.fetchNotificationSetting()
	if original == nil {
		r.check("读取通知设置", false, "")
		return
	}
	setting := cloneMap(original)
	setting["emailEnabled"] = true
	setting["smtpHost"] = "127.0.0.1"
	setting["smtpPort"] = sink.port()
	setting["smtpTls"] = "none"
	setting["smtpUsername"] = ""
	setting["smtpFrom"] = "kite-smoke@local"
	setting["smtpSenderName"] = "AeroLink Smoke"
	status, raw := r.putNotificationSetting(setting)
	r.check("通知设置指向本地假 SMTP", status == 200, fmt.Sprintf("status=%d body=%s", status, truncate(string(raw), 120)))
	time.Sleep(settingsPropagationDelay)
	defer func() {
		if _, raw := r.putNotificationSetting(original); len(raw) == 0 {
			fmt.Println("   复原通知设置失败")
		}
	}()

	r.expectStatus("发送测试邮件", "POST", "/api/v1/admin/notification-setting/test-mail",
		map[string]any{"to": "sink@local"}, 200)

	delivered := ""
	for i := 0; i < 20; i++ {
		if messages := sink.received(); len(messages) > 0 {
			delivered = messages[0]
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	hasSubject := strings.Contains(strings.ToLower(delivered), "subject:")
	r.check("假 SMTP 收到该邮件", delivered != "", "")
	r.check("邮件带 Subject 头（模板渲染过）", hasSubject, truncate(delivered, 160))
}

// fakeLLM 是一个 OpenAI 兼容的最小端点：既能回文本，也能按需发起 tool_call，
// 用来把 AI 对话与「写类工具 + 用户确认」链路跑完整。只在 -ai 时启动。
type fakeLLM struct {
	server *httptest.Server
	mu     sync.Mutex
	tool   string
	args   string
	calls  int
}

func newFakeLLM() *fakeLLM {
	llm := &fakeLLM{}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/chat/completions", llm.handle)
	llm.server = httptest.NewServer(mux)
	return llm
}

func (l *fakeLLM) setTool(name string, args map[string]any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.tool = name
	l.args = marshalJSON(args)
}

func (l *fakeLLM) close() { l.server.Close() }

func (l *fakeLLM) handle(w http.ResponseWriter, req *http.Request) {
	var payload struct {
		Stream   bool `json:"stream"`
		Messages []struct {
			Role string `json:"role"`
		} `json:"messages"`
	}
	raw, _ := readAllLimited(req.Body)
	_ = json.Unmarshal(raw, &payload)

	hasToolResult := false
	for _, message := range payload.Messages {
		if message.Role == "tool" {
			hasToolResult = true
		}
	}
	l.mu.Lock()
	tool, args := l.tool, l.args
	l.calls++
	l.mu.Unlock()

	w.Header().Set("Content-Type", "text/event-stream")
	chunk := func(delta map[string]any, finish any) {
		body := mustJSON(map[string]any{
			"id": "chatcmpl-smoke", "object": "chat.completion.chunk", "created": 0, "model": "smoke",
			"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}},
		})
		_, _ = fmt.Fprintf(w, "data: %s\n\n", body)
	}

	if tool != "" && !hasToolResult {
		chunk(map[string]any{"role": "assistant", "content": "准备执行，请确认。"}, nil)
		chunk(map[string]any{"tool_calls": []any{map[string]any{
			"index": 0, "id": "call_smoke", "type": "function",
			"function": map[string]any{"name": tool, "arguments": args},
		}}}, "tool_calls")
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
		return
	}
	text := "SMOKE-LLM-OK"
	if hasToolResult {
		text = "SMOKE-TOOL-DONE"
	}
	chunk(map[string]any{"role": "assistant", "content": text}, nil)
	chunk(map[string]any{}, "stop")
	_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
}

// mustJSON 序列化假 LLM 用的常量数据。
//
// 这里的字段全是常量与字符串，序列化失败只可能是代码写错（不是运行时输入问题）：用一个固定的
// 错误载荷代替，让烟雾测试以“解析不出预期结构”的形式暴露出来，而不是静默发出一段空 body。
func mustJSON(value any) []byte {
	body, err := json.Marshal(value)
	if err != nil {
		return []byte(`{"error":"fake llm: failed to marshal the chunk"}`)
	}
	return body
}

var sessionIDPattern = regexp.MustCompile(`"session_id"\s*:\s*"([^"]+)"`)

// aiChecks 覆盖 AI 对话与写类工具（含用户确认与拒绝两条分支）。
func (r *runner) aiChecks() {
	fmt.Println("--- AI 对话与写类工具（内置假 LLM）---")
	llm := newFakeLLM()
	defer llm.close()

	original := r.fetchGeneralSetting()
	if original == nil {
		r.check("读取通用设置", false, "")
		return
	}
	setting := cloneMap(original)
	setting["aiAgentEnabled"] = true
	setting["aiApiKey"] = "sk-smoke-fake"
	setting["aiBaseUrl"] = llm.server.URL + "/v1"
	setting["aiProvider"] = "openai"
	status, raw := r.putGeneralSetting(setting)
	r.check("AI 指向本地假 LLM", status == 200, fmt.Sprintf("status=%d body=%s", status, truncate(string(raw), 140)))
	time.Sleep(settingsPropagationDelay)
	defer func() {
		if _, raw := r.putGeneralSetting(original); len(raw) == 0 {
			fmt.Println("   复原 AI 设置失败")
		}
	}()

	llm.setTool("", nil)
	status, raw, err := r.client.request("POST", r.clusterPath("/ai/chat"), map[string]any{
		"messages": []any{map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": "你好"}}}},
		"language": "zh",
		"page_context": map[string]any{
			"page": "/pods", "namespace": r.opts.namespace, "resource_name": "", "resource_kind": "",
		},
	})
	r.check("AI 对话返回模型内容", err == nil && status == 200 && strings.Contains(string(raw), "SMOKE-LLM-OK"),
		fmt.Sprintf("status=%d body=%s", status, truncate(string(raw), 160)))

	ns := r.opts.writeNamespace
	if ns == "" {
		r.check("AI 写类工具（跳过：需要 -write-namespace）", true, "")
		return
	}
	base := r.clusterPath("")
	tag := fmt.Sprintf("%d", time.Now().UnixNano()%1e6)
	cm := "smoke-ai-" + tag

	// 1) apply_resource → 确认 → 真的建出来了。
	doc := fmt.Sprintf("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: %s\n  namespace: %s\ndata:\n  from: ai\n", cm, ns)
	llm.setTool("apply_resource", map[string]any{"yaml": doc})
	sessionID := r.chatAndGetSession(ns, "帮我在 "+ns+" 建一个 ConfigMap "+cm)
	if sessionID == "" {
		r.check("写类工具触发确认", false, "没有拿到 session_id")
		return
	}
	r.check("写类工具触发确认", true, "")
	r.expectStatus("确认执行（confirm）", "POST", r.clusterPath("/ai/continue"),
		map[string]any{"sessionId": sessionID, "action": "confirm"}, 200)
	time.Sleep(2 * time.Second)
	status, _, _ = r.client.request("GET", fmt.Sprintf("%s/configmaps/%s/%s", base, ns, cm), nil)
	r.check("确认后资源被创建", status == 200, fmt.Sprintf("status=%d", status))

	// 2) delete_resource → 确认 → 真的删掉了。
	llm.setTool("delete_resource", map[string]any{"kind": "ConfigMap", "name": cm, "namespace": ns})
	sessionID = r.chatAndGetSession(ns, "把 "+cm+" 删掉")
	if sessionID != "" {
		r.expectStatus("确认删除（confirm）", "POST", r.clusterPath("/ai/continue"),
			map[string]any{"sessionId": sessionID, "action": "confirm"}, 200)
		time.Sleep(2 * time.Second)
		status, _, _ = r.client.request("GET", fmt.Sprintf("%s/configmaps/%s/%s", base, ns, cm), nil)
		r.check("确认后资源被删除", status == 404, fmt.Sprintf("status=%d", status))
	} else {
		r.check("删除触发确认", false, "没有拿到 session_id")
	}

	// 3) apply_resource → 拒绝 → 不允许创建。
	denied := "smoke-ai-deny-" + tag
	doc = fmt.Sprintf("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: %s\n  namespace: %s\ndata:\n  from: ai\n", denied, ns)
	llm.setTool("apply_resource", map[string]any{"yaml": doc})
	sessionID = r.chatAndGetSession(ns, "再建一个 ConfigMap "+denied)
	if sessionID != "" {
		r.expectStatus("拒绝执行（deny）", "POST", r.clusterPath("/ai/continue"),
			map[string]any{"sessionId": sessionID, "action": "deny"}, 200)
		time.Sleep(2 * time.Second)
		status, _, _ = r.client.request("GET", fmt.Sprintf("%s/configmaps/%s/%s", base, ns, denied), nil)
		r.check("拒绝后资源未被创建", status == 404, fmt.Sprintf("status=%d", status))
	} else {
		r.check("拒绝分支拿到 session_id", false, "")
	}
}

func (r *runner) chatAndGetSession(namespace, prompt string) string {
	status, raw, err := r.client.request("POST", r.clusterPath("/ai/chat"), map[string]any{
		"messages": []any{map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": prompt}}}},
		"language": "zh",
		"page_context": map[string]any{
			"page": "/configmaps", "namespace": namespace, "resource_name": "", "resource_kind": "",
		},
	})
	if err != nil || status != 200 {
		return ""
	}
	match := sessionIDPattern.FindStringSubmatch(string(raw))
	if len(match) < 2 {
		return ""
	}
	return match[1]
}

func cloneMap(source map[string]any) map[string]any {
	out := make(map[string]any, len(source))
	for key, value := range source {
		out[key] = value
	}
	return out
}
