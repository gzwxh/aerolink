# 方案：Pod SSE watch 的扩容优化（P0~P4）

- 状态：**P0~P4 已实现**（实现状态见 §7.1）；评审点见 §9
- 触发（2026-09-22）：排查 `devops/oo` 的
  `GET /api/v1/pods/devops/watch?reduce=true&labelSelector=...` 时，同时提出
  「考虑到 K8s 集群压力与当前使用人数，这条 watch 能不能优化」。
- 结论：**SSE 协议与对外语义不变**；先做三件低风险改动（P0 ticker 瘦身 / P2 首字节与重连 /
  P4 指标），P1（共享上游 watch）按人数增长情况排期，P3（使用侧节流）按需。

## 0. 事实基础

### 0.1 上游一致性（先排除「二开改坏了」）

用代理拉上游 `main` 逐行对比（2026-09-22）：

| 文件 | 结论 |
| --- | --- |
| `pkg/resources/pod_handler.go` 的 `Watch()` / `writeSSE()` | 与上游**逐行一致**（仅注释中文化；`// Watch 实现基于 SSE 的 pod 列表监听：先给初始快照…` 这句是二开补的注释） |
| `ui/src/hooks/use-resource-table-data.ts` | 与上游**零差异** |
| `ui/src/lib/api/core.ts` 的 `useResourcesWatch` | 逻辑同上游，二开只加了 `reconnectTimerRef` 与 3 处 `setIsLoading` |

上游对该文件最后一次改动是 `9421790 feat(pods): support ephemeral-container and copy-to debugging (#719)`
（2026-09-04），本仓库历史里正是引用的这一版。**所以本次是「相对上游的优化」，不是修回归**，
下游排查时不要再去找「哪次改动引入的」。

### 0.2 实测数据（2026-09-22）

| 观测 | 数值 |
| --- | --- |
| 同一条 watch 在不同集群的首字节 | `dev` 0.11s、`modata-dev` 0.11s、`bigdata-center` 0.23s；`test`（腾讯云）0.59–3.18s |
| `test` 集群 watch 存活 | 10 次里 6 次在 **3.08–3.18s** 收到 `event: close` / `watch channel closed`（body 仅 55 字节），其余 4 次拿到 `added` 并可长连 |
| 普通 LIST（`/pods/devops?...&labelSelector=...`，含 metrics） | 93ms（同一路径 90ms 量级） |
| 15s ticker 推送体积 | **7.69KB/个**（未走 `reduce`）；同对象 `reduce` 后 **1.73KB** |
| 事件时间线（安静集群，无变化） | `added` → +15s `modified`+`: ping` → +30s `modified`+`: ping` |

第一条（`test` 慢/断）是集群入口问题，与 aerolink 无关，已在原排查中定位；本方案只处理
**成本随连接数与 pod 数放大**的部分。

### 0.3 缓存的边界（算成本别算错）

`K8sClient.Client` 是 controller-runtime 的缓存客户端（`pkg/kube/client.go:220`，默认
`DISABLE_CACHE != true`）。因此：

- `h.ListMetrics()`（`pkg/resources/pod_handler.go:107`）与 `h.GetResource()` 命中缓存时
  **不产生 apiserver 请求**；缓存自身每集群各有 1 条 pod watch 与 1 条 metrics watch。
  只有 `DISABLE_CACHE=true` 时它们才是真实请求。
- 真正**绕过缓存、按浏览器连接数线性增长**的只有一处：
  `cs.K8sClient.ClientSet.CoreV1().Pods(ns).Watch()`（`pkg/resources/pod_handler.go:808`）。

### 0.4 一条连接的固定成本

| 时机 | 行为 | 打到 apiserver | 吃 aerolink/浏览器 |
| --- | --- | --- | --- |
| 建连 | 原始 pods watch（绕过缓存） | **是**：apiserver 需把匹配的 Pod **完整对象**编码并流式下发一遍 | 解码 + 过滤 |
| 建连 | `ListMetrics` | 否（缓存） | 一次缓存 List |
| 每 15s | `ListMetrics` + 每 pod 一次 `GetResource` | 否（缓存） | N 次缓存 Get（含 DeepCopy） |
| 每 15s | 推 N 个**完整 Pod**（ticker 分支漏了 `reduce`） | 否 | N 次 marshal + gzip + 出网流量 |
| 每次对象变化 | 原始 watch 事件 | 是（apiserver→aerolink 传完整对象） | 裁剪后推送（这部分已有 `reduce`） |

规模估算：U 个用户 × 人均 P 个打开的详情页 × 平均 N 个 pod：

