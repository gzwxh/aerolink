# 方案：多副本部署要处理的共享状态（简短版）

- 状态：**已实现**（三项全部落地，含测试与反证；见 §6/§8）
- 触发：控制台要从「单节点」扩到「多节点」。员工已经反馈卡顿，扩容是为了分流。

## 0. 前置条件（必须先做）

**数据库从 SQLite 换成 MySQL / PostgreSQL。** SQLite 是单文件、单写入者，两个进程同时写
一个文件会互相锁死甚至损坏。代码本来就支持三种（`common.DBType` = `sqlite` / `mysql` /
`postgres`），只是默认值还是 sqlite。这一步不做，多副本无从谈起。

## 1. 现状盘点：谁记在单机内存里

| 状态 | 现在的位置 | 多副本下的后果 |
| --- | --- | --- |
| 会话跟踪（顶下线的序号、开始时间、最近活动） | `pkg/auth/session_policy.go` 内存 | 每台各记各的。A 机把某人顶下线，请求落到 B 机时 B 不认识这个会话就**直接放行**（代码是故意这么写的，为了不让重启把所有会话踢掉） |
| 登录失败次数 | `pkg/auth/login_attempt_limiter.go` 内存 | 上限被放大 N 倍（每台各算各的），防爆破变弱；不会误锁人 |
| 安全设置读取 | **每请求 1–2 次 `DB.First`，没有任何缓存** | 这不是「不一致」，是「每个请求都打数据库」——三条里最该先处理的 |
| 第三方登录待验证票据 | ✅ 已经在数据库里（上一轮改的） | 正常 |

## 2. 会话跟踪入库

新表 `user_sessions`，每个用户一行：

```
user_id (主键) | seq | started_at | last_seen | updated_at
```

- **登录**：UPSERT（`seq` 自增）——每次登录 1 次写。
- **每个请求**：先读进程内缓存；缓存没有或过期才 SELECT——不是每请求查库。
- **最近活动时间**：内存里照旧随时更新，**最多每 60 秒回写一次**（节流）。
- **缓存有效期 30 秒**（已选定）决定「顶下线 / 闲置超时」的生效延迟：最坏情况下，别台
  机器上最多晚 30 秒才认这次顶下线。要更紧就把 `sessionStateCacheTTL` 调到 10 秒。
- 过期行随签发/写入顺手清理（沿用票据表的做法），不新增后台任务。

## 3. 登录失败次数入库

新表 `login_attempts`：`key（主键，形如 ip:1.2.3.4 / user:alice）| failures | blocked_until | updated_at`

- 只在**登录尝试**时读写 → 频率极低，压力可忽略。
- 好处：多台共享同一个计数，「错 N 次锁定」的强度不随副本数衰减。
- 管理员手动拉黑（`manualBlock`）也一并落库，否则每台各拉各的。

## 4. 顺带把「安全设置」加缓存（建议和上面一起做）

`GetSecuritySetting()` / `GetGeneralSetting()` 现在完全没有缓存，而鉴权中间件每个请求都要读：

- `loginSourceAllowed()` → 1 次 `GetSecuritySetting()`
- `blockForMFAEnrollment()` → 1 次 `GetSecuritySetting()`（未绑定动态码的用户再加 1 次 `GetGeneralSetting()`）

改法和同文件里已有的 `sessionPolicy` 一致：**10 秒缓存 + 保存设置时清缓存**
（`ResetSessionPolicyCache` 就是这个套路，照抄即可）。

这一条**现在单节点就该做**：它是当前每请求数据库读的主要来源，也是员工「卡顿」的候选原因
之一。而且不做它，第 2、3 项搬进数据库后，总量还是「每请求查库」。

## 5. 数据库压力

前提：200 名在线用户、平均每 3 秒一次请求 ≈ 66 请求/秒。

