package resources

import "sync"

// 进程退出信号：main 收到 SIGINT/SIGTERM 后先标记，再关服务器。
//
// 用途只有一个：让仍在进行的 SSE watch 流「写完收尾事件再返回」。否则 srv.Shutdown 等到
// 超时后进程直接退出，在途响应被硬切断（chunked 没有结束块），浏览器控制台报
// `net::ERR_INCOMPLETE_CHUNKED_ENCODING`——客户端照样会重连，但那条报错每次发布都出现，
// 排查「事件是不是丢了」时非常误导。
//
// 放在这里而不是 common：目前只有本包的 pod watch 需要它（全仓唯一的 SSE 长连接，
// 见 pod_handler.go 的 Watch）。将来别的包也要收尾时，再把它上移。
var (
	shutdownMu sync.Mutex
	shutdownCh = make(chan struct{})
)

// MarkShuttingDown 标记进程正在退出，幂等：重复调用不会重复关闭通道。
func MarkShuttingDown() {
	shutdownMu.Lock()
	defer shutdownMu.Unlock()
	select {
	case <-shutdownCh:
		return
	default:
		close(shutdownCh)
	}
}

// shuttingDown 返回当前的退出信号通道。watch 连接在进入循环前取一次即可。
func shuttingDown() <-chan struct{} {
	shutdownMu.Lock()
	defer shutdownMu.Unlock()
	return shutdownCh
}
