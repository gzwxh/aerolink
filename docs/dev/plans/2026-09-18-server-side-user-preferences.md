# 方案：用户偏好与收藏服务端化

- 对应总览报告中的第 **5** 项（P0 清单）
- 状态：**待评审**（本文只出方案，不含实现）
- 影响面：后端新增 1 张表 + 1 组接口；前端 8 处 localStorage 读取点改造

## 1. 为什么做

| 现状 | 问题 |
| --- | --- |
| 收藏存 `localStorage`（`ui/src/lib/favorites.ts`，key `kite-favorites`，带集群前缀） | 换浏览器/清缓存即丢失；管理员无法统一视图；同一人多设备体验不一致 |
| 表格列显隐存 `localStorage`（`ui/src/hooks/use-table-column-visibility.ts`） | 同上 |
| 外观（主题/字体/显示比例）、日志与终端偏好全在 `localStorage` | 同上 |
| **侧边栏偏好已经落库**（`users.sidebar_preference` + `POST /api/users/sidebar_preference`，并有 `general_settings.global_sidebar_preference` 全局覆盖） | 说明"偏好落库"在这个项目里已有先例与约定，只是没有铺开 |

结论：这不是引入新概念，而是**把已有的落库模式推广到其余偏好**，并顺手统一"用户级偏好"的存储与接口形态。

## 2. 非目标

- 不做跨用户共享的偏好（管理员不能读他人偏好，避免隐私与审计复杂度）
- 不做偏好版本历史/回滚（不是配置，不需要审计）
- 不改侧边栏现有实现（已落库，保持不动；只在接口层面尽量收敛风格）
- 不把偏好写进 `users` 表新增列（列会持续膨胀，见 §3）

## 3. 数据模型

新增 `pkg/model/user_preference.go`：

```go
type UserPreference struct {
    ID        uint      `json:"id" gorm:"primarykey"`
    UserID    uint      `json:"userId" gorm:"not null;uniqueIndex:idx_user_preference"`
    // 空串表示"全局偏好"，否则对应 clusters.name（与前端 cluster-scoped key 语义对齐）
    Cluster   string    `json:"cluster" gorm:"type:varchar(100);not null;default:'';uniqueIndex:idx_user_preference"`
    // 受控命名空间，见 §5 白名单
    Key       string    `json:"key" gorm:"type:varchar(100);not null;uniqueIndex:idx_user_preference"`
    // JSON 字符串；用 LongText 而不是 text：MySQL TEXT 上限 64 KiB（见 feature-code-index §4）
    Value     LongText  `json:"value" gorm:"not null"`
    CreatedAt time.Time `json:"createdAt"`
    UpdatedAt time.Time `json:"updatedAt"`
}
```

要点：

- **唯一键 `(user_id, cluster, key)`**：天然幂等 upsert，不需要额外去重逻辑；utf8mb4 下索引约 `4×(8+100+100)` 字节，远低于限制
- **不值当给 `users` 加列**：偏好按"域"增长（收藏、表格列、外观、日志、终端…），加列会让 `users` 持续膨胀且每次都要 AutoMigrate 改表；KV 形态新增一个 key 零迁移
- 表名 `user_preferences`，加进 `pkg/model/model.go` 的 `models` 列表
- 删除用户时的清理：用户表已用 `pendingDeletion` 软删语义，偏好行随用户保留（量小），如需硬清理由后续运维任务处理——**本期不做**，显式记录为已知取舍

## 4. 接口设计

新增 `pkg/users/preference_handler.go`（沿用 `pkg/users/handler.go` 里 `UpdateSidebarPreference` 的写法与错误处理风格），挂在已有的登录用户组下：

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| `GET` | `/api/users/preferences?cluster=<name>` | 批量读取当前用户偏好，返回 `{ "preferences": { "<key>": "<json string>" } }` |
| `PUT` | `/api/users/preferences/:key` | upsert 单个 key，body `{ "value": <任意 JSON>, "cluster": "<可选>" }` |
| `DELETE` | `/api/users/preferences/:key?cluster=<name>` | 重置为默认（删除该行） |

配套改动：

