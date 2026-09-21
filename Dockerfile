# Base images are pulled from the company registry (SWR) so the build works on
# the restricted network. Override them for an ad-hoc build, e.g.
#   docker build \
#     --build-arg NODE_IMAGE=node:24-alpine \
#     --build-arg GOLANG_IMAGE=golang:1.26 \
#     --build-arg RUNTIME_IMAGE=alpine:3.23.2 \
#     --build-arg NPM_REGISTRY=https://registry.npmjs.org \
#     --build-arg GOPROXY=https://proxy.golang.org,direct \
#     -t kite:local .
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
ARG VERSION=dsy-v1.0.0
ARG BUILD_DATE=unknown
ARG COMMIT_ID=unknown

# Go module proxy used for the backend dependencies.
ARG GOPROXY=https://proxy.golang.org,direct
ENV GOPROXY=${GOPROXY}

COPY go.mod ./
COPY go.sum ./

# BuildKit 缓存挂载：Go 的模块缓存与编译缓存**跨构建复用**。没有它的话，每次构建都在空缓存
# 里从零编译整棵依赖树，这正是"容器里打包慢"的主因。两个 RUN 都要挂——download 与 build
# 各自读写这两份缓存。
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go mod download

COPY . .

COPY --from=frontend-builder /app/static ./static

# parquet 检索走进程内 DuckDB 引擎（默认驱动，见 pkg/audit/archive_query_duckdb_cgo.go），
# 所以运行镜像里不再需要 duckdb 可执行文件。
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=1 go build -trimpath -ldflags="-s -w \
      -X 'github.com/zxh326/kite/pkg/version.Version=${VERSION}' \
      -X 'github.com/zxh326/kite/pkg/version.BuildDate=${BUILD_DATE}' \
      -X 'github.com/zxh326/kite/pkg/version.CommitID=${COMMIT_ID}'" -o kite .

# Runtime image.
FROM ${RUNTIME_IMAGE}

WORKDIR /app

# CA 证书：openEuler / ubuntu 这类**精简基础镜像都不带** ca-certificates，缺了它所有 HTTPS
# 调用都会以 "x509: certificate signed by unknown authority" 失败（K8s API、OIDC、S3/COS、
# 模型服务…）。从构建镜像拷一份 Debian 的证书包即可，不必在运行镜像里再装包/联网。
COPY --from=backend-builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

# 时区数据：归档按 `年/月/日` 分目录、日志时间戳都依赖本地时区。openEuler 自带 tzdata，
# 但 ubuntu 等精简基座可能没有，缺了会静默退化成 UTC。从构建镜像拷一份，基座可随意替换。
COPY --from=backend-builder /usr/share/zoneinfo /usr/share/zoneinfo

# 运行用户：沿用 distroless/static(nonroot) 的 uid/gid 65532，这样换成 openEuler 后权限语义
# 完全不变——已有的数据卷属主、K8s securityContext 都不用调整。
# openEuler 基础镜像没装 shadow-utils（没有 useradd/groupadd），所以直接写 passwd/group。
RUN printf 'kite:x:65532:65532::/app:/sbin/nologin\n' >> /etc/passwd && \
    printf 'kite:x:65532:\n' >> /etc/group && \
    mkdir -p /var/log/kite/archive && \
    chown -R 65532:65532 /var/log/kite

USER 65532

COPY --from=backend-builder /app/kite .

EXPOSE 8080

CMD ["./kite"]