- apiserver：`U×P` 条常驻 pod watch；每次进页面 1 次全量 pod 流；
- aerolink/浏览器：`U×P×4/min×N` 次 Pod 序列化，20 用户 × 2 页 × N=20 ≈ **6400 次/分**、
  gzip 前约 **50MB/分**的 SSE 流量。

## 1. 目标与非目标

目标：

1. 每连接每 15s 的推送量与 CPU 与**变化量**成正比，而不是与 pod 数成正比（P0）；
2. 建连后首字节立即返回，重连有退避且不清空已有数据（P2）；
3. 上游 pod watch 数与「打开的页面数」解耦（P1，按人数排期）；
4. 有指标能量出真实连接数与推送量（P4）。

非目标：

- 不改 SSE 事件协议：`added` / `modified` / `deleted` / `close` / `error` 与 `reduce=true`
  的语义保持；`list` 接口的 `reduce` 行为不变；
- 不动 RBAC 逐事件过滤与跨命名空间放行口径（`pkg/middleware/rbac.go:90`、
  `rbac.CanAccessCurrent`）；
- 不引入 WebSocket / 不把详情页改成纯轮询；
- 不改前端状态管理结构。

## 2. P0｜ticker 瘦身（一期，收益最大且风险最低）

现状（`pkg/resources/pod_handler.go:826`）：

```go
case <-ticker.C:
    metricsMap, _ = h.ListMetrics(c)
    for _, metrics := range metricsMap {
        ...
        pod, err := h.GetResource(c, metrics.Namespace, metrics.Name)
        p := pod.(*corev1.Pod)
        obj := &PodWithMetrics{Pod: p, Metrics: GetPodMetrics(metricsMap, p)}
        _ = writeSSE(c, "modified", obj)
    }
```

改动：

1. **抽 `reducePod(pod *corev1.Pod, reduce bool) *PodWithMetrics`**，事件分支
   （`:858`）与 ticker 分支共用，修掉 ticker 漏 `reduce`（现状 7.69KB vs 1.73KB）。
2. **只在变化时推**：保留上一次的 `map[string]PodMetrics`（键 `ns/name`），CPU/内存数值都没变
   的 pod 不推；pod 集合变化（新增/消失）单独处理。
3. **（建议，需前端一行配合）ticker 改推轻量 `metrics` 事件**：
   `event: metrics` + `data: [{"namespace":"devops","name":"oo-xxx","cpuUsage":…,"memoryUsage":…}]`，
   Pod 本体不再由 ticker 推。前端在 `useResourcesWatch` 里加一个 `metrics` 监听 merge 到已有行。
   - 向后兼容：EventSource 会忽略没有 `addEventListener` 的命名事件，旧前端拿到也会丢弃；
   - 收益：单 pod 推送从 ~7.7KB 降到 ~100B 量级。
4. **周期可配**：`common.Getenv("POD_METRICS_INTERVAL")`（即 `AEROLINK_POD_METRICS_INTERVAL`，
   秒；默认 15，保持现行为），按约定同步 `pkg/common/common.go` 与 `charts/aerolink` 的
   values/模板。周期做成 handler 字段或可注入函数，便于测试。

代码触点：`pkg/resources/pod_handler.go`（`Watch`、新增 `reducePod`/`podMetricsChanged`）、
`ui/src/lib/api/core.ts`（仅第 3 条需要）、`pkg/common/common.go` + `charts/aerolink`（第 4 条）。

测试：`pkg/resources/pod_api_test.go` 补两条聚焦用例——① `reduce=true` 时 ticker 推送体里
不含 `status`/`managedFields` 等被裁字段；② metrics 未变化时 ticker 不推 pod（可用可注入的
短周期 + 假 watch server 实现）。

风险：ticker 由「全量兜底刷新」变成「只推变化」，若前端某处依赖 15s 定时刷新（例如 metrics 一直
不变但需要重绘），行为会有差异；第 3 条的 `metrics` 事件正是保留这部分能力的载体。

## 3. P1｜消掉「每人一条上游 watch」（二期，集群侧收益最大）

### 方案 A（已采纳并实现，见 §7.1）：复用已在跑的 informer 缓存

- `pkg/kube/client.go` 的 `K8sClient` 增加一个字段持有 `manager.Manager`（或 `cache.Cache`），
  `Stop()` 语义不变（manager 已绑在 `NewClient` 的 `ctx` 上）。
