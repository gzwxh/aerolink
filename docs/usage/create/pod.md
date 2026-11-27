# Pod：创建与修改

Pod 是最小调度单位，一个 Pod 里可以有一个或多个容器。直接建 Pod 只适合临时排查、验证镜像、跑个一次性容器；**正式服务请建 Deployment / StatefulSet / DaemonSet / Job / CronJob**，由控制器替它保活和滚动更新。

## 创建入口

左侧「工作负载 → Pods」→ 右上角「创建」；或用详情页「更多」→「克隆」。

![Pods 列表：① 命名空间筛选 ② 搜索 ③ 创建 ④ 行操作](/images/usage/pod-list-guided.png)

列表看「状态 / 就绪 / 重启次数 / 节点」列；重启次数持续增长说明容器在反复退出。

## 顶部身份字段

![Pod 创建页：① 命名空间 ② 名称 ③ 页签行 ④ 创建按钮](/images/usage/create-pod-form-guided.png)

图上编号：① 命名空间 ② 名称 ③ 页签行（Pod / 容器 / 添加容器 / 编辑 YAML）④ 创建按钮。

| 字段 | 说明 |
| --- | --- |
| 命名空间 | 默认当前命名空间 |
| 名称 | 必填，创建后不可改 |
| 描述 | 写进注解 |

没有「副本数量」——裸 Pod 就一个，不会有人替你补。

## 页签

Pod 只有三个部分：**Pod**、`container-1`(+「+ 添加容器」)、**编辑 YAML 并创建**。没有按 Kind 命名的页签——那些页签是给工作负载配控制器策略的，裸 Pod 没有这一层。

Pod 页签里的区块：

| 区块 | 配什么 |
| --- | --- |
| 标签 & 注释 | `metadata.labels` / `annotations` |
| 网络 | 网络模式（常规 / 主机网络 `hostNetwork`）、DNS 策略与 DNS 配置、hostAliases |
| 节点调度 | 三选一：任何可用节点 / 指定节点（`nodeName`）/ 匹配调度规则（`nodeSelector`） |
| Pod 调度 | `nodeSelector` 键值对，把 Pod 落到带匹配标签的节点上 |
| 资源 | 容忍（`tolerations`）与优先级（`priorityClassName`） |
| 扩缩容和升级策略 | 只有「终止宽限期(秒)」（`terminationGracePeriodSeconds`） |
| 安全性上下文 | `securityContext`（运行用户、权限、只读根文件系统等） |
| 存储 | 卷定义：emptyDir、hostPath、ConfigMap、Secret |

容器的 requests / limits 在容器页签的「资源」里配。

容器的镜像、命令、端口、环境变量、健康检查、资源、挂载在容器页签里，见[表单创建页怎么填](/usage/common-operations#表单创建页怎么填)。

## 建完之后

Pod 详情页有日志、终端、事件、描述、调试等入口，见[第 4 步：日志与容器终端](/usage/logs-terminal)。有 `exec` 权限才能进容器。

行操作里除「日志」「终端」外，只剩「修改镜像版本」、「查看 YAML」、「管理标签/注解」、「删除」。

## 修改：大部分字段改不了

![Pod 编辑页：顶部提示 Pod 属于哪个 Deployment](/images/usage/edit-pod.png)

Pod 的 `spec` 创建后几乎全不可变，Kubernetes 只允许更新镜像等少量字段。所以编辑页一打开就有一条提示，并告诉你这个 Pod 属于哪个工作负载，旁边有直达的「编辑 Deployment」链接。

| 想改什么 | 正确做法 |
| --- | --- |
| 镜像版本 | 行操作「修改镜像版本」，只提交被改的镜像 |
| 环境变量、探针、挂载、资源、端口 | 改上层 Deployment / StatefulSet / DaemonSet / Job / CronJob，让它滚出新 Pod |
| 标签、注解 | 行操作「管理标签」「管理注解」，这个可以直接改 |
| 其他字段 | 只能删了重建 |

裸 Pod（没有任何 ownerReference）没有上层可改，要改配置就删掉重建。删除是不可逆的：Pod 里的 emptyDir 数据会一起消失，本地日志也拿不到了。