1. **Bootstrap 集成**：`/api/v1/bootstrap` 响应里带上 `preferences`（一次性把首屏需要的偏好发给前端，避免"先渲染默认值再闪一下"）。实现上复用同一个查询函数。
2. **权限**：只从 `c.MustGet("user")` 取当前用户，**接口不接受 `user_id` 参数**；不放入 `/api/v1/admin`，避免管理员越权读他人偏好。
3. **审计**：不写 `resource_histories`。理由：偏好是用户私有展示状态、不含安全语义、高频低价值；写入会污染审计日志并放大写路径。**如果将来允许管理员读/改他人偏好，必须同时加审计**（这条写进代码注释）。
4. **限制**（防滥用，返回 400/413）：
   - `key` 必须命中白名单前缀（§5），长度 ≤ 100
   - 单个 `value` 序列化后 ≤ 32 KB，单用户总量 ≤ 256 KB
   - `cluster` ≤ 100 字符且必须存在于 `clusters` 表或为空串（否则 400）
5. **不缓存**：偏好读取走单表主键/唯一索引查询，QPS 低，不引入缓存（与项目"无 Redis"的现状一致）。

## 5. key 白名单（前后端共用同一份约定）

| 前端现状（localStorage key） | 新 pref key | cluster 维度 |
| --- | --- | --- |
| `kite-favorites`（`getClusterScopedStorageKey` 前缀） | `favorites` | ✅ 按集群 |
| 各表格的 `storageKey`（`useTableColumnVisibility`） | `table-columns:<tableId>` | ❌ 全局 |
| `theme-key` / `color-theme-key` | `appearance:theme` | ❌ |
| `font-theme-key` | `appearance:font` | ❌ |
| `appearance-color` / `appearance-font` / `appearance-theme` | `appearance:*`（前缀聚合，保留现有语义） | ❌ |
| display-scale（`display-scale-provider.tsx`） | `ui:display-scale` | ❌ |
| `log-viewer-font-size`/`show-line-numbers`/`tail-lines`/`theme`/`word-wrap` | `log-viewer:<name>` | ❌ |
| `terminal-cursor-style` / `terminal-theme` | `terminal:<name>` | ❌ |
| `settings-hint-dismissed` | `ui:settings-hint-dismissed` | ❌ |

校验正则：`^(favorites|table-columns|appearance|ui|log-viewer|terminal)(:[a-zA-Z0-9._-]+)?$`

## 6. 前端接入

新增两个文件（放在 `ui/src/lib` 与 `ui/src/hooks`，与现有分层一致）：

- `ui/src/lib/preferences.ts`：key 常量、类型、`fetchPreferences()` / `savePreference()` / `deletePreference()`（走 `ui/src/lib/api/system.ts`）
- `ui/src/hooks/use-user-preference.ts`：
  ```ts
  const [value, setValue] = useUserPreference<Theme>('appearance:theme', {
    fallback: 'system',
    migrationLocalKey: 'theme-key', // 一次性迁移来源
  })
  ```

行为约定（这是本方案的核心，必须在实现里落实）：

1. **首屏不闪**：初始值读 `localStorage`（保留本地缓存）；`bootstrap`/`GET preferences` 返回后，若服务端值存在且不同，则覆盖并回写本地缓存。
2. **写路径**：`setValue` 立即更新本地 state 与 localStorage（乐观），同时 **500ms 防抖** 后 PUT；失败则回滚 state 并 `toast.error`（沿用 `ui/src/lib/utils.ts` 的 `translateError`）。
3. **离线/降级**：PUT 失败时本地继续可用（下一次成功写入时补交）；接口 404（旧后端）时整体退化为纯 localStorage，**不阻塞功能**。
4. **一次性迁移**：hook 首次运行且服务端无该 key、本地有值时，PUT 一次并写 `kite-prefs-migrated:<key>` 标记，避免重复上报；本地旧 key 保留只读一段时间（便于回滚），不做清理。
5. **多标签页**：监听 `storage` 事件刷新本地缓存（P1，非必须）。
6. **登录页/未登录态**：外观（主题/字体）必须在登录前就生效，而那时拿不到服务端偏好 → `localStorage` 缓存是**登录前的唯一来源**；登录拿到服务端值后再覆盖。即"服务端为准、本地为缓存与首屏"，**不是删掉 localStorage**。
7. **换账号**：外观偏好会随账号切换（现在是浏览器级、换账号不变）。这是预期行为，但属于用户可感知的变化，需要产品确认。