- 新增 `pkg/resources/pod_watch_hub.go`：
  - 每集群一个 hub，用 `cache.GetInformer(ctx, &corev1.Pod{})` + **全局一个**
    `AddEventHandler` 订阅事件，再在进程内按连接分发（**不要**每连接挂一个 handler，
    否则每次事件会 DeepCopy 成 `U×P` 份）；
  - 订阅流程：先本地 `List` 出快照（缓存读，0 apiserver 请求）→ 再注册订阅 → 处理重叠
    （前端按 `ns/name` upsert，重复事件无害，可接受 at-least-once）；
  - 每个订阅者按 `(namespace, labelSelector, fieldSelector)` 过滤，并保留
    `rbac.CanAccessCurrent` 逐事件过滤；
  - 交出对象前 DeepCopy（缓存里的对象是共享的）。
- 收益：上游 pod watch 从 `U×P` 降到 1；同时消掉「每次打开页面 apiserver 全量编码一遍」。
- 风险：hub 生命周期要跟集群重连/停用/kubeconfig 变更对齐（`ClusterManager.syncClusters`
  会 `delete(cm.clusters, name)` 并 `K8sClient.Stop(name)`）；拿不到缓存时要**显式**退回现有
  raw watch 路径，而不是静默降级。

### 方案 B（更局部，不碰 kube 层）

在 `pkg/resources` 里按 `(cluster, namespace, labelSelector, fieldSelector)` 复用 raw watch：
1 条上游 watch + 一份初始事件缓存 + N 个订阅者；最后订阅者退出时 `Stop()`，watch 断了要重连并
重新取快照。好处是改动面小、不依赖缓存；代价是进程里多一份 pod 视图。

取舍：若评审接受动 `pkg/kube`，选 A；若希望「一期之后先观察、二期尽量局部」，先 B 再收敛到 A。

### 3.3 缓存视角：哪些成本能靠缓存消掉，哪些消不掉

先说结论：**这里最有效的「加缓存」就是 P1 本身**。`pod_handler.go:808` 之所以贵，是因为
watch 绕过了**已经存在**的 informer 缓存（`pkg/kube/client.go:220`，默认开启）；把它接回缓存，
上游 watch 数、每次建连的全量重编码、每连接的 `ListMetrics`/`GetResource` 会一起从
O(用户) 降到 O(集群)。在这之上还能加两层进程内缓存，但都**替代不了 P0**：

| 压力点 | 缓存能治吗 | 怎么做 |
| --- | --- | --- |
| 每连接一条上游 watch（`:808`） | **能，且这是正解** | 复用 informer 缓存（§3 方案 A） |
| 每次建连 apiserver 全量重编码一遍 | **能** | 同上：新连接先吃缓存快照，上游只有 1 条 watch |
| 每 15s 每连接各算一份 `ListMetrics`（`lo.KeyBy` 全量 map）+ N 次 `GetResource` | **能** | 每集群一个 metrics worker：每周期只算一次，广播给该集群所有连接 |
| 同一 pod 被 U 个连接各 `DeepCopy` + `json.Marshal` + gzip 一次（`:857-876`） | **能** | 按 `ns/name` 缓存 reduce 后的字节：`GetPodMetrics`（`:66`）与裁剪都**不依赖用户**，内容对所有人相同；`resourceVersion` 变了才重算。内存 ≈ pod 数 × 1.73KB，天然有界（同 key 只留最新版本） |
| **每 15s 无条件推 N 个完整 Pod（7.69KB/个）** | **不能** | 浪费在「推什么」而不是「算」：只有 P0 能治。**别把字节缓存做在 P0 之前**，那时缓存的还是 7.69KB 的大对象 |
| 断流后的重连风暴（集群像 `test` 那样时每 ~6s 一条新上游 watch） | **不能** | 频率问题：P2 的 `retry:` + 退避；上游侧由 P1 化解（重连只读本地缓存，不再打 apiserver） |
| 首字节（建连到收到响应头） | **不能** | P2 的 `initSSE` |
| 浏览器每源 6 连接（线上是 HTTP/1.1） | **不能** | P3 的隐藏即断开 |
| 列表页 5s 轮询（200 人 ≈ 24 req/s） | **部分** | 已经命中后端缓存（apiserver 0 请求）；再给列表加 ETag/304 可省掉无变化时的 marshal+gzip 与出网（当前 ETag 只用在头像/图标，列表接口没有） |

**明确不做**：

- 在 nginx / 反向代理层缓存 `/watch` 或列表响应：响应按 Cookie 鉴权 + 逐用户 RBAC 过滤，
  缓存会串用户数据，违反 fail-closed；
- 引入 Redis 跨副本缓存 K8s 对象：失效语义难做对，而「每副本各持一份 informer」本来就把
  上游 watch 数压到**副本数量级**，比跨进程缓存更简单也更准；
