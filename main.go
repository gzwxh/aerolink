package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	_ "net/http/pprof"

	"github.com/zxh326/kite/pkg/clusteragent"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/resources"
	"github.com/zxh326/kite/pkg/version"
	"k8s.io/klog/v2"
)

// applyLogFileEnv 让 AEROLINK_LOG_FILE 环境变量也能配置 klog 落盘（等价于 -log_file flag）。
//
// 必须在 flag.Parse() 之前调用：环境变量只提供默认值，命令行里显式给出的 flag 仍然优先。
// 落文件后同时关掉 stderr 输出，避免同一份日志被写两遍（采集以文件为准）。
//
// 落盘前先确认「父目录能建、文件能开」：klog 打不开 -log_file 时会直接 fatal 退出
// （`log: exiting because of error: ... unable to create log`）。系统日志是观测手段、
// 不是审计数据，不该因为一个没挂上的卷就拒绝启动——审计那条链路才是 fail-closed 的。
// 预检失败时保持 stderr 输出并给出警告。
func applyLogFileEnv() {
	path := strings.TrimSpace(common.Getenv("LOG_FILE"))
	if path == "" {
		return
	}
	if err := ensureLogFileWritable(path); err != nil {
		log.Printf("AEROLINK_LOG_FILE %q is not writable, keeping system logs on stderr: %v", path, err)
		return
	}
	if err := flag.Set("log_file", path); err != nil {
		log.Printf("Ignoring invalid AEROLINK_LOG_FILE %q: %v", path, err)
		return
	}
	if err := flag.Set("logtostderr", "false"); err != nil {
		log.Printf("Failed to disable klog stderr output for AEROLINK_LOG_FILE: %v", err)
	}
}

// ensureLogFileWritable 建好日志文件的父目录并试开一次，确认 klog 真的写得进去。
// 试开成功会留下一个空文件（klog 随后追加写进去），失败则返回原因由调用方降级。
func ensureLogFileWritable(path string) error {
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	return file.Close()
}

func main() {
	klog.InitFlags(nil)
	applyLogFileEnv()
	if len(os.Args) > 1 && os.Args[1] == "cluster-agent" {
		ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
		err := clusteragent.Run(ctx, os.Args[2:])
		stop()
		if err != nil {
			log.Fatalf("Failed to run cluster agent: %v", err)
		}
		return
	}
	flag.Parse()
	// pprof 会暴露堆转储（其中可能含明文密钥）与
	// goroutine 栈，因此它是可选开启的：AEROLINK_ENABLE_PPROF=true。
	if strings.EqualFold(strings.TrimSpace(common.Getenv("ENABLE_PPROF")), "true") {
		klog.Warningf("pprof is enabled on localhost:6060 (AEROLINK_ENABLE_PPROF=true)")
		go func() {
			log.Println(http.ListenAndServe("localhost:6060", nil))
		}()
	}

	appCtx, cancelApp := context.WithCancel(context.Background())

	cm, err := initializeApp(appCtx)
	if err != nil {
		cancelApp()
		log.Fatalf("Failed to initialize app: %v", err)
	}
	defer cancelApp()

	srv := &http.Server{
		Addr:              ":" + common.Port,
		Handler:           buildEngine(cm).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			klog.Fatalf("Failed to start server: %v", err)
		}
	}()
	klog.Infof("AeroLink server started on port %s", common.Port)
	klog.Infof("Version: %s, Build Date: %s, Commit: %s",
		version.Version, version.BuildDate, version.CommitID)

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	klog.Info("Shutting down server...")
	// 先让在途的 SSE watch 流写完收尾事件再返回：否则 Shutdown 等到超时后进程退出，
	// 响应被硬切断，浏览器控制台冒出 net::ERR_INCOMPLETE_CHUNKED_ENCODING。
	resources.MarkShuttingDown()
	cancelApp()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		klog.Fatalf("Failed to shutdown server: %v", err)
	}
}
