# All base images are pulled from the company registry (SWR, org "dsy"), so the
# build works on the restricted network. Override them for an ad-hoc build, e.g.
#   docker build \
#     --build-arg NODE_IMAGE=node:24-alpine \
#     --build-arg GOLANG_IMAGE=golang:1.26-alpine \
#     --build-arg RUNTIME_IMAGE=alpine:3.20 \
#     --build-arg NPM_REGISTRY=https://registry.npmjs.org \
#     --build-arg GOPROXY=https://proxy.golang.org,direct \
#     -t kite:local .
ARG NODE_IMAGE=swr.cn-south-1.myhuaweicloud.com/dsy/node:24-alpine
ARG GOLANG_IMAGE=swr.cn-south-1.myhuaweicloud.com/dsy/golang:1.26-alpine
ARG RUNTIME_IMAGE=swr.cn-south-1.myhuaweicloud.com/dsy/alpine:3.20

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

RUN go mod download

COPY . .

COPY --from=frontend-builder /app/static ./static
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w \
      -X 'github.com/zxh326/kite/pkg/version.Version=${VERSION}' \
      -X 'github.com/zxh326/kite/pkg/version.BuildDate=${BUILD_DATE}' \
      -X 'github.com/zxh326/kite/pkg/version.CommitID=${COMMIT_ID}'" -o kite .

# Runtime image (defaults to distroless; swap for a mirror when needed).
FROM ${RUNTIME_IMAGE}

WORKDIR /app

COPY --from=backend-builder /app/kite .

EXPOSE 8080

CMD ["./kite"]