- 想给 SSE 响应做 HTTP 缓存：`Cache-Control: no-cache, no-transform`（`:747`）已封死。

顺序建议：**P0（把推送体变小）→ P1（= 缓存主力，消掉 O(用户) 的重复计算与上游 watch）→
P3**；字节缓存只是 P1 的顺带收益，**单独做字节缓存而不做 P0/P1 收益有限**。

### 3.4 接入方式（kubeconfig vs Cluster Agent）会不会改变这些结论

不会。Cluster Agent 只反转网络方向，不改变「每个用户一条上游 watch」的逻辑：

- Agent 集群照样构造完整的 `K8sClient`（`cluster_manager.go:452` 用 `RESTConfig` → `newClientSet`），
  `rest.Config.Dial` 就是 remotedialer 拨号器（`registration.go:234`），所以 **informer 缓存依旧存在**；
  但 `pod_handler.go:808` 走的是 `ClientSet`（`client.go:225`），**依旧绕过缓存**——目标集群 apiserver
  看到的 watch 数仍等于在线人数，只是这些 watch 现在跑在隧道里。
- 每 15s 全量推送、逐连接 marshal/gzip、列表轮询、浏览器每源 6 连接，都发生在 AeroLink 进程或浏览器里，
  与接入方式无关。

Agent 反而多出三处代价：

| 代价 | 依据 |
| --- | --- |
| 隧道一断，该集群 K8sClient 被直接停掉（informer 缓存全丢），重连后重建并**全量 LIST** 一遍 | `cluster_manager.go:319-334`、`run.go:112`（5s 重连）、`:499`（onChange = `TriggerClusterSync`） |
| 隧道断开会同时中止该集群所有日志 / Watch / 终端连接，重连风暴集中打到同一个 agent | `docs/guide/aerolink-cluster-agent.md:153` |
| 必须单副本运行（Session 与注册信息都在进程内存，无跨副本路由），200 人时无法靠加副本摊薄 | `docs/guide/aerolink-cluster-agent.md:152`、`manager.go:53` |

一个澄清：SA Token 轮换**不会**触发缓存重建——`sameTransportConfig`（`registration.go:151`）不比较
Authorization，Token 由 `authorizationRoundTripper` 每次请求动态取最新值（`:134`）。

选型建议：Server 能直连 apiserver 的集群用 kubeconfig 方式（可多副本、没有隧道抖动的连带失效）；
只有真正单向不可达的集群才用 Agent，并接受「这一个集群把整个 Server 钉在单副本」。**P0/P1 在两种
方式下都同样必要、也同样有效**——指望换接入方式来治这些现象是不成立的。

## 4. P2｜首字节与重连（一期）

1. **拆出 `initSSE(c)`**：设好 `text/event-stream` 等头 → `c.Writer.WriteHeaderNow()` →
   写并 flush 一条 `: connected` 注释 → 下发 `retry: 5000`。在启动上游 watch **之前**调用。
   - 现状：`writeSSE`（`pkg/resources/pod_handler.go:745`）只在写第一个事件时才设置并 flush
     头，因此上游无事件时（最长 15s）客户端连响应头都收不到，DevTools 一直 pending。
   - 失败分支（`failed to start watch`）仍按现在写 `event: error`。
2. **心跳与 ticker 解耦**：单独一个定时器只发 `: ping`，不再依赖 metrics 那一路。
3. **前端**：`connect()` 不再 `setData(undefined)`（重连时保留旧数据，避免列表闪空/一直转圈）；
   重连走带退避的定时器（现有 `refetch` 已是 100ms 定时器，改成指数退避 + 上限）。
4. **入口层核对项**：仓库里的 `deploy/nginx-aerolink.conf` 已经配好 SSE/WS 需要的那几条
   （`proxy_http_version 1.1`、`proxy_read_timeout 3600s`、`proxy_buffering off`，见该文件
   第 36/45/48 行），本项只需**核对线上入口用的是不是同一份配置**；后端 `http.Server` 的
   `WriteTimeout/IdleTimeout` 不掐长连接。

代码触点：`pkg/resources/pod_handler.go`、`ui/src/lib/api/core.ts`、`deploy/nginx-aerolink.conf`（核对）。

## 5. P3｜使用侧节流（已实现，见 §7.1）

1. **隐藏即断开**：`useResourcesWatch` 增加 `pauseWhenHidden`（默认开启）：`document.hidden`
   时 `disconnect()`，可见时立即重连。这是「使用人数上来」时最划算的一条——用户开着页面不看
   也占连接。
