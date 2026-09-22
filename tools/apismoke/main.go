// apismoke 是一个「对着跑起来的实例点一遍」的回归脚本：登录、把各功能面的读路径
// 走一遍，可选地再在指定的命名空间里做一遍写路径与删除，最后报告 PASS/FAIL。
//
// 用途是换数据库版本（例如 PostgreSQL 12 → 12.22/14+）、大改动上线前，用一条命令
// 覆盖比手点页面更多的接口，并把服务端日志里的 SQL 错误一并扫一遍。
//
// 设计取舍：
//   - 读检查默认全跑；写检查必须显式给 -write-namespace，且只操作 smoke- 前缀的对象，
//     结束时清理并核对命名空间是否恢复原样；
//   - 需要外部依赖的检查（AI 模型、SMTP 服务器）自带假实现（见 fakes.go），
//     只有显式打开时才跑，且跑完会把被改动的设置复原；
//   - 任何失败都会让退出码非 0，方便接进脚本或 CI（但它需要一个真实实例，所以
//     不进 make test）。
//
// 用法见 docs/dev/plans/2026-09-20-pg12-now-and-upgrade-path.md 的「回归脚本」一节。
package main

import (
	"flag"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/zxh326/kite/pkg/common"
)

// maxResponseBytes 限制单次响应读取量：本工具只做存在性/字段校验，不需要完整大对象。
const maxResponseBytes = 4 << 20

type options struct {
	baseURL        string
	username       string
	password       string
	cluster        string
	namespace      string
	writeNamespace string
	image          string
	logFile        string
	timeout        time.Duration
	runAI          bool
	runSMTP        bool
	verbose        bool
}

type result struct {
	name   string
	ok     bool
	detail string
}

type runner struct {
	opts    *options
	client  *client
	results []result
}

// check 记录并打印一条断言结果。
func (r *runner) check(name string, ok bool, detail string) {
	r.results = append(r.results, result{name: name, ok: ok, detail: detail})
	status := "PASS"
	if !ok {
		status = "FAIL"
	}
	line := fmt.Sprintf("%-4s %s", status, name)
	if !ok && detail != "" {
		line += "  -> " + truncate(detail, 160)
	} else if r.opts.verbose && detail != "" {
		line += "  (" + truncate(detail, 100) + ")"
	}
	fmt.Println(line)
}

// expectStatus 是最常用的断言：状态码在期望集合里就算通过。
func (r *runner) expectStatus(name, method, path string, body any, want ...int) {
	status, raw, err := r.client.request(method, path, body)
	if err != nil {
		r.check(name, false, err.Error())
		return
	}
	ok := false
	for _, code := range want {
		if status == code {
			ok = true
			break
		}
	}
	r.check(name, ok, fmt.Sprintf("status=%d body=%s", status, truncate(string(raw), 120)))
}

func main() {
	var opts options
	flag.StringVar(&opts.baseURL, "base-url", "http://127.0.0.1:8080", "实例地址")
	flag.StringVar(&opts.username, "username", common.Getenv("SMOKE_USER"), "管理员用户名（默认取 AEROLINK_SMOKE_USER）")
	flag.StringVar(&opts.password, "password", common.Getenv("SMOKE_PASSWORD"), "口令（默认取 AEROLINK_SMOKE_PASSWORD）")
	flag.StringVar(&opts.cluster, "cluster", "", "集群名（默认取列表里的第一个）")
	flag.StringVar(&opts.namespace, "namespace", "", "只读检查用的命名空间（默认取集群里第一个非系统命名空间）")
	flag.StringVar(&opts.writeNamespace, "write-namespace", "", "写检查的命名空间；给了才会跑写检查，请用一个可以随便破坏的命名空间")
	flag.StringVar(&opts.image, "image", "", "写检查用的容器镜像（默认用一个集群里常见的镜像）")
	flag.StringVar(&opts.logFile, "log-file", "", "服务端日志文件；给了就扫描其中的 SQL 错误（多副本可用逗号分隔多个）")
	flag.DurationVar(&opts.timeout, "timeout", 120*time.Second, "单次请求超时")
	flag.BoolVar(&opts.runAI, "ai", false, "跑 AI 检查（会启动内置假 LLM，并临时改写通用设置里的 aiBaseUrl/aiApiKey）")
	flag.BoolVar(&opts.runSMTP, "smtp", false, "跑通知投递检查（会启动内置假 SMTP，并临时改写通知设置）")
	flag.BoolVar(&opts.verbose, "v", false, "打印每条检查的细节")
	flag.Parse()

	if opts.username == "" || opts.password == "" {
		fmt.Fprintln(os.Stderr, "缺少凭据：请用 -username/-password 或环境变量 AEROLINK_SMOKE_USER/AEROLINK_SMOKE_PASSWORD")
		os.Exit(2)
	}

	c, err := newClient(opts.baseURL, opts.timeout)
	if err != nil {
		fmt.Fprintln(os.Stderr, "初始化客户端失败:", err)
		os.Exit(2)
	}
	r := &runner{opts: &opts, client: c}

	if err := r.run(); err != nil {
		fmt.Fprintln(os.Stderr, "执行中断:", err)
	}

	failed := 0
	for _, item := range r.results {
		if !item.ok {
			failed++
		}
	}
	fmt.Printf("\n=== 汇总：%d/%d 通过 ===\n", len(r.results)-failed, len(r.results))
	if failed > 0 {
		for _, item := range r.results {
			if !item.ok {
				fmt.Printf("FAIL: %s -> %s\n", item.name, truncate(item.detail, 200))
			}
		}
		os.Exit(1)
	}
}

