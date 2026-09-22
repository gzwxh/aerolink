# 常见问题 (FAQ)

## 数据共享

鸢联 AeroLink 不收集任何数据，也不会向第三方上报使用情况。上游的匿名统计（umami）已从这个
内部分支中整体移除：没有统计开关，没有注入的脚本，服务端下发的
`Content-Security-Policy` 也不放行任何第三方来源。

鸢联 AeroLink 也不会查询上游发布：没有更新检查，没有任何指向 `api.github.com` 的请求。

## 权限问题

如果在访问资源时，遇到如下错误提示，

```txt
用户 admin 没有权限在集群 in-cluster 的命名空间 aerolink 中执行 获取 configmaps
```

表示用户 `admin` 没有权限访问 `aerolink` 命名空间中的 `configmaps` 资源。

你需要参考 [RBAC 配置指南](./config/rbac-config.md) 来配置用户的权限。

## 托管 Kubernetes 集群连接问题

如果您使用托管 Kubernetes 集群（AKS、EKS、GKE 等）并在将集群添加到鸢联 AeroLink 时遇到身份验证错误，这通常是因为默认的 kubeconfig 使用了需要 CLI 工具（如 `kubelogin`、`aws` 或 `gcloud`）的 `exec` 插件。

鸢联 AeroLink 作为服务端应用运行，无法执行这些客户端身份验证工具。相反，您应该使用基于 Service Account token 的身份验证。

请参考[托管 Kubernetes 集群配置指南](./config/managed-k8s-auth.md)，了解如何创建和使用 Service Account token 进行身份验证的详细说明。

## 持久化相关

鸢联 AeroLink 支持使用 SQLite、MySQL 或 PostgreSQL 作为数据库。

你可以通过环境变量 `DB_DSN` 来配置数据库连接字符串，`DB_TYPE` 来指定数据库类型（默认为 `sqlite`）。

- 如果使用 SQLite，默认情况下数据将存储在容器内，这意味着如果容器被删除，数据也会丢失。为了持久化数据，你需要将一个持久化卷挂载到 `/data` 路径，并设置环境变量 `DB_DSN=/data/db.sqlite`。（注意：`/data` 并非默认路径，你可以根据需要选择其他路径，但必须确保 `DB_DSN` 中的路径与挂载路径一致。）
- 如果使用 MySQL 或 PostgreSQL，你需要提供相应的连接字符串，例如 `DB_DSN=user:password@tcp(host:port)/dbname`。

建议通过 Helm Chart 进行安装，这样你可以更方便地配置持久化存储和数据库连接。

## SQLite 使用 hostPath 存储问题

如果您使用 SQLite 作为数据库，并在使用 `hostPath` 进行持久化存储时遇到"out of memory"错误：

```txt
panic: failed to connect database: unable to open database file: out of memory (14)
```

此问题与鸢联 AeroLink 使用的纯 Go SQLite 驱动有关（为避免 CGO 依赖）。该驱动在访问某些存储后端上的数据
库文件时存在限制。

**解决方案**：添加 SQLite 连接选项以提高与 hostPath 存储的兼容性。在 Helm values 中设置：

```yaml
db:
  sqlite:
    options: "_journal_mode=WAL&_busy_timeout=5000"
```

这些选项启用预写日志（WAL）模式并增加忙碌超时时间，可以解决大多数 hostPath 兼容性问题。

**生产环境推荐**：对于需要持久化存储的生产环境部署，建议使用 MySQL 或 PostgreSQL 代替 SQLite。这些数据库更适合容器化环境和持久化存储场景。

更多详情请参见 [Issue #204](https://github.com/kite-org/kite/issues/204)。

## 如何更改字体

鸢联 AeroLink 默认提供五种字体：系统默认、`Maple Mono`、`JetBrains Mono`，以及中文优先的宋体与楷体。

宋体与楷体随二进制分发，是 SIL OFL 1.1 字体的界面子集（来源见 `NOTICE`）：宋体派生自思源宋体 CN，楷体派生自寒蝉正楷体；两者只覆盖 GB2312 与界面文案，且只有 400 字重，粗体由浏览器合成。字体栈与生成脚本见 `ui/src/components/font-provider.tsx` 与 `scripts/build-font-subsets.sh`。

如果您想使用其他字体，则需要自己构建项目。

用 make 构建鸢联 AeroLink，并在 `./ui/src/styles/base.css` 中更改字体

```css
@font-face {
  font-family: "Maple Mono";
  font-style: normal;
  font-display: swap;
  font-weight: 400;
  src:
    url(https://cdn.jsdelivr.net/fontsource/fonts/maple-mono@latest/latin-400-normal.woff2)
      format("woff2"),
    url(https://cdn.jsdelivr.net/fontsource/fonts/maple-mono@latest/latin-400-normal.woff)
      format("woff");
}

body {
  font-family: "Maple Mono", var(--font-sans);
}
```

## 我如何为鸢联 AeroLink 做出贡献？

我们欢迎贡献！您可以：

- 在 [GitHub Issues](https://github.com/kite-org/kite/issues) 上报告错误和功能请求
- 提交拉取请求
- 改进文档
- 分享反馈和使用案例

## 我在哪里可以获得帮助？

您可以通过以下方式获得支持：

- [GitHub Issues](https://github.com/kite-org/kite/issues) 用于提交错误报告和功能请求
- [Slack Community](https://join.slack.com/t/kite-dashboard/shared_invite/zt-3amy6f23n-~QZYoricIOAYtgLs_JagEw) 用于提问和社区支持

---

**没有找到您要找的内容？** 欢迎在 GitHub 上[提交问题](https://github.com/kite-org/kite/issues/new)或开始一个[讨论](https://github.com/kite-org/kite/discussions)。
