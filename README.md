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
./kite         # 启动，默认端口 8080
```

受限网络下 `make build` 直接可用（前端依赖走 pnpm lockfile，后端使用 `vendor/`）。

## Docker 镜像

```bash
make image     # 构建镜像（默认 tag 见 Makefile 的 IMAGE 变量）
make push      # 构建并推送到公司 SWR
# 等价于：
# docker build --build-arg ... -t swr.cn-south-1.myhuaweicloud.com/dsy/devops/kite:v1.0.0 .
# docker push  swr.cn-south-1.myhuaweicloud.com/dsy/devops/kite:v1.0.0
```

受限网络下 `make image/push` 已内置国内镜像源参数（daocloud 基础镜像 + npmmirror + goproxy.cn），直连环境可用 `make image DOCKER_BUILD_ARGS=` 置空。

## 运行配置

| 环境变量 | 说明 |
| --- | --- |
| `KITE_ENCRYPT_KEY` | 数据加密密钥，**生产必须显式设置**，且需与历史数据一致 |
| `PORT` | 服务端口，默认 `8080` |
| `DB_DSN` | 数据库连接（默认 SQLite） |

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
