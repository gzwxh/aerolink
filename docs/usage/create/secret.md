# Secret：创建与修改

Secret 存敏感数据：口令、token、TLS 证书、镜像仓库凭证。它的值和 ConfigMap 结构一样，区别在于用途与访问控制——**不要把密钥写进 ConfigMap**。

## 创建入口

左侧「配置 → Secrets」→ 右上角「创建」；或用详情页「更多」→「克隆」。

## 表单

![Secret 创建页](/images/usage/create-secret.png)

| 字段 | 说明 |
| --- | --- |
| 命名空间 | 默认当前命名空间 |
| 名称 | 必填，创建后不可改 |
| 描述 | 写进注解 |
| 类型 | Opaque、`kubernetes.io/tls`、`kubernetes.io/dockerconfigjson`、`kubernetes.io/basic-auth` 等，或「自定义」自己填 |
| 不可变 | 勾选后创建完就不能再改（`immutable: true`） |

页签：**数据**、**二进制数据**、**标签 & 注释**、**编辑 YAML 并创建**。

### 类型决定必须要有的键

选了带校验的类型，表单会要求对应的键，缺了存进集群也会被 apiserver 拒绝，所以页面提前拦住：

| 类型 | 必填键 |
| --- | --- |
| `kubernetes.io/tls` | `tls.crt`、`tls.key` |
| `kubernetes.io/dockerconfigjson` | `.dockerconfigjson` |
| `kubernetes.io/basic-auth` | `username`、`password` |
| `kubernetes.io/ssh-auth` | `ssh-privatekey` |
| `kubernetes.io/dockercfg` | `.dockercfg` |
| `kubernetes.io/service-account-token`、Opaque、自定义 | 无强制键 |

bootstrap token、istio、helm 这些第三方类型只给推荐键的提示，不强制。

### 数据

- 填的值是**明文**，生成清单时走 `stringData`，由 apiserver 编码成 base64 存进 `data`。
- 输入框默认隐藏内容，每行有显示/隐藏切换。
- 值支持多行，贴证书、贴 kubeconfig 都行。

### 二进制数据

这一页写进 `data`，值必须是 base64；从本地文件加载时页面会自动编码。放二进制内容（keystore、PFX）用这里。

## 在 Pod 里怎么用

- **挂成文件**：容器页签「存储」加 Secret 卷，再挂到容器路径。
- **当环境变量**：`valueFrom.secretKeyRef` 表单不建模，写在 YAML 里。
- 挂载的 Secret 是只读的；更新 Secret 后挂载文件最终会更新，环境变量形式要重启 Pod。

## 修改

| 改什么 | 怎么改 |
| --- | --- |
| 键值、标签注解 | 行操作「编辑」进表单页 |
| 类型、`immutable` | 详情页「YAML」页签 |

注意：

- 勾了「不可变」的 Secret 创建后**任何修改都会被拒绝**（连删键值都不行），只能删了重建。
- 名称锁定；类型改了要保证键还能对上，否则 apiserver 会拒绝（比如改成 `tls` 却没有 `tls.crt`/`tls.key`）。
- 改完 Secret，用到它的 Pod 不会自动重启；要让新值生效，对上层工作负载做一次「滚动重启」。

Secret 没有容器、终端和回滚，行操作里只有编辑、查看 YAML、管理标签/注解、删除。查看 YAML 时值是 base64，不要把它当加密——有读权限的人解码就能拿到明文。