改造点（逐个文件）：`theme-provider.tsx`、`font-provider.tsx`、`appearance-provider.tsx`、`display-scale-provider.tsx`、`use-table-column-visibility.ts`、`lib/favorites.ts` + `hooks/use-favorites.ts`、`log-viewer-content.tsx`、`terminal-content.tsx`。

## 7. 容量与写放大

- 单用户约 10 个 key、每个 JSON 几百字节 ~ 数 KB → 约 10–20 KB/用户；1 万用户约 100–200 MB（可接受，且只读自己那几行）
- 写：每次用户交互 1 次 upsert（点收藏、拖侧边栏、切主题），**与审计写入（每次操作一条）不在一个量级**，对 MySQL 无压力
- 索引：唯一键查询走单行，无额外排序；不会影响现有审计/列表性能

## 8. 实施阶段（每阶段可独立合并）

| 阶段 | 内容 | 验证 |
| --- | --- | --- |
| 1 | 后端：模型 + 迁移 + GET/PUT/DELETE + bootstrap 集成 | `go test ./pkg/users/...`（新增 handler 测试：鉴权、越权、key 校验、大小限制、upsert 幂等）+ `go test ./pkg/model/...` |
| 2 | 前端基建：`preferences.ts` + `use-user-preference.ts` + 迁移逻辑 | 新增 hook 单测（乐观更新、失败回滚、只迁移一次、接口 404 降级） |
| 3 | 迁移三项高价值偏好：**收藏**、**表格列显隐**、**外观（主题/字体/显示比例）** | 组件/provider 测试不回归；e2e 新增"新浏览器上下文仍保留偏好"用例 |
| 4 | 其余偏好：日志查看、终端 | 同上 |
| 5 | 文档同步：`docs/dev/feature-code-index.md`（偏好落点）、`AGENTS.md`（新偏好必须走 hook，禁止直接写 localStorage） | 人工核对 |

## 9. 测试计划

- **后端**：handler 级（gin test）覆盖 401/400/413/200；模型级覆盖唯一键幂等（同 key 两次 PUT 只留一行）；bootstrap 响应包含 preferences
- **前端**：`use-user-preference` 单测为主；providers 现有测试（`appearance-provider.test.tsx`、`theme-provider.test.tsx`、`font-provider.test.tsx`）必须继续通过
- **e2e**：扩展已有 `e2e/specs/sidebar-preferences.spec.ts` 的模式，新增收藏/列显隐的跨上下文持久化用例（`browser.newContext()` 模拟换浏览器）

## 10. 风险与回滚

| 风险 | 处理 |
| --- | --- |
| 首屏闪一下默认主题（服务端值晚到） | 先本地后服务端的两段式（§6.1）；必要时在 bootstrap 里同步返回 |
| 多标签页互相覆盖 | 最后写入优先 + `storage` 事件同步（P1） |
| 旧前端 + 新后端 / 新前端 + 旧后端 | 接口 404 降级为 localStorage；新后端对未知 key 直接 400（不放行未知 key，避免当 KV 存储用） |
| 换账号后外观/布局变化（现在是浏览器级） | 属预期行为，写进发布说明；如不接受，可把 `appearance:*` 排除在服务端化之外（保持纯本地） |
| 偏好数据无限增长 | 白名单 + 单值/总量上限；不做用户自定义 key |
| 回滚 | 后端保留表不删即可；前端把 hook 的实现切回纯 localStorage（迁移标记保证不会二次覆盖） |

## 11. 验收标准

1. 换浏览器/清 localStorage 后登录，收藏、表格列、主题/字体/显示比例仍然保持
2. 首次加载无可见闪烁；断网时上述功能仍可用（降级到本地）
3. 新接口不接受 `user_id`，非本人数据无法读写（含管理员）
4. 单用户偏好总量超限时返回明确错误，前端给出可读提示
5. `pnpm test`、`tsc`、`eslint`、`go test ./pkg/...` 全绿；审计日志中没有偏好写入
