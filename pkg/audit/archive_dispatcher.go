package audit

import (
	"sync"
	"sync/atomic"
)

// —— 归档链路的后台任务池 ——
//
// 解决的问题：归档的写入循环原本是「Run 协程里同步写盘，落盘后**同步上传 S3**」。上传是网络
// IO（几百 ms 到数秒），这期间该类型的 writer 完全停止消费，缓冲（4096 条）一满就开始丢记录。
// 多用户同时操作、访问日志量大的部署里，这是最先撞到的墙。
//
// 拆成两个独立的池之后：
//
//	Run 协程：只攒批 → 投递「写盘任务」
//	              写盘池（本地 IO）→ 落盘完成 → 投递「上传任务」
//	                                        上传池（网络 IO）→ S3 上传 / ES bulk
//
// 两级**不共享 worker**，所以网络再慢也不会反压到磁盘写入；写入循环基本只做内存搬运。
//
// 两个池都是「有界队列 + 固定 worker」。队列满时**不丢弃任务**，而是由调用方同步执行
// （见 Submit）：审计记录宁可慢一点，也不能悄悄少一条。
type archiveDispatcher struct {
	name  string
	tasks chan func()
	stop  chan struct{}
	wg    sync.WaitGroup
	once  sync.Once

	// syncFallback 记录「队列满、改由调用方同步执行」的次数。持续增长说明下游跟不上
	// （对象存储慢、ES 慢、磁盘慢），是需要扩容或排查的信号，所以导出成指标而不是只打日志。
	syncFallback atomic.Int64
}

// newArchiveDispatcher 启动固定数量的 worker。
func newArchiveDispatcher(name string, workers, queue int) *archiveDispatcher {
	if workers < 1 {
		workers = 1
	}
	if queue < 1 {
		queue = 1
	}
	dispatcher := &archiveDispatcher{
		name:  name,
		tasks: make(chan func(), queue),
		stop:  make(chan struct{}),
	}
	for i := 0; i < workers; i++ {
		dispatcher.wg.Add(1)
		go dispatcher.work()
	}
	return dispatcher
}

func (d *archiveDispatcher) work() {
	defer d.wg.Done()
	for {
		select {
		case task := <-d.tasks:
			task()
		case <-d.stop:
			// 退出前把已入队的任务做完：它们是「已落盘文件的上传」或「已攒好的 bulk」，
			// 半途丢掉等于数据缺失。
			for {
				select {
				case task := <-d.tasks:
					task()
				default:
					return
				}
			}
		}
	}
}

// Submit 投递一个任务。永不阻塞（除非队列满，此时由调用方执行）。
func (d *archiveDispatcher) Submit(task func()) {
	if d == nil || task == nil {
		return
	}

	select {
	case <-d.stop:
		// 已经停止（进程收尾路径）：直接执行，避免把任务投进没人消费的队列后静默消失。
		task()
		return
	default:
	}

	select {
	case d.tasks <- task:
	default:
		// 队列满：调用方自己执行。这是有意的**背压**——不丢任务，让上游稍等一下。
		d.syncFallback.Add(1)
		task()
	}
}

// Stop 停止接收新任务，并等已入队的任务全部执行完。可重复调用。
func (d *archiveDispatcher) Stop() {
	if d == nil {
		return
	}
	d.once.Do(func() { close(d.stop) })
	d.wg.Wait()
}

// Stats 返回队列积压数与同步兜底次数（供指标采集）。
func (d *archiveDispatcher) Stats() (pending int, syncFallback int64) {
	if d == nil {
		return 0, 0
	}
	return len(d.tasks), d.syncFallback.Load()
}