2. **并发上限**：服务端按 (用户, 集群) 统计活跃 SSE 连接，超限返回 429；前端收到 429 降级为
   `refreshInterval` 轮询。上限用 `AEROLINK_MAX_WATCH_PER_USER`（默认给 8，先给宽松值）。
3. 保持列表页 SSE **默认关闭**的现状（`ui/src/hooks/use-resource-table-state.ts:111`
   `useState(false)`），详情页才默认开。

## 6. P4｜指标与验收（一期）

在 `pkg/middleware/metrics.go` 已有的注册表里追加：

| 指标 | 类型 | 用途 |
| --- | --- | --- |
| `aerolink_watch_connections{cluster,resource}` | Gauge | 真实并发连接数 |
| `aerolink_watch_events_pushed_total{cluster,resource,type}` | Counter | 推送量（P0 前后对比） |
| `aerolink_watch_push_bytes_total{cluster,resource}` | Counter | 出网体积 |
| `aerolink_watch_upstream_watches{cluster}` | Gauge | P1 后应恒为 1 |
| `aerolink_watch_rejected_total{cluster}` | Counter | 被 (用户, 集群) 并发上限拒绝的连接数（P3 后追加，有值即有人在被限流） |

验收方式：

- P0：同一条 watch，在 pod 无变化的窗口内 15s 推送体积降为 0（或仅 `metrics` 事件）；
  给出可复现的量法（`curl -N` + 按行时间戳，参考本次排查用的脚本）。
- P2：建连后立即收到 `: connected`（TTFB ≈ 连接 RTT），后台切回前台不出现列表清空。
- P1（若做）：20 个并发 watch 时，`aerolink_watch_upstream_watches` 仍为 1。
- 回归：`go test ./pkg/resources`、`pnpm --dir ui exec tsc --noEmit -p tsconfig.app.json`。

## 7. 分期与工作量

| 阶段 | 内容 | 预估 | 风险 |
| --- | --- | --- | --- |
| 一期 | P0 + P2 + P4 | 1–1.5 天 | 低（协议不变；P0 第 3 条需前端小改） |
| 二期 | P1（A 或 B） | 1–2 天 | 中（碰 kube 层 / hub 生命周期与集群重连） |
| 三期 | P3 | 0.5 天 | 低 |

### 7.1 实现状态（2026-09-22）

**一期（P0 + P2 + P4）已实现**：

| 项 | 落地 | 回归测试 |
| --- | --- | --- |
| P0 周期推送瘦身 | `pkg/resources/pod_handler.go`：ticker 不再推 Pod 本体，改为只推**变化**的用量（`event: metrics`，单条约 100B）。周期由 `AEROLINK_POD_METRICS_INTERVAL`（秒，默认 15）控制，charts 增加 `podMetricsInterval` | `TestPodWatchTickerPushesChangedMetricsOnly` |
| P0 reduce 抽取 | 同文件 `reducePod()`：事件分支与其它推送路径共用同一份裁剪口径。口径**未变**，仍保留 `status`（前端详情页要显示状态与重启次数） | `TestPodWatchReduceStripsHeavyFields` |
| P0 前端 merge | `ui/src/lib/api/core.ts` 的 `useResourcesWatch` 新增 `metrics` 事件 merge（实际约 30 行，不是原文预估的「一行」） | `tsc --noEmit` |
| P2 首字节 | 同文件 `initSSE()`：上游 watch 建立**之前**写出响应头、`: connected`、`retry: 5000` | `TestInitSSEWritesHeadersImmediately` |
| P2 心跳解耦 | `podWatchPingInterval`（15s）独立定时器，不再跟着 metrics 周期变慢 | 同上 |
| P2 前端重连 | `useResourcesWatch`：重连不再清空列表（`hasDataRef`），`refetch` 指数退避 1s→30s（连接成功后清零） | `tsc --noEmit` |
| P4 指标 | `pkg/middleware/metrics.go` 追加 `aerolink_watch_connections`、`aerolink_watch_events_pushed_total`、`aerolink_watch_push_bytes_total`、`aerolink_watch_upstream_watches`；埋点在连接、事件推送、上游 watch 三处 | `go test ./pkg/resources ./pkg/middleware` |

两个核对项（无需改代码）：

- `main.go` 只设了 `ReadHeaderTimeout` 与 `IdleTimeout`，**没有** `WriteTimeout`，不会掐长连接；
- `deploy/nginx-aerolink.conf` 已带 SSE 所需设置（`proxy_buffering off`、`proxy_read_timeout` 等）。
  **已确认（2026-09-23）：线上为直连服务器、不经 nginx 代理**，因此不存在中间层缓冲首字节的顾虑。

