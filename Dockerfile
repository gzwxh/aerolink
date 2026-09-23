# Base images are pulled from the company registry (SWR) so the build works on
# the restricted network. Go dependencies come from the vendored vendor/ tree
# (the build downloads no modules at all); only the UI dependencies need an
# npm registry. Override the base images for an ad-hoc build, e.g.
#   docker build \
#     --build-arg NODE_IMAGE=node:24-alpine \
#     --build-arg GOLANG_IMAGE=golang:1.26 \
#     --build-arg RUNTIME_IMAGE=alpine:3.23.2 \
#     --build-arg NPM_REGISTRY=https://registry.npmjs.org \
#     -t aerolink:local .
ARG NODE_IMAGE=swr.cn-south-1.myhuaweicloud.com/gzwxh/node:24-alpine
# 构建镜像必须是 **Debian 版**的 golang（不能用 alpine 版）：parquet 检索走 DuckDB 的
# Go SDK（cgo 绑定），编译需要 gcc/g++。Debian 版官方镜像自带完整工具链（实测 gcc/g++
# 14.2），开箱可用；alpine 版只有 musl 工具链，还得 apk 联网装 build-base。
ARG GOLANG_IMAGE=swr.cn-south-1.myhuaweicloud.com/gzwxh/golang:1.26.8
# 运行基座：openEuler（glibc + libstdc++ 都是现成的，cgo 产物可直接运行）。
ARG RUNTIME_IMAGE=swr.cn-south-1.myhuaweicloud.com/gzwxh/docker.io/openeuler/openeuler:24.03-lts-sp4

FROM ${NODE_IMAGE} AS frontend-builder

WORKDIR /app/ui

# npm registry used for the UI dependencies.
ARG NPM_REGISTRY=https://registry.npmjs.org

COPY ui/package.json ui/pnpm-lock.yaml ./

# pnpm refuses to install while a dependency build script has no recorded
# decision; esbuild ships a prebuilt binary, so its script is not needed.
RUN npm config set registry "${NPM_REGISTRY}" && \
    npm install -g pnpm && \
    printf 'allowBuilds:\n  esbuild: false\n' > pnpm-workspace.yaml && \
    pnpm install --frozen-lockfile

COPY ui/ ./
RUN pnpm run build

FROM ${GOLANG_IMAGE} AS backend-builder

WORKDIR /app

# Build metadata baked into the binary (same variables as the Makefile, see
# pkg/version). Defaults keep a plain `docker build` working.
ARG VERSION=v1.0.0
ARG BUILD_DATE=unknown
ARG COMMIT_ID=unknown

# Go 依赖走仓库里的 vendor/（.dockerignore 并未排除它），所以后端构建**不会下载任何模块**：
# 原来那步 `go mod download` 是唯一会走 GOPROXY 的环节，而代理失败时会回源 github.com，
# 在受限网络里就是“构建卡在拉依赖”的根因。去掉之后镜像构建对 Go 侧完全离线。
# 代价只有一个：go.mod / go.sum 与 vendor/ 不一致时构建会直接失败（inconsistent vendoring），
# 本机跑 `make deps`（go mod tidy + go mod vendor）更新并提交 vendor/ 即可修复。
# 这是刻意留的 fail-closed：比静默回源、每次构建快慢全看代理脸色要好。
COPY . .

COPY --from=frontend-builder /app/static ./static

# parquet 检索走进程内 DuckDB 引擎（默认驱动，见 pkg/audit/archive_query_duckdb_cgo.go），
# 所以运行镜像里不再需要 duckdb 可执行文件。
RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=1 go build -mod=vendor -trimpath -ldflags="-s -w \
      -X 'github.com/zxh326/kite/pkg/version.Version=${VERSION}' \
      -X 'github.com/zxh326/kite/pkg/version.BuildDate=${BUILD_DATE}' \
      -X 'github.com/zxh326/kite/pkg/version.CommitID=${COMMIT_ID}'" -o aerolink .

# Runtime image.
FROM ${RUNTIME_IMAGE}

# 运行用户 aerolink：uid/gid 沿用 distroless/static(nonroot) 的 65532，换成 openEuler 后权限
# 语义完全不变——已有的数据卷属主与 K8s securityContext 都不用调整。
# openEuler 基础镜像没装 shadow-utils（没有 useradd/groupadd），所以直接写 passwd/group。
#
# 家目录就是工作目录（/home/aerolink），**所有可写数据都放在它下面**：二进制与配置文件、
# parquet 归档（data/archive）、klog（data/aerolink.log）、DuckDB 扩展（~/.duckdb）、
# sqlite 库文件。这样不必为 /var/log、/data 这些系统目录来回改属主。
RUN printf 'aerolink:x:65532:65532::/home/aerolink:/sbin/nologin\n' >> /etc/passwd && \
    printf 'aerolink:x:65532:\n' >> /etc/group && \
    mkdir -p /home/aerolink/data/archive && \
    chown -R 65532:65532 /home/aerolink

# 数据位置的镜像默认值（上面 RUN 已建好这些目录）：
#   AEROLINK_AUDIT_ARCHIVE_DIR 只是**启动兜底**，生效值仍以「审计设置 → 归档」里的本地目录为准；
#   AEROLINK_LOG_FILE 一旦生效，klog 就不再写 stderr（见 main.go 的 applyLogFileEnv）。
# 写进镜像后部署清单不必再重复这两项；`docker run -e` / extraEnvs 显式覆盖仍然优先。
ENV AEROLINK_AUDIT_ARCHIVE_DIR=/home/aerolink/data/archive \
    AEROLINK_LOG_FILE=/home/aerolink/data/aerolink.log

WORKDIR /home/aerolink

# CA 证书：openEuler / ubuntu 这类**精简基础镜像都不带** ca-certificates，缺了它所有 HTTPS
# 调用都会以 "x509: certificate signed by unknown authority" 失败（K8s API、OIDC、S3/COS、
# 模型服务…）。从构建镜像拷一份 Debian 的证书包即可，不必在运行镜像里再装包/联网。
COPY --from=backend-builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

# 时区数据：归档按 `年/月/日` 分目录、日志时间戳都依赖本地时区。openEuler 自带 tzdata，
# 但 ubuntu 等精简基座可能没有，缺了会静默退化成 UTC。从构建镜像拷一份，基座可随意替换。
COPY --from=backend-builder /usr/share/zoneinfo /usr/share/zoneinfo

USER aerolink

COPY --from=backend-builder --chown=65532:65532 /app/aerolink /home/aerolink/aerolink

EXPOSE 8080

CMD ["./aerolink"]