| 做法 | 每请求 | 稳态数据库流量（200 人在线） |
| --- | --- | --- |
| **现在**（安全设置无缓存） | 1–2 次 SELECT + JSON 解析 | **66–130 次读/秒** |
| **按本方案** | 0（全部命中缓存） | 会话读 ≈ 6.7/秒、会话写 ≈ 3.3/秒、设置读 ≈ 0.1/秒；登录计数只在登录时 → 合计 **≈10 次/秒** |
| 朴素做法（每请求读写） | 1 读 + 1 写 | 66 读/秒 + **66 写/秒** → SQLite 直接撞单写入者上限；MySQL 也只是白烧 |

一句话：**「放进数据库」本身不重，重的是「每个请求都摸数据库」。** 读走缓存、写做节流之后，
稳态流量比现在（无缓存地读安全设置）还低，而且每次请求的延迟不变（缓存命中等于零往返）。

## 6. 实现落点与验证

| 落点 | 内容 |
| --- | --- |
| `pkg/model/security_setting.go`、`general_setting.go` | 10 秒读缓存（`GetXxxSetting`）+ 直读版（`LoadXxxSetting`，给「读-改-写」用）+ 模型钩子 `AfterSave/AfterDelete` 让任何写路径都清缓存 |
| `pkg/model/encryption_key.go` | 密钥迁移用裸 SQL 重写 `general_settings`，绕过了钩子，因此在那两处显式清缓存 |
| `pkg/model/user_session.go`、`pkg/auth/session_policy.go` | 会话状态表 + 30 秒缓存 + 60 秒节流回写；序号用「读 + 比较并交换」保证并发下唯一 |
| `pkg/model/login_attempt.go`、`pkg/auth/login_attempt_limiter.go` | 失败计数表（固定窗口）+ 封锁/手动拉黑都落到库里；限流器本身不再持有状态 |
| `pkg/model/model.go` | 新表加入自动建表列表（升级后首次启动自动创建） |
| 测试 | `pkg/model/setting_cache_test.go`、`user_session_test.go`、`pkg/auth/session_policy_test.go`、`login_attempt_limiter_test.go` |

### 验证与反证

- 安全设置缓存：50 次连续读取 0 次数据库查询；关掉缓存后同一条断言报
  `50 cached reads caused 50 database queries`（也就是说现在每读取一次就是一次查库）。
- 会话状态：两台「机器」（两个 tracker 实例共享同一个库）——A 登录后 B 立刻拒绝旧序号的
  令牌；把库读改成永远 NotFound（等价于只存在本机内存）后报
  `replica B must reject a token older than the session replica A recorded`。
- 回写节流：节流窗口内连续 `touch` 不写库；去掉节流后报
  `touching inside the flush window wrote to the database`。
- 序号唯一：8 个并发登录必须拿到两两不同的序号；退回「`seq = seq + 1` 再读回」后报
  `seq 2 was handed out twice`（这是开发过程中被测试抓到的真实缺陷）。
- 失败计数：A 上记一次失败，B 上第二次就触发封锁；不落库时报
  `the failure count was not shared across replicas`。固定窗口过期后计数重置为 1；
  去掉重置后报 `count after the window = 3, want 1`。

### 两处行为变化（实现固定窗口带来的取舍）

1. **失败计数从滑动窗口改为固定窗口**：原来是逐条记录失败时刻、按保留期滑动裁剪；
   现在是一行「计数 + 窗口起点」，窗口内累加、过期重置。为的是让「窗口过期就重置、
   否则加一」能写在同一条 UPDATE 里（三家 SQL 都支持 CASE），避免并发失败互相覆盖计数。
   实际影响：跨窗口边界的连续失败会比以前晚一点触发封锁（例如每 4 分钟输错 3 次，
   滑动窗口会累加、固定窗口不会）。
2. **管理员手动拉黑的 IP 现在会跨重启存活**：以前只在内存里，重启即失效（当时的注释也
   这么写）；现在对所有副本、重启后都生效，直到管理员解除或到期。要永久封锁仍然用拒绝列表。

## 7. 不做/保留现状的部分

- **MFA「最近验过码」标记**继续用签名 cookie：它本来就是无状态的，多副本天然一致，不需要入库。
- **`userCache`（30 秒 TTL）**保持不变：它是降低数据库读的关键，不是问题。
- 登录失败限流里读的**白名单/黑名单**来自安全设置，跟着第 4 项一起被缓存，不用单独处理。