**P1 已实现（方案 A：复用 informer 缓存）**：

| 项 | 落地 | 回归测试 |
| --- | --- | --- |
| 每集群一条上游 watch | 新增 `pkg/resources/pod_watch_hub.go`：`cache.GetInformer(&corev1.Pod{})` + 全局**一个** `AddEventHandler`，进程内按订阅广播；`K8sClient` 暴露 `Cache` / `Done()` | `TestPodWatchHubSharesOneUpstreamWatch` |
| 过滤口径一致 | 订阅者按 `namespace` / `labelSelector` / `fieldSelector` 过滤，逐事件仍走原有 RBAC；`fieldSelector` 不支持的字段（如 `spec.nodeName`）在进程内逐条匹配 | `TestPodWatchHubFiltersEvents` |
| 背压 | 订阅者缓冲 64，满则断开（前端重连后重新拿快照），绝不阻塞 informer 事件协程 | `TestPodWatchHubDropsSlowSubscriber` |
| 建连快照 | `sendPodWatchSnapshot()` 读缓存补 ADDED（不产生 apiserver 请求），每条仍走相同鉴权与裁剪 | 由 `TestPodWatchHub*` 与既有 watch 用例覆盖 |
| 共享用量读取 | `hub.podMetricsMap()`：每集群每命名空间每周期只读一次，本集群所有连接复用；`watchMetricsMap()` 在「有 hub 且无 labelSelector」时走共享，否则退回每连接读取 | `TestPodWatchHubSharesPodMetricsPerInterval` |
| 生命周期 | hub 以客户端指针为键，集群重建即换新 hub；`K8sClient.Done()` 停止时注销 handler 并让 `aerolink_watch_upstream_watches` 回落 | `TestPodWatchHubSharesOneUpstreamWatch` |
| fail-closed 回退 | 缓存不可用（`DISABLE_CACHE=true` / 客户端已停用 / `GetInformer` 失败）时显式退回 `directPodWatch()`（每连接直连 watch），不静默不推 | `go test ./pkg/resources -race` |

**P3 已实现（使用侧节流）**：

| 项 | 落地 | 回归测试 |
| --- | --- | --- |
| 隐藏即断开 | `useResourcesWatch` 新增 `pauseWhenHidden`（默认开启）：`document.hidden` → `stopAll()`（断开 SSE + 停掉重连定时器与降级轮询），可见时立即 `connect()` 重新取快照；挂载时已不可见则不建连接 | `core.test.ts`「页面不可见时断开连接，可见时重连」「pauseWhenHidden 为 false 时不断开连接」 |
| 并发上限 | 新增 `pkg/resources/watch_limiter.go`：按 (用户, 集群) 计数，上限取 `common.MaxWatchPerUser`（`AEROLINK_MAX_WATCH_PER_USER`，默认 8，`<=0` 不限制）；在解析参数后、建上游 watch / 读用量之前拒绝。计数是**每副本**的 | `watch_limiter_test.go`（计数口径 + 幂等释放）与 `TestPodWatchRejectsOverLimitConnections` |
| 超限响应 | `429` + `Retry-After: 30` + `{"error","code":"watch_limit_exceeded"}`；同时 `aerolink_watch_rejected_total{cluster}` 计数（有值说明有人在被限流） | 同上（断言状态码、`Retry-After`、`code`） |
| 前端降级 | EventSource 读不到状态码，但**服务端明确拒绝时 `readyState` 会是 `CLOSED`**（浏览器不再自动重连），网络抖动是 `CONNECTING`。据此判定：`CLOSED` → 立即取一次列表并按 `fallbackPollInterval`（列表页传 `refreshInterval`，默认 5s）轮询，同时每 30s 探测一次 SSE；抢回来（`onopen`）即停止轮询 | `core.test.ts`「服务端拒绝连接时降级为轮询」「网络抖动不降级为轮询」「降级期间定期探测，连接恢复后停止轮询」 |
| 列表页默认关闭 | 保持现状（`use-resource-table-state.ts` 的 `useState(false)`），详情页才默认开 | — |

与原文的两点差异：①「前端收到 429 降级为轮询」在 EventSource 上无法直接读状态码，改以 `readyState === CLOSED` 判定（见上表第 4 行）；②上限值按时序「先给宽松值」定为 8，若线上出现限流告警，优先调大 `maxWatchPerUser`。

### 7.2 实测验收（2026-09-23，本机服务 + 本地集群）