func (r *runner) run() error {
	fmt.Printf("目标 %s，集群 %q，命名空间 %q\n", r.opts.baseURL, r.opts.cluster, r.opts.namespace)

	// 环境准备：登录 + 选中集群/命名空间（这些不是检查项本身，失败就直接中断）。
	if err := r.prepare(); err != nil {
		return err
	}

	r.readOnlyChecks()
	if r.opts.runSMTP {
		r.smtpChecks()
	}
	if r.opts.runAI {
		r.aiChecks()
	}
	if r.opts.writeNamespace != "" {
		r.writeChecks()
	}
	r.scanLog()
	return nil
}

func (r *runner) prepare() error {
	status, raw, err := r.client.request("POST", "/api/auth/login/password", map[string]string{
		"username": r.opts.username,
		"password": r.opts.password,
	})
	if err != nil {
		return err
	}
	if status != http.StatusOK && status != http.StatusNoContent {
		return fmt.Errorf("登录失败：status=%d %s", status, truncate(string(raw), 200))
	}
	r.check("登录", true, fmt.Sprintf("status=%d", status))
	r.expectStatus("会话可用（/api/auth/user）", "GET", "/api/auth/user", nil, 200)

	if r.opts.cluster == "" {
		_, raw, err = r.client.request("GET", "/api/v1/admin/clusters/", nil)
		if err != nil {
			return err
		}
		items, err := listItems(raw)
		if err != nil {
			return err
		}
		for _, item := range items {
			if name := objectName(item); name != "" {
				r.opts.cluster = name
				break
			}
		}
	}
	if r.opts.cluster == "" {
		return fmt.Errorf("没有找到可用集群")
	}
	if r.opts.namespace == "" {
		_, raw, err = r.client.request("GET", r.clusterPath("/namespaces/_all"), nil)
		if err != nil {
			return err
		}
		items, _ := listItems(raw)
		names := make([]string, 0, len(items))
		for _, item := range items {
			name := objectName(item)
			if name == "" || strings.HasPrefix(name, "kube-") {
				continue
			}
			names = append(names, name)
		}
		sort.Strings(names)
		if len(names) > 0 {
			r.opts.namespace = names[0]
		}
	}
	if r.opts.namespace == "" {
		return fmt.Errorf("没有找到可用命名空间")
	}
	fmt.Printf("实际使用：集群 %s，命名空间 %s\n\n", r.opts.cluster, r.opts.namespace)
	return nil
}

// clusterPath 拼出集群作用域下的路径。
func (r *runner) clusterPath(suffix string) string {
	return "/api/v1/_clusters/" + r.opts.cluster + suffix
}

// scanLog 扫描服务端日志里的数据库错误。换数据库版本时，这一项比任何接口断言
// 都更灵敏：13+ 语法、缺函数、缺权限都会在这里冒出来。多副本场景下日志是分散的，
// 所以 -log-file 支持逗号分隔的多个文件。
func (r *runner) scanLog() {
	if r.opts.logFile == "" {
		return
	}
	var raw []byte
	for _, path := range strings.Split(r.opts.logFile, ",") {
		path = strings.TrimSpace(path)
		if path == "" {
			continue
		}
		content, err := os.ReadFile(path)
		if err != nil {
			r.check("扫描服务端日志 "+path, false, err.Error())
			return
		}
		raw = append(raw, content...)
		raw = append(raw, '\n')
	}
	patterns := []struct {
		label string
		re    *regexp.Regexp
	}{
		{"SQLSTATE", regexp.MustCompile(`SQLSTATE`)},
		{"syntax error", regexp.MustCompile(`syntax error`)},
		{"does not exist", regexp.MustCompile(`does not exist`)},
		{"operator does not exist", regexp.MustCompile(`operator does not exist`)},
		{"permission denied", regexp.MustCompile(`permission denied`)},
		{"deadlock", regexp.MustCompile(`deadlock detected`)},
	}
	hits := make([]string, 0)
	for _, pattern := range patterns {
		if n := len(pattern.re.FindAll(raw, -1)); n > 0 {
			hits = append(hits, fmt.Sprintf("%s×%d", pattern.label, n))
		}
	}
	r.check("服务端日志无数据库错误", len(hits) == 0, strings.Join(hits, ", "))
}

func truncate(s string, n int) string {
	s = strings.ReplaceAll(strings.TrimSpace(s), "\n", " ")
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
