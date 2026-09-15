<div align="center">

<img src="./docs/assets/logo.svg" alt="Kite Logo" width="128" height="128">

# Kite（内部二开版）

**所有集群，一个工作空间。**

Kite 是一个轻量、开源的 Kubernetes 工作空间，面向多集群运维、可观测性、访问控制与 AI 辅助排障。
本仓库为基于上游项目的**公司内部二开版本**，当前版本 `v1.0.0`。

[English](./README_en.md) · **中文**

</div>

## 关于本仓库

本仓库是 [kite-org/kite](https://github.com/kite-org/kite) 的定制分支（上游镜像：[gitee.com/gzwxh/kite](https://gitee.com/gzwxh/kite)），在内网 GitLab 维护，仅限公司内部使用。

- 上游项目：<https://github.com/kite-org/kite>（文档：<https://kite.zzde.me>）
- 上游镜像：<https://gitee.com/gzwxh/kite>
- 内网仓库：`ssh://git@10.10.11.151:20222/teg/support-department/operation_rd_dept/kite.git`（开发分支 `release/v1.0.0`）
- 中文文档：见 [`docsCN/`](./docsCN/index.md)
- 许可证：Apache-2.0（沿用上游）

## 二开新增与增强

- **RBAC 细粒度权限**：新增 `容器文件浏览 / 容器文件下载 / 容器文件上传` 独立权限动词，可在角色中单独勾选（与 `exec` 权限分离，既有角色不受影响）。
- **容器文件审计**：Pod 文件的查看 / 下载 / 上传全量写入审计日志（含文件路径、容器名、操作人、成功与否），可在「审计日志」按资源与操作类型检索。
- **通知模块**：SMTP 邮件 / 消息模板 / 消息订阅 / 站内信（顶栏铃铛）；支持不活跃用户自动禁用提醒、异地登录提醒、密码过期提醒，全局提示统一为右上角。
- **登录验证码**：可按策略启用图形验证码，并支持按用户/全局策略的 MFA 管理。
- **系统设置重构**：设置项重组为通用 / 集群 / 认证 / 用户与用户组 / 权限管理 / API 密钥 / 模板 / 日志审计 / 安全设置 / 通知设置，全部中文界面。
- **构建与发布**：`make build` 强制重建前后端；`make image / make push` 一键构建并推送 Docker 镜像到公司 SWR。

## 构建

```bash
make deps      # 安装前后端依赖
make build     # 构建前端(嵌入 static/) 与后端二进制 ./kite
make run       # 启动（自动加载 dev.env，默认端口 8080）
```

> `make build` 后直接 `./kite` 会因为**缺少密钥而拒绝启动**（这是刻意设计的启动强校验）。本地调试两种方式：
> - `make run` / `make dev`：自动加载仓库自带的 `dev.env`（已含 ≥32 字节的 `KITE_ENCRYPT_KEY`、`JWT_SECRET`），推荐；
> - 临时绕过：`KITE_ALLOW_INSECURE_SECRETS=true ./kite`（回退到内置默认密钥，**仅限本机**）。

受限网络下 `make build` 直接可用（前端依赖走 pnpm lockfile，后端使用 `vendor/`）。

## 本地开发

仓库自带两份**开箱即用**的本地默认配置，无需手工拼环境变量：

| 文件 | 作用 |
| --- | --- |
| `dev.env` | 本地环境变量：`PORT` / `DB_DSN` / `KITE_ENCRYPT_KEY` / `JWT_SECRET`（均为 ≥32 字节的开发用值，满足服务端启动强校验）/ `KITE_CONFIG_FILE` |
| `config.dev.yaml` | 配置文件：首次启动自动创建管理员 **admin / AdminPass!234**；集群为空时自动导入 `~/.kube/config` |

```bash
make dev    # 后端(-v=5) + Vite 前端热更新；自动加载 dev.env
make run    # 仅后端（使用内嵌前端产物）；自动加载 dev.env
```

`run` / `dev` 目标会在 `dev.env` 存在时自动 `source` 它，因此**不再需要手工导出密钥**；若想自定义（例如换端口或接入真实集群），复制一份并覆盖个别变量即可：

```bash
cp dev.env dev.env.local               # 改完用：
make dev DEV_ENV=dev.env.local
```

若不通过 make 启动：

```bash
set -a; . ./dev.env; set +a; ./kite
```

> ⚠️ `dev.env` 里的密钥是**公开的本地开发值**，任何真实环境都要换成 `openssl rand -base64 32`。
> 前端单独调试：`cd ui && pnpm dev`（代理指向 `PORT` 指定的后端）。

## Docker 部署

### 1. 构建镜像

```bash
make image     # 构建镜像（默认 tag 见 Makefile 的 IMAGE 变量）
make push      # 构建并推送到公司 SWR
# 等价于：
# docker build -t swr.cn-south-1.myhuaweicloud.com/dsy/devops/kite:v1.0.0 .
# docker push  swr.cn-south-1.myhuaweicloud.com/dsy/devops/kite:v1.0.0
```

受限网络下 `make image/push` 已内置国内镜像源参数（daocloud 基础镜像 + npmmirror + goproxy.cn），直连环境可用 `make image DOCKER_BUILD_ARGS=` 置空。

### 2. 启动容器

> ⚠️ **升级/重启前必读**
> 1. **必须先设置 `KITE_ENCRYPT_KEY`**：未设置时服务会**拒绝启动**（默认密钥加密的凭据等同于明文，这是刻意的硬校验）。
>    - 从旧版本升级：直接加 `KITE_ENCRYPT_KEY="$(openssl rand -base64 32)"` 重启即可，启动时会**自动把库内密文重加密**到新密钥（日志出现 `re-encrypted N stored secret(s)`）。
>    - 仅本地开发可用逃生开关 `KITE_ALLOW_INSECURE_SECRETS=true`（这时回退到内置默认密钥并打印告警，**绝不要用于生产**）。
> 2. **`JWT_SECRET` 若显式设置则不得短于 32 字节**，否则同样拒绝启动（未设置时会自动生成随机密钥存库，重启不失效）。
> 3. 服务启动后会在日志中打印密钥相关的告警/迁移结果，建议首次启动后检查一遍日志。

容器内工作目录为 `/app`，默认使用 SQLite（相对路径 `dev.db`，即 `/app/dev.db`）——**必须挂载卷，否则容器重建后数据全部丢失**。

仅本地验证（**不要用于生产**，缺少安全参数）：

```bash
docker run -d --name kite -p 8080:8080 \
  -v kite-data:/app/data \
  -e DB_DSN=/app/data/kite.db \
  -e KITE_ENCRYPT_KEY=dev-only-key \
  -e JWT_SECRET=dev-only-jwt-secret-0123456789abcdef \
  swr.cn-south-1.myhuaweicloud.com/dsy/devops/kite:v1.0.0
```

生产推荐启动方式（含全部安全参数，密钥用 `openssl rand -base64 32` 生成并妥善保存）：

```bash
docker run -d --name kite --restart unless-stopped \
  -p 8080:8080 \
  -v /data/kite:/app/data \
  -e DB_DSN=/app/data/kite.db \
  -e KITE_ENCRYPT_KEY="$(openssl rand -base64 32)" \
  -e JWT_SECRET="$(openssl rand -base64 32)" \
  -e HOST=https://kite.example.com \
  -e TRUSTED_PROXIES=10.0.0.0/8 \
  -e DISABLE_VERSION_CHECK=true \
  swr.cn-south-1.myhuaweicloud.com/dsy/devops/kite:v1.0.0
```

首次访问会引导创建管理员账号，之后在「系统设置」中完成其余策略配置。

### 3. 参数说明

#### 🔐 安全相关（务必按说明设置）

| 环境变量 | 必填 | 默认值 | 说明与安全影响 |
| --- | --- | --- | --- |
| `KITE_ENCRYPT_KEY` | **生产必填** | 硬编码默认值 | 数据库中所有密文（SMTP/LDAP/OAuth 密码、集群 kubeconfig、VM 密钥、AI Key）用它加解密。**使用默认值时，拿到数据库即可解出全部凭据**；未设置时启动仅打印告警。**从内置默认值切换到自定义密钥时会自动重加密**（见下方「加密密钥轮换」）；再往后若要换新密钥，必须先按原密钥启动、重新保存各处凭据后再切换 |
| `KITE_ALLOW_INSECURE_SECRETS` | 否 | `false` | **仅供本地开发**：设为 `true` 才允许使用内置默认密钥（否则缺 `KITE_ENCRYPT_KEY` 直接拒绝启动，`JWT_SECRET` 短于 32 字节同样拒绝）。生产环境**不要**设置 |
| `JWT_SECRET` | **生产必填** | 启动时随机生成 | 会话 token 签名密钥，建议 ≥32 字节随机值。不设置时会自动生成临时密钥，**重启后所有人被强制登出**；设置后长度不足 32 字节会打印告警 |
| `TRUSTED_PROXIES` | 按部署方式 | `127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16` | 只有这些直连 IP 提供的 `X-Forwarded-For` / `X-Real-IP` 会被采信。**直接影响**：登录失败锁定、IP 黑白名单、异地登录提醒、审计日志记录到的客户端 IP。**容器直连暴露（不经代理）时必须设为 `none`**，否则攻击者可伪造 `X-Forwarded-For` 绕过 IP 维度的限流与封禁；经 Nginx/SLB 时填代理网段 |
| `HOST` | 走 HTTPS 时必填 | 空 | 站点外部访问地址（如 `https://kite.example.com`）。决定登录 Cookie 是否带 `Secure` 属性——**HTTPS 部署不设置此项，会话 Cookie 可能以明文经 HTTP 传输** |
| `ANONYMOUS_USER_ENABLED` | 否 | `false` | 设为 `true` 后**未登录即可访问**（只读匿名用户），且会打印安全告警。**严禁在生产开启**，仅用于开放演示环境 |
| `CORS_ALLOWED_ORIGINS` | 否 | 空（不开 CORS） | 允许跨域访问的源，逗号分隔。**生产保持为空**；仅本地前端开发（如 `http://localhost:5173`）才需要，设置后会打印告警 |

#### ⚙️ 常用运行参数

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 服务监听端口（容器已 `EXPOSE 8080`） |
| `DB_TYPE` | `sqlite` | 可选 `sqlite` / `mysql` / `postgres`，非法值直接启动失败 |
| `DB_DSN` | `dev.db` | 数据库连接，写法见下方「数据库选择」。SQLite 建议改到挂载卷内（如 `/app/data/kite.db`） |
| `KITE_DB_MAX_OPEN_CONNS` | `100` | 最大连接数（MySQL/PostgreSQL 高并发时上调，非法值忽略并告警） |
| `KITE_DB_MAX_IDLE_CONNS` | `10` | 空闲连接数，`0` 表示不保留空闲连接 |
| `KITE_DB_CONN_MAX_LIFETIME_MINUTES` | `10` | 连接最长存活分钟数 |
| `KITE_BASE` | 空 | 子路径部署（如 `/kite`），适用于挂在反向代理子目录下 |
| `NAMESPACE` | 空 | Kite 自身（Agent / 终端 Pod）所在命名空间 |
| `DISABLE_VERSION_CHECK` | 否 | `true` 关闭版本检查（内网无外网时建议开启，减少无效请求） |
| `ENABLE_ANALYTICS` | `false` | 是否上报匿名统计，内网环境保持关闭 |
| `DISABLE_GZIP` | `false` | `true` 关闭响应压缩（排查代理兼容问题时使用） |
| `KUBECONFIG` | 空 | 外部 kubeconfig 路径（如需预置集群，一般通过界面添加即可） |
| `KITE_CONFIG_FILE` | 空 | 外部配置文件路径 |
| `NODE_TERMINAL_IMAGE` | `swr.cn-south-1.myhuaweicloud.com/dsy/busybox:latest` | 节点终端 Pod 镜像（公司 SWR） |
| `KUBECTL_TERMINAL_IMAGE` | `swr.cn-south-1.myhuaweicloud.com/dsy/kubectl:latest` | Kubectl 终端 Pod 镜像（公司 SWR） |
| `CLUSTER_AGENT_IMAGE` | `swr.cn-south-1.myhuaweicloud.com/dsy/devops/kite:latest` | 集群 Agent 镜像，与应用镜像同一仓库（公司 SWR） |
| `KITE_KUBE_API_QPS` / `KITE_KUBE_API_BURST` | 内置值 | 访问 K8s API 的限速参数，集群规模大时可上调 |
| `KITE_CACHE_SYNC_TIMEOUT` | 内置值 | 集群缓存同步超时 |
| `DISABLE_CACHE` | 否 | `true` 关闭资源缓存（调试用） |

### 4. 数据库选择

默认 SQLite 适合单实例；**多副本部署必须使用 MySQL 或 PostgreSQL**（否则各副本各写一份数据）。切换方式只是 `DB_TYPE` + `DB_DSN` 两个变量，启动时会自动建表 / 迁移（`AutoMigrate`）。

```bash
# SQLite（默认，单实例）
-e DB_TYPE=sqlite \
-e DB_DSN=/app/data/kite.db

# MySQL / MariaDB（注意 charset=utf8mb4，否则中文与 emoji 写入失败）
-e DB_TYPE=mysql \
-e DB_DSN="kite:密码@tcp(10.0.0.5:3306)/kite?charset=utf8mb4&parseTime=true&loc=Local"
# 也接受 URL 写法，驱动会自动补 parseTime=true：
# -e DB_DSN="mysql://kite:密码@tcp(10.0.0.5:3306)/kite?charset=utf8mb4"

# PostgreSQL
-e DB_TYPE=postgres \
-e DB_DSN="host=10.0.0.5 user=kite password=密码 dbname=kite port=5432 sslmode=disable"
# 或 URL 写法：
# -e DB_DSN="postgres://kite:密码@10.0.0.5:5432/kite?sslmode=disable"
```

连接池可用 `KITE_DB_MAX_OPEN_CONNS` / `KITE_DB_MAX_IDLE_CONNS` / `KITE_DB_CONN_MAX_LIFETIME_MINUTES` 调整（见上表）。

> 注意：会话的空闲/总时长限制（安全设置里配置）保存在**进程内存**中，重启后会重置；多副本部署时每个副本各自计数，建议配合 MySQL/PostgreSQL 并适当收紧 JWT/Cookie 有效期。单设备登录（安全设置 → 会话安全）同样基于该内存状态，跨副本只对新登录所在的副本生效。

### 5. 反向代理与 TLS 要点

1. **必须经 HTTPS 暴露**，并在反向代理透传 `Host`、`X-Forwarded-Proto`、`X-Forwarded-For`；
2. 同时设置 `HOST=https://你的域名`（Cookie 才会带 `Secure`）与 `TRUSTED_PROXIES=代理所在网段`；
3. 容器直接对外暴露（无代理）时设 `TRUSTED_PROXIES=none`，防止伪造客户端 IP；
4. WebSocket 需允许升级（终端、Pod 执行、日志跟随依赖它），且访问域名需与页面同源。

### 6. 加密密钥轮换（KITE_ENCRYPT_KEY）

数据库里存的是密文，密钥换错会导致集群 kubeconfig、LDAP/SMTP/OAuth 密码无法解密，因此按下面的路径操作：

| 场景 | 操作 |
|---|---|
| **从默认密钥升级（推荐路径）** | 直接给运行中的实例加上 `KITE_ENCRYPT_KEY=<新密钥>` 并重启。启动时会自动把库内所有密文重加密到新密钥，日志出现 `KITE_ENCRYPT_KEY is now configured: re-encrypted N stored secret(s)` 即完成 |
| **已有自定义密钥，要再换一次** | 不能直接换：先用**旧密钥**启动 → 在界面重新保存所有凭据（集群、LDAP、OAuth、SMTP、AI Key）→ 再换成新密钥重启 |
| **密钥配错（数据仍是旧密钥）** | 启动日志会给出 `failed to re-encrypt stored secrets … Stored secrets are unchanged and readable with the previously configured key`。**数据不会被破坏**（轮换是事务性的，失败即回滚），恢复原密钥即可 |
| **生产环境防呆** | 设置 `KITE_REQUIRE_ENCRYPT_KEY=true`：未配置 `KITE_ENCRYPT_KEY` 时直接拒绝启动，避免默认密钥的生产事故 |

> 说明：密钥轮换的内部实现是启动时比对「库内密文实际可解性」而不是只比对指纹，因此**旧版本升级上来的、没有留下指纹的库也能自动迁移**。

### 7. 启动后的安全配置（界面）

容器启动只是起点，以下策略在「系统设置」中按需配置（均无需重启）：

- **安全设置 → 认证安全**：登录验证码、全局 MFA 策略（未启用 / 所有用户 / 仅管理员）、第三方认证 MFA、动态码有效期；**登录限制**：用户/IP 失败次数与封禁时长、IP 黑白名单、单设备登录、仅允许已存在用户、登录来源限制；**密码安全**：长度与复杂度（管理员更高）、历史防重用、过期天数；**会话安全**：最大空闲时长、最大时长、关闭浏览器失效；不活跃账号自动禁用。
- **通知设置**：配置 SMTP 后启用异地登录提醒、密码过期提醒、不活跃禁用提醒（站内信默认可用）。
- **认证设置**：密码登录 / Passkey 开关（MFA 由上述全局策略统一管理）。

更多配置见 [`docsCN/`](./docsCN/index.md)。

## 与上游同步

上游持续更新，合并建议：

```bash
git remote add upstream https://github.com/kite-org/kite
git fetch upstream
git merge upstream/main   # 在内网开发分支上解决冲突后合入
```

## License

[Apache-2.0](./LICENSE)（沿用上游许可证；对上游代码的修改同样以 Apache-2.0 回馈社区，如需开源可按此协议提交）。