**环境**：本机 `./aerolink`（`:8080`，取自 `dev.env`）连本地集群 `devops-wxh`（v1.32.13，kubeconfig 直连），
Postgres 用容器 `aerolink-postgres12`。验收用一个临时账号（`p3-acceptance`，超管 RBAC 的副本）跑一个
临时脚本（`/tmp` 下，子命令 `stream` 量推送体积与首字节、`hold` 量并发与上游连接数、`metrics` 读
`aerolink_watch_*`）。**脚本与临时账号都不入库，验收后已删除**（复现时按量法重写即可）。

| 项 | 量法 | 实测 |
| --- | --- | --- |
| P2 首字节 | 建连到收到响应头 | TTFB **0.001s**；HTTP 200 + `Content-Type: text/event-stream`；8 条并发时建连也都是 0.001–0.003s |
| P0 推送体积 | 单条流跑 45s，按 15s 窗口统计字节 | 总计 19518B：窗口 0–15s **19288B**（首帧快照，一次性），15–30s **215B**、30–45s **8B**、45–60s **7B**（后两窗基本只有 `: ping`）；事件 4×`: ping` / 4×`added` / 5×`data` / 1×`metrics` |
| P1 上游复用 | 20 条并发 watch 时的 `aerolink_watch_upstream_watches` | 恒为 **1**；同期在 apiserver 侧数 `pods` 的 WATCH 请求：32175 → 32175 → 32176（**只 +1**，即 hub 那一条） |
| P3 上限 | 默认限额（8）下并发 12 条 | **8×200 + 4×429**，429 带 `code=watch_limit_exceeded` 与 `Retry-After: 30`；`aerolink_watch_rejected_total=4` |
| P3 可配 | `AEROLINK_MAX_WATCH_PER_USER=32` 下并发 20 条 | 20×200，无 429 |
| P3 隔离 | user1 占满 `devops-wxh` 后再用 user2 连接 | user2 连 `devops-wxh` 与 `dev` **均 200** → 计数确为按 **(用户, 集群)**，不互相挤占 |
| 长连接稳定性 | 8 条并发 watch 连 40s，每 2s 采一次 `aerolink_watch_connections` | 全程恒为 **8**；服务端 8 条请求的 `latency_ms=39986`（一起随客户端 40s 到期而结束） |

一条**排查记录**（免得后来人重踩）：过程中一度观察到「8 条并发连接在 ~9.7s 被中途关闭」，
初始怀疑是集群周期同步 / 会话失效。定位后确认是**验收脚本自己的产物**：`hold` 子命令在
结果收集完后对 8 个仍处于长连接中的线程做 `for t in threads: t.join(timeout=1)`，串行等待约 8s，
再加 `sleep(1.5)`，合计 ≈9.7s 时脚本进程退出、套接字随之关闭。取证方式：

- 稳定态探针（40s）：`latency_ms=39986`，连接不断；
- 对照实验：用 `timeout 6` 掐断同一脚本 → 服务端 8 条请求 `latency_ms=5862±1`，
  即连接离开时刻**完全由客户端决定**。

服务端没有 `WriteTimeout`（`main.go:71` 只设 `ReadHeaderTimeout` / `IdleTimeout`），
所以「连接寿命」这一项无需修代码；线上若出现类似的「固定秒数断流」，先查入口代理与客户端读取超时。

**本次连带补的文档**：`docs/config/env.md` 补上 `AEROLINK_POD_METRICS_INTERVAL` 的说明
（此前只登记了 `AEROLINK_MAX_WATCH_PER_USER`，而 charts 的 `podMetricsInterval` 与
`values.yaml` 注释都已就位，属于「文档漏了一条」）。

## 8. 未采纳 / 待定

- **未采纳**：把详情页 pod 列表改成轮询（丢失实时性）；用 WebSocket 替代 SSE（改动面大、收益不成比例）；把 `metrics-server` 依赖去掉（不解决本方案的目标）；nginx/反向代理层缓存与 Redis 跨副本缓存 K8s 对象（理由见 §3.3「明确不做」）。
- **已定（2026-09-23 评审）**：`AEROLINK_POD_METRICS_INTERVAL` 保持默认 15s（实测稳态一个周期只有 ~8B，没有调大的必要）；
  reduce 后的字节缓存**不做**——等出现「大批用户看同一个命名空间」的实测热点再回来做（它只是 P1 的附属项）。
- **已定**：P0 第 3 条采纳——新增 `event: metrics`，前端配合 merge，实现见 §7.1；P1 采纳方案 A（复用 informer 缓存），实现见 §7.1。

