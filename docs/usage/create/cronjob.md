# CronJob：创建与修改

CronJob 按 Cron 表达式定时创建 Job：每次到点建一个 Job，Job 再拉起 Pod 跑任务。定时备份、定时清理、定时对账用它。

## 创建入口

左侧「工作负载 → CronJobs」→ 右上角「创建」；或用详情页「更多」→「克隆」。

![CronJobs 列表：① 命名空间筛选 ② 搜索 ③ 创建 ④ 行操作](/images/usage/cronjob-list-guided.png)

列表看「计划 / 状态 / 活跃任务 / 上次调度 / 上次成功」五列，一眼判断有没有按时跑。

## 顶部身份字段

![CronJob 创建页：① 命名空间 ② 名称 ③ 计划（Cron）④ 页签行 ⑤ 创建按钮](/images/usage/create-cronjob-form-guided.png)

图上编号：① 命名空间 ② 名称 ③ 计划（Cron 表达式，如 `*/5 * * * *`）④ 页签行 ⑤ 创建按钮。

| 字段 | 说明 |
| --- | --- |
| 命名空间 | 默认当前命名空间 |
| 名称 | 必填，创建后不可改 |
| 计划（Cron） | **必填**，5 段 Cron 表达式，如 `*/5 * * * *`（每 5 分钟） |
| 描述 | 写进注解 |

Cron 表达式是"分 时 日 月 周"，`*/5 * * * *` 表示每 5 分钟。写错了保存后不会立刻报错，等调度时间到了才建不出 Job——创建前先对照表达式算一遍。

## 页签

页签是 **CronJob**、**Pod**、`container-1`(+「+ 添加容器」)、**编辑 YAML 并创建**。

### 任务参数

CronJob 页签里除标签 & 注释外，有和 Job 一样的「任务参数」，作用在它生成的每个 Job 上：

| 界面上的字段 | 对应字段 | 说明 |
| --- | --- | --- |
| 失败重试次数 | `jobTemplate.spec.backoffLimit` | 单个 Job 最多重试几次 |
| 并行度 | `jobTemplate.spec.parallelism` | 单个 Job 内同时跑几个 Pod |
| 完成数 | `jobTemplate.spec.completions` | 单个 Job 需要成功几次 |

这个页签上不提供升级策略，会显示「该资源类型不支持升级策略配置。」。

### 表单没建模、但常要配的

这些只能在「编辑 YAML 并创建」或详情页「YAML」页签里写：

- `concurrencyPolicy`：上一次还没跑完，这次到点了怎么办（`Allow` / `Forbid` / `Replace`）。
- `startingDeadlineSeconds`：错过了调度时间，多久之内还补跑。
- `successfulJobsHistoryLimit` / `failedJobsHistoryLimit`：保留多少个历史 Job。
- `suspend`：是否暂停调度（界面上有按钮，见下）。

### restartPolicy 由表单固定

和 Job 一样，Pod 模板的 `restartPolicy` 固定写 `OnFailure`，表单里没有这一栏。

## 建完之后

CronJob 不会立刻产生 Pod，要等调度时间到。详情页标题栏有两个专用动作：

- **立即运行**：按当前 `jobTemplate` 立刻建一个 Job，名字形如 `<cronjob>-manual-<毫秒时间戳>`，属于该 CronJob，不影响原有调度。需要 Job 的创建权限，没权限时按钮不出现。
- **暂停** / **恢复**：暂停 / 恢复调度。暂停后不再产生新 Job，已经在跑的不受影响。

详情页里能看到这个 CronJob 派生出来的 Job 列表，点进去看日志。

## 修改

| 改什么 | 怎么改 |
| --- | --- |
| Cron 计划、任务参数、镜像、命令、环境变量 | 行操作「编辑」进表单页 |
| `concurrencyPolicy`、历史保留数、`suspend` | 详情页「YAML」页签 |
| 只换镜像 | 行操作「修改镜像版本」，写进 `jobTemplate`，对**之后**产生的 Job 生效 |

改名是不行的（名称锁定）；要换名字就克隆一份，再把旧的暂停或删掉。

注意：改了 `jobTemplate` 不会影响已经在跑的 Job，只看下一轮。
