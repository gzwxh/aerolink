# 部署环境台账（发版时改库用）

本文登记本仓库所有**在跑 AeroLink 的实例**及其数据库落点，供发版时对每个实例执行
`pkg/model/` 的库结构变更（三库等价 SQL 写法见
[cross-database-compatibility.md](./cross-database-compatibility.md) 与每次发布说明的
「升级前需执行的 SQL」一节）。

口令、DSN 一律**不写进本文件**：连接信息在各环境自身（本地 `dev.env`、云上容器环境变量、
K8s Secret `aerolink-secret` 的 `POSTGRES_DSN`）。

## 1. 环境清单

| 环境 | 入口 | 形态 | 数据库 | DDL 执行方式 |
|---|---|---|---|---|
| 本地开发（本机 WSL2，IP 10.100.117.5） | `http://10.100.117.5:8080` | 裸进程 `./aerolink` + `dev.env` | SQLite：`/wxh/aerolink/dev.db` | 文件属主直接改；启动时 AutoMigrate 也能加列 |
| node1 验收（10.100.117.8，devops-wxh 节点） | `http://10.100.117.8:8080` | 裸进程 `/opt/aerolink/aerolink`（root 启动，仅 `PORT=8080`） | SQLite：`/opt/aerolink/dev.db` | root 登录 node1 直接改；启动时 AutoMigrate 也能加列 |
| 云上 Docker（134.175.219.203） | `http://134.175.219.203:8080`（容器 `aerolink`） | docker compose；数据库在外部 | MySQL 8.0.30（TXSQL）：`10.32.2.244:3306/aerolink`，账号见容器 `DB_DSN` | 应用账号 `aerolink` 有 ALTER 权限，可直接执行 |
| 开发 K8s（k8s-master01，10.10.11.99） | NodePort `27862`（命名空间 `aerolink`，Deployment `aerolink`） | K8s Deployment；另含 `aerolink-docs`（静态站，无库） | PostgreSQL 12.12：`10.10.11.111:5432/aerolink`，账号见 Secret `aerolink-secret` 的 `POSTGRES_DSN` | **表 owner 是 `postgres`，应用账号 `aerolink` 无 DDL 权限**（`must be owner of table`，SQLSTATE 42501）→ 必须用超级用户执行 |

补充：

- K8s 里 `default/aerolink-verify` 只是一个 nginx 镜像（验证用静态页），**没有后端、没有数据库**，
  发版改库时跳过。
- 以上「在跑」以 2026-11-26 核实为准；新增/下线实例时更新本表。

## 2. 每个实例的核对命令

```bash
# SQLite（本地 / node1）
sqlite3 <path>/dev.db "PRAGMA table_info(login_records);"

# MySQL（云上）
mysql -h <host> -P <port> -u <user> -p"<password>" -N -e \
  "SHOW COLUMNS FROM aerolink.login_records LIKE '<column>';"

# PostgreSQL（开发 K8s）
psql "host=<host> port=5432 user=postgres dbname=aerolink" -c \
  "SELECT column_name, data_type FROM information_schema.columns
   WHERE table_name='login_records' AND column_name='<column>';"
```

## 3. 发版改库步骤

1. 看本次发布说明的「库结构变更」清单（`pkg/model/` 有改动时必须有这一节）。
2. 对上表**每个在跑实例**的库执行对应 SQL（三库写法以发布说明为准）。
3. 用第 2 节的命令核对列已存在；实例启动日志里不应该再出现
   `库表 xxx 缺少列` 的告警（`checkSchema` 只告警不阻断）。
4. 再滚动更新镜像。

## 4. 执行记录

### 2026-11-26 登录日志 `login_records.source_ip`（登录双维度 IP）

| 环境 | 操作 | 结果 |
|---|---|---|
| 本地开发（dev.db，SQLite） | AutoMigrate 已加列；清理改名残留列 `egress_ip` | 完成，240 行保留 |
| node1（/opt/aerolink/dev.db，SQLite） | `ALTER TABLE login_records ADD COLUMN source_ip varchar(64)` | 完成，3 行保留 |
| 云上 Docker（MySQL 10.32.2.244/aerolink） | `ALTER TABLE login_records ADD COLUMN source_ip VARCHAR(64) NULL` | 完成，102 行保留 |
| 开发 K8s（PostgreSQL 10.10.11.111/aerolink） | 用 `postgres` 超级用户执行 `ALTER TABLE login_records ADD COLUMN source_ip VARCHAR(64)` | 完成，67 行保留 |

该实例跑的是旧版镜像，列已就绪，等新版本部署后开始写入 `source_ip`。