## 9. 评审问题（2026-09-23 已全部拍板，结论见 §11）

1. ~~一期范围是否只到 P0+P2+P4（我倾向于是），P1 是否现在就一起排？~~ 已定：P0+P2+P4 先上，
   P1 同批但单独提交（为什么做不到「独立可 revert」，见 §11 的回退清单）。
2. 已采纳：新增 `event: metrics`（需要前端配合 merge，但能把每 15s 的体积降一个数量级），实现见 §7.1。
3. ~~P1 若做，A（复用 informer 缓存，效果最好、要动 `pkg/kube`）还是 B（局部 raw watch 复用）？~~ 已定：A，实现见 §7.1。
4. ~~P3 的并发上限默认值（先给 8 是否合适）与超限行为（429 + 前端降级轮询）。~~ 已定：默认 8（可配 `AEROLINK_MAX_WATCH_PER_USER`，`0` 不限制），超限 429 + 前端降级轮询，实现与实测口径见 §7.1。
5. ~~缓存范围确认：是否接受「共享缓存只做在进程内」（每集群一份 informer + 一个 metrics worker，
   不进 nginx/CDN、不引 Redis）？~~ 已定：接受，只做进程内（理由见 §3.3）。
6. ~~接入方式：3 个集群里哪些必须走 Cluster Agent？~~ 已定：能直连的一律 kubeconfig；
   只有真正单向不可达的集群才用 Cluster Agent（代价见 §3.4）。

## 10. 实施时的连带事项

- 新增 `pkg/resources/pod_watch_hub.go` 这类文件后，同步 `docs/dev/feature-code-index.md`
  的「功能 → 文件」索引（AGENTS.md「文档」）。
- 新增环境变量时同步 `pkg/common/common.go` 与 `charts/aerolink`（AGENTS.md「项目约定」）；
  由 `internal/config.go` 管理的设置在界面上保持只读。
- 提交信息用中文描述 + Conventional Commits 英文前缀（例：`perf(watch): ticker 只推送变化的 Pod`）。

## 11. 评审结论（2026-09-23）

| # | 事项 | 结论 |
| --- | --- | --- |
| 1 | 共享缓存的边界 | 只做**进程内**：每集群一份 informer + 一个 metrics worker，不进 nginx/CDN、不引 Redis（理由见 §3.3） |
| 2 | 接入方式 | 能直连的一律 kubeconfig；只有真正单向不可达的集群才用 Cluster Agent |
| 3 | 一期范围 | P0+P2+P4 先上；P1 同批但单独提交（见下方回退说明） |
| 4 | P3 上限 | 先按默认 `8` 上线，盯 `aerolink_watch_rejected_total`（有值即有人在被限流），需要就调大 `maxWatchPerUser`；「每副本」口径已写进 `docs/config/env.md` |
| 5 | 指标周期默认值 | 保持 `15s` |
| 6 | reduce 字节缓存 | 不做，等出现「大批用户看同一命名空间」的实测热点再回来 |
| 7 | 线上入口 | 直连服务器、**不经 nginx**，不存在中间层缓冲首字节的问题（§7.1 核对项②已闭环） |
| 8 | 压测 | 不专门压测，以实际使用的 `aerolink_watch_*` 指标观察为准 |
| 9 | 提交拆分 | 按**后端 Go / 前端 TS / 配置与文档**三个提交 |

**已接受、不再追的验证缺口**（原文见 §7.2 的实测范围）：多副本下的 hub 与限流口径、千 pod 大集群的事件
风暴、50–100 并发压测，都不再做（结论见第 8 条）。

**P1 的「单独回退」怎么做**：`pod_watch_hub.go` 依赖 `pod_handler.go` 里 P1 新增的 `listPodMetrics`，
而 `pod_handler.go` 同时承载 P0/P2/P3 的改动——所以 P1 **不是一个能独立 `git revert` 的提交**，摘掉它要按
清单改（改完跑 `go test ./pkg/resources`）：

1. 删 `pkg/resources/pod_watch_hub.go`、`pkg/resources/pod_watch_hub_test.go`；
2. 回退 `pkg/kube/client.go` 里 `Cache` / `Done()` 的导出；
3. `pkg/resources/pod_handler.go`：`Watch` 恢复「每连接直连 `Pods(ns).Watch()`」，去掉 hub 订阅与
   `sendPodWatchSnapshot()`，`watchMetricsMap()` 退回每连接读取；`listPodMetrics` 可保留（P0 的 ticker 也要用）；
4. `pkg/middleware/metrics.go`：去掉 `aerolink_watch_upstream_watches` 的定义与埋点。